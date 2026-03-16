import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import OpenAI from "openai";

const PORT = Number(process.env.PORT ?? 4000);
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-change-me";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const WEB_BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";

const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY ?? "";
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET ?? "";
const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI ?? "";

const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = (process.env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true
  })
);
app.use(express.json({ limit: "2mb" }));

const uploadDir = path.resolve(process.cwd(), "uploads");
await fs.mkdir(uploadDir, { recursive: true });
app.use("/uploads", express.static(uploadDir));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 10) || ".jpg";
      const safeExt = ext.match(/^\.[a-z0-9]+$/i) ? ext : ".jpg";
      cb(null, `${crypto.randomUUID()}${safeExt.toLowerCase()}`);
    }
  }),
  limits: { fileSize: 250 * 1024 * 1024 }
});

type User = { id: string; email: string; passwordHash: string };
const usersByEmail = new Map<string, User>();

type TikTokTokens = {
  open_id: string;
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  scope: string;
  token_type: string;
  obtained_at_ms: number;
};
const tiktokTokensByUserId = new Map<string, TikTokTokens>();
const tiktokOauthStateToUserId = new Map<string, { userId: string; createdAtMs: number }>();

function signToken(userId: string) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "7d" });
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.header("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  if (!token) return res.status(401).json({ error: "missing_token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub?: string };
    (req as any).userId = payload.sub;
    if (!payload.sub) return res.status(401).json({ error: "invalid_token" });
    return next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/integrations", requireAuth, (req, res) => {
  const userId = (req as any).userId as string;
  return res.json({
    tiktokConnected: tiktokTokensByUserId.has(userId)
  });
});

app.get("/oauth/tiktok/start", (req, res) => {
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_REDIRECT_URI) {
    return res.status(500).json({ error: "server_missing_tiktok_oauth_config" });
  }
  const rawToken = String(req.query.token ?? "");
  if (!rawToken) return res.status(401).json({ error: "missing_token" });
  let userId: string | undefined;
  try {
    const payload = jwt.verify(rawToken, JWT_SECRET) as { sub?: string };
    userId = payload.sub;
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
  if (!userId) return res.status(401).json({ error: "invalid_token" });

  const state = crypto.randomBytes(16).toString("hex");
  tiktokOauthStateToUserId.set(state, { userId, createdAtMs: Date.now() });

  const scope = encodeURIComponent("user.info.basic,video.publish,video.upload");
  const redirectUri = encodeURIComponent(TIKTOK_REDIRECT_URI);

  const url =
    `https://www.tiktok.com/v2/auth/authorize/?client_key=${encodeURIComponent(TIKTOK_CLIENT_KEY)}` +
    `&response_type=code&scope=${scope}&redirect_uri=${redirectUri}&state=${encodeURIComponent(state)}` +
    `&disable_auto_auth=0`;

  return res.redirect(url);
});

app.get("/oauth/tiktok/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  const error = req.query.error ? String(req.query.error) : "";
  const errorDescription = req.query.error_description ? String(req.query.error_description) : "";

  if (error) {
    return res.redirect(
      `${WEB_BASE_URL}/?tiktok=error&reason=${encodeURIComponent(error)}&desc=${encodeURIComponent(errorDescription)}`
    );
  }

  if (!code || !state) {
    return res.redirect(`${WEB_BASE_URL}/?tiktok=error&reason=missing_code_or_state`);
  }

  const stateEntry = tiktokOauthStateToUserId.get(state);
  if (!stateEntry) return res.redirect(`${WEB_BASE_URL}/?tiktok=error&reason=invalid_state`);

  // expire state quickly
  tiktokOauthStateToUserId.delete(state);

  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET || !TIKTOK_REDIRECT_URI) {
    return res.redirect(`${WEB_BASE_URL}/?tiktok=error&reason=server_missing_tiktok_oauth_config`);
  }

  const params = new URLSearchParams();
  params.set("client_key", TIKTOK_CLIENT_KEY);
  params.set("client_secret", TIKTOK_CLIENT_SECRET);
  params.set("code", code);
  params.set("grant_type", "authorization_code");
  params.set("redirect_uri", TIKTOK_REDIRECT_URI);

  try {
    const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params
    });
    const json = (await r.json().catch(() => null)) as any;
    if (!r.ok) {
      return res.redirect(
        `${WEB_BASE_URL}/?tiktok=error&reason=token_exchange_failed&desc=${encodeURIComponent(
          json?.error_description ?? "unknown"
        )}`
      );
    }

    const token: TikTokTokens = {
      open_id: String(json.open_id),
      access_token: String(json.access_token),
      expires_in: Number(json.expires_in ?? 0),
      refresh_token: String(json.refresh_token),
      refresh_expires_in: Number(json.refresh_expires_in ?? 0),
      scope: String(json.scope ?? ""),
      token_type: String(json.token_type ?? "Bearer"),
      obtained_at_ms: Date.now()
    };

    tiktokTokensByUserId.set(stateEntry.userId, token);
    return res.redirect(`${WEB_BASE_URL}/?tiktok=connected`);
  } catch (e: any) {
    return res.redirect(`${WEB_BASE_URL}/?tiktok=error&reason=token_exchange_exception&desc=${encodeURIComponent(e?.message ?? "unknown")}`);
  }
});

app.post("/auth/register", async (req, res) => {
  const schema = z.object({ email: z.string().email(), password: z.string().min(8) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });

  const email = parsed.data.email.toLowerCase();
  if (usersByEmail.has(email)) return res.status(409).json({ error: "email_in_use" });

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const user: User = { id: crypto.randomUUID(), email, passwordHash };
  usersByEmail.set(email, user);
  return res.json({ token: signToken(user.id) });
});

app.post("/auth/login", async (req, res) => {
  const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });

  const email = parsed.data.email.toLowerCase();
  const user = usersByEmail.get(email);
  if (!user) return res.status(401).json({ error: "invalid_credentials" });
  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });
  return res.json({ token: signToken(user.id) });
});

app.post("/upload", requireAuth, upload.single("image"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "missing_image" });
  const url = `/uploads/${file.filename}`;
  return res.json({ fileId: file.filename, url });
});

const GeneratedSchema = z.object({
  title: z.string().min(1).max(120),
  caption: z.string().min(1).max(1000),
  hashtags: z.array(z.string().min(1).max(50)).max(30)
});

app.post("/ai/generate", requireAuth, upload.single("image"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "missing_image" });

  if (!OPENAI_API_KEY) return res.status(500).json({ error: "server_missing_openai_key" });

  const platform = String(req.body?.platform ?? "instagram").toLowerCase();
  const style = String(req.body?.style ?? "friendly").toLowerCase();

  const bytes = await fs.readFile(file.path);
  const b64 = bytes.toString("base64");
  const mime =
    file.mimetype && file.mimetype.startsWith("image/") ? file.mimetype : "image/jpeg";

  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  const prompt = [
    "You are a social media assistant for small businesses.",
    "Analyze the product photo and generate copy that helps sell the product.",
    "Return ONLY valid JSON matching this schema:",
    `{ "title": string, "caption": string, "hashtags": string[] }`,
    "",
    `Platform: ${platform}`,
    `Style: ${style}`,
    "",
    "Rules:",
    "- Keep the caption short and engaging (1-3 short paragraphs max).",
    "- Hashtags should be relevant and non-spammy; prefer 8-15 hashtags.",
    "- Do not include hashtags inside the caption text; only in the hashtags array.",
    "- If the product is unclear, write neutral but appealing copy without guessing brand names."
  ].join("\n");

  try {
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: `data:${mime};base64,${b64}` }
          ]
        }
      ]
    });

    const text = response.output_text?.trim() ?? "";
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "ai_invalid_json", raw: text });
    }

    const parsed = GeneratedSchema.safeParse(json);
    if (!parsed.success) {
      return res.status(502).json({ error: "ai_bad_shape", details: parsed.error.flatten(), raw: json });
    }

    return res.json({ ...parsed.data, imageUrl: `/uploads/${file.filename}` });
  } catch (e: any) {
    return res.status(500).json({ error: "ai_failed", message: e?.message ?? "unknown" });
  }
});

app.post("/publish", requireAuth, async (req, res) => {
  const schema = z.object({
    platform: z.enum(["instagram", "facebook", "tiktok"]),
    imageUrl: z.string().min(1),
    title: z.string().min(1),
    caption: z.string().min(1),
    hashtags: z.array(z.string()).default([])
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });

  // MVP: provider adapters are stubbed. Add Meta/TikTok OAuth + posting next.
  const postText = [
    parsed.data.title,
    "",
    parsed.data.caption,
    "",
    parsed.data.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")
  ]
    .join("\n")
    .trim();

  return res.json({
    ok: true,
    platform: parsed.data.platform,
    posted: false,
    reason: "MVP stub: connect platform OAuth + provider posting adapter next.",
    preview: { imageUrl: parsed.data.imageUrl, text: postText }
  });
});

async function getTikTokValidAccessToken(userId: string): Promise<string | null> {
  const t = tiktokTokensByUserId.get(userId);
  if (!t) return null;
  const expiresAt = t.obtained_at_ms + (t.expires_in - 60) * 1000;
  if (Date.now() < expiresAt) return t.access_token;

  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) return null;

  const params = new URLSearchParams();
  params.set("client_key", TIKTOK_CLIENT_KEY);
  params.set("client_secret", TIKTOK_CLIENT_SECRET);
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", t.refresh_token);

  const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params
  });
  const json = (await r.json().catch(() => null)) as any;
  if (!r.ok) return null;

  const next: TikTokTokens = {
    open_id: String(json.open_id ?? t.open_id),
    access_token: String(json.access_token),
    expires_in: Number(json.expires_in ?? 0),
    refresh_token: String(json.refresh_token ?? t.refresh_token),
    refresh_expires_in: Number(json.refresh_expires_in ?? t.refresh_expires_in),
    scope: String(json.scope ?? t.scope ?? ""),
    token_type: String(json.token_type ?? "Bearer"),
    obtained_at_ms: Date.now()
  };
  tiktokTokensByUserId.set(userId, next);
  return next.access_token;
}

async function tiktokCreatorInfo(accessToken: string) {
  const r = await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8"
    }
  });
  const json = (await r.json().catch(() => null)) as any;
  if (!r.ok || json?.error?.code !== "ok") throw new Error("tiktok_creator_info_failed");
  return json.data as {
    privacy_level_options?: string[];
    comment_disabled?: boolean;
    duet_disabled?: boolean;
    stitch_disabled?: boolean;
    max_video_post_duration_sec?: number;
  };
}

async function tiktokInitVideoDirectPost(accessToken: string, args: { caption: string; videoSize: number; chunkSize: number; totalChunks: number; privacyLevel: string }) {
  const r = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify({
      post_info: {
        title: args.caption,
        privacy_level: args.privacyLevel,
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: args.videoSize,
        chunk_size: args.chunkSize,
        total_chunk_count: args.totalChunks
      }
    })
  });
  const json = (await r.json().catch(() => null)) as any;
  if (!r.ok || json?.error?.code !== "ok") throw new Error(json?.error?.code ?? "tiktok_video_init_failed");
  return { publishId: String(json.data.publish_id), uploadUrl: String(json.data.upload_url) };
}

async function tiktokUploadInChunks(uploadUrl: string, mime: string, bytes: Buffer, chunkSize: number) {
  const total = bytes.byteLength;
  let offset = 0;
  while (offset < total) {
    const endExclusive = Math.min(offset + chunkSize, total);
    const chunk = bytes.subarray(offset, endExclusive);
    const first = offset;
    const last = endExclusive - 1;

    const r = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": mime,
        "content-length": String(chunk.byteLength),
        "content-range": `bytes ${first}-${last}/${total}`
      },
      body: chunk
    });

    if (!(r.status === 201 || r.status === 206)) {
      const txt = await r.text().catch(() => "");
      throw new Error(`tiktok_upload_failed_${r.status}:${txt.slice(0, 200)}`);
    }
    offset = endExclusive;
  }
}

app.post("/tiktok/publish", requireAuth, upload.single("media"), async (req, res) => {
  const userId = (req as any).userId as string;
  const accessToken = await getTikTokValidAccessToken(userId);
  if (!accessToken) return res.status(400).json({ error: "tiktok_not_connected" });

  const file = req.file;
  if (!file) return res.status(400).json({ error: "missing_media" });

  const caption = String(req.body?.caption ?? "").trim();
  if (!caption) return res.status(400).json({ error: "missing_caption" });

  const isVideo = file.mimetype?.startsWith("video/");
  const isImage = file.mimetype?.startsWith("image/");

  if (isImage) {
    // TikTok photo posting currently only supports PULL_FROM_URL and requires HTTPS URL ownership verification.
    return res.status(400).json({ error: "tiktok_photo_requires_public_https_url" });
  }
  if (!isVideo) return res.status(400).json({ error: "unsupported_media_type" });

  try {
    const bytes = await fs.readFile(file.path);
    const total = bytes.byteLength;

    // TikTok chunk rules: if < 5MB upload whole; else 5-64MB chunks.
    const MIN = 5 * 1024 * 1024;
    const MAX = 64 * 1024 * 1024;
    const chunkSize = total < MIN ? total : Math.min(10 * 1024 * 1024, MAX);
    const totalChunks = Math.max(1, Math.ceil(total / chunkSize));

    const creator = await tiktokCreatorInfo(accessToken);
    const privacyLevel = (creator.privacy_level_options ?? [])[0] ?? "SELF_ONLY";

    const init = await tiktokInitVideoDirectPost(accessToken, {
      caption,
      videoSize: total,
      chunkSize,
      totalChunks,
      privacyLevel
    });

    const mime =
      file.mimetype === "video/mp4" || file.mimetype === "video/quicktime" || file.mimetype === "video/webm"
        ? file.mimetype
        : "video/mp4";

    await tiktokUploadInChunks(init.uploadUrl, mime, bytes, chunkSize);

    return res.json({
      ok: true,
      platform: "tiktok",
      posted: true,
      publishId: init.publishId
    });
  } catch (e: any) {
    return res.status(502).json({ error: "tiktok_publish_failed", message: e?.message ?? "unknown" });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${PORT}`);
});

