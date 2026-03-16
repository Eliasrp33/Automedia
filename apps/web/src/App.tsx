import React, { useMemo, useRef, useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

type Platform = "instagram" | "facebook" | "tiktok";

type Generated = {
  imageUrl: string;
  title: string;
  caption: string;
  hashtags: string[];
};

async function apiJson<T>(
  path: string,
  opts: { token?: string; method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP_${res.status}`);
  return data as T;
}

async function apiMultipart<T>(
  path: string,
  opts: { token: string; fields?: Record<string, string>; file: File }
): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);
  form.append("image", opts.file);

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.token}` },
    body: form
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP_${res.status}`);
  return data as T;
}

async function apiMultipartNamed<T>(
  path: string,
  opts: { token: string; fields?: Record<string, string>; fileFieldName: string; file: File }
): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);
  form.append(opts.fileFieldName, opts.file);
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.token}` },
    body: form
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP_${res.status}`);
  return data as T;
}

function PrimaryButton(props: { label: string; onClick: () => void; disabled?: boolean; variant?: "primary" | "secondary" }) {
  return (
    <button
      className={`btn ${props.variant === "secondary" ? "btnSecondary" : ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
      type="button"
    >
      {props.label}
    </button>
  );
}

export default function App() {
  const [email, setEmail] = useState("owner@example.com");
  const [password, setPassword] = useState("password123");
  const [token, setToken] = useState<string | null>(null);

  const [platform, setPlatform] = useState<Platform>("instagram");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [tiktokConnected, setTiktokConnected] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const hashtagText = useMemo(() => {
    if (!generated) return "";
    return generated.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  }, [generated]);

  async function refreshIntegrations(nextToken?: string | null) {
    const t = nextToken ?? token;
    if (!t) return setTiktokConnected(false);
    try {
      const out = await apiJson<{ tiktokConnected: boolean }>("/integrations", { token: t });
      setTiktokConnected(!!out.tiktokConnected);
    } catch {
      setTiktokConnected(false);
    }
  }

  async function doRegister() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const out = await apiJson<{ token: string }>("/auth/register", {
        method: "POST",
        body: { email, password }
      });
      setToken(out.token);
      setInfo("Registered + logged in.");
      await refreshIntegrations(out.token);
    } catch (e: any) {
      setError(e?.message ?? "register_failed");
    } finally {
      setBusy(false);
    }
  }

  async function doLogin() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const out = await apiJson<{ token: string }>("/auth/login", {
        method: "POST",
        body: { email, password }
      });
      setToken(out.token);
      setInfo("Logged in.");
      await refreshIntegrations(out.token);
    } catch (e: any) {
      setError(e?.message ?? "login_failed");
    } finally {
      setBusy(false);
    }
  }

  function setSelectedFile(f: File | null) {
    setFile(f);
    setGenerated(null);
    setError(null);
    setInfo(null);

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(f ? URL.createObjectURL(f) : null);
  }

  function pickFile(useCamera: boolean) {
    const input = fileInputRef.current;
    if (!input) return;
    if (useCamera) input.setAttribute("capture", "environment");
    else input.removeAttribute("capture");
    input.click();
  }

  async function generate() {
    if (!token) return setError("not_logged_in");
    if (!file) return setError("missing_image");
    if (!file.type.startsWith("image/")) return setError("ai_generation_requires_image");

    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const out = await apiMultipart<Generated>("/ai/generate", {
        token,
        file,
        fields: { platform }
      });
      setGenerated(out);
      setInfo("Generated copy. You can edit before posting.");
    } catch (e: any) {
      setError(e?.message ?? "generate_failed");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!token) return setError("not_logged_in");
    if (!generated) return setError("nothing_to_publish");

    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const out = await apiJson<{ ok: boolean; posted: boolean; reason?: string }>("/publish", {
        token,
        method: "POST",
        body: {
          platform,
          imageUrl: generated.imageUrl,
          title: generated.title,
          caption: generated.caption,
          hashtags: generated.hashtags
        }
      });
      setInfo(out.posted ? "Posted successfully." : `Not posted yet: ${out.reason ?? "stub"}`);
    } catch (e: any) {
      setError(e?.message ?? "publish_failed");
    } finally {
      setBusy(false);
    }
  }

  async function connectTikTok() {
    if (!token) return setError("not_logged_in");
    setError(null);
    setInfo(null);
    // Redirect the browser to backend which redirects to TikTok auth.
    window.location.href = `${API_BASE_URL}/oauth/tiktok/start?token=${encodeURIComponent(token)}`;
  }

  async function publishToTikTok() {
    if (!token) return setError("not_logged_in");
    if (!file) return setError("missing_media");
    if (!tiktokConnected) return setError("tiktok_not_connected");
    if (!generated) return setError("generate_or_write_caption_first");

    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const caption = [generated.title, "", generated.caption, "", hashtagText].join("\n").trim();
      const out = await apiMultipartNamed<{ ok: boolean; posted: boolean; publishId?: string; error?: string }>(
        "/tiktok/publish",
        {
          token,
          fileFieldName: "media",
          file,
          fields: { caption }
        }
      );
      setInfo(out.posted ? `Posted to TikTok (publish_id: ${out.publishId ?? "ok"}).` : "TikTok publish finished.");
    } catch (e: any) {
      setError(e?.message ?? "tiktok_publish_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <div>
        <div className="h1">Automedia</div>
        <p className="sub">Take a product photo → AI generates a post → edit → publish.</p>
      </div>

      <div className="twoCol">
        <div className="card">
          <div className="h2">1) Login</div>
          <div className="row">
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
          </div>
          <div className="row">
            <input
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password (min 8 chars)"
              type="password"
            />
          </div>
          <div className="row">
            <PrimaryButton label="Register" onClick={doRegister} disabled={busy} />
            <PrimaryButton label="Login" onClick={doLogin} disabled={busy} variant="secondary" />
          </div>
          <div className="muted">Token: {token ? "yes" : "no"}</div>
          <div className="muted">TikTok: {tiktokConnected ? "connected" : "not connected"}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <PrimaryButton label="Connect TikTok" onClick={connectTikTok} disabled={busy || !token} />
          </div>
        </div>

        <div className="card">
          <div className="h2">2) Media</div>

          <input
            ref={fileInputRef}
            style={{ display: "none" }}
            type="file"
            accept="image/*,video/*"
            onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
          />

          <div className="row">
            <PrimaryButton label="Take photo / video" onClick={() => pickFile(true)} disabled={busy} />
            <PrimaryButton label="Upload file" onClick={() => pickFile(false)} disabled={busy} variant="secondary" />
          </div>

          {previewUrl ? (
            <>
              {file?.type.startsWith("video/") ? (
                <video className="preview" src={previewUrl} controls />
              ) : (
                <img className="preview" src={previewUrl} alt="Selected product" />
              )}
              <div className="muted">Selected: {file?.type ?? "unknown"}</div>
            </>
          ) : (
            <div className="muted">No image selected yet.</div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="h2">3) Platform + Generate</div>
        <div className="chips">
          {(["instagram", "facebook", "tiktok"] as const).map((p) => (
            <button key={p} type="button" className="chip" data-active={platform === p} onClick={() => setPlatform(p)}>
              {p}
            </button>
          ))}
        </div>
        <div className="row">
          <PrimaryButton
            label="Generate title + caption + hashtags"
            onClick={generate}
            disabled={busy || !token || !file}
          />
        </div>
        <div className="muted">
          API: {API_BASE_URL}. If you hit CORS issues, set `ALLOWED_ORIGINS=http://localhost:5173` in `apps/api/.env`.
        </div>
      </div>

      <div className="card">
        <div className="h2">4) Edit + Publish</div>
        {!generated ? (
          <div className="muted">Generate first to edit.</div>
        ) : (
          <>
            <div className="label">Title</div>
            <input
              className="input"
              value={generated.title}
              onChange={(e) => setGenerated({ ...generated, title: e.target.value })}
            />

            <div className="label">Caption</div>
            <textarea
              className="textarea"
              value={generated.caption}
              onChange={(e) => setGenerated({ ...generated, caption: e.target.value })}
            />

            <div className="label">Hashtags</div>
            <textarea
              className="textarea"
              style={{ minHeight: 80 }}
              value={hashtagText}
              onChange={(e) =>
                setGenerated({
                  ...generated,
                  hashtags: e.target.value
                    .split(/\s+/)
                    .map((h) => h.trim())
                    .filter(Boolean)
                    .map((h) => h.replace(/^#/, ""))
                })
              }
            />

            <div className="row">
              <PrimaryButton label="Publish" onClick={publish} disabled={busy} />
              <PrimaryButton
                label="Publish to TikTok"
                onClick={publishToTikTok}
                disabled={busy || !tiktokConnected || !file || !generated}
                variant="secondary"
              />
            </div>
            <div className="muted">
              TikTok posting works for videos via API. Photo posting requires a public HTTPS URL (TikTok restriction).
            </div>
          </>
        )}
      </div>

      {!!error && <div className="error">Error: {error}</div>}
      {!!info && <div className="info">{info}</div>}
    </div>
  );
}

