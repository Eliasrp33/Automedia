import React, { useMemo, useState } from "react";
import { SafeAreaView, View, Text, TextInput, Pressable, StyleSheet, ScrollView, Image } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

type Platform = "instagram" | "facebook" | "tiktok";

type Generated = {
  imageUrl: string;
  title: string;
  caption: string;
  hashtags: string[];
};

async function apiJson<T>(path: string, opts: { token?: string; method?: string; body?: any } = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `HTTP_${res.status}`);
  return data as T;
}

async function apiMultipart<T>(
  path: string,
  opts: { token: string; fields?: Record<string, string>; imageUri: string }
): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);

  const filename = opts.imageUri.split("/").pop() ?? "photo.jpg";
  const ext = filename.split(".").pop()?.toLowerCase();
  const type = ext === "png" ? "image/png" : "image/jpeg";

  form.append("image", {
    // @ts-expect-error React Native FormData file
    uri: opts.imageUri,
    name: filename,
    type
  });

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
    },
    body: form
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `HTTP_${res.status}`);
  return data as T;
}

function PrimaryButton(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={props.onPress} disabled={props.disabled} style={[styles.btn, props.disabled && styles.btnDisabled]}>
      <Text style={styles.btnText}>{props.label}</Text>
    </Pressable>
  );
}

export default function App() {
  const [email, setEmail] = useState("owner@example.com");
  const [password, setPassword] = useState("password123");
  const [token, setToken] = useState<string | null>(null);

  const [platform, setPlatform] = useState<Platform>("instagram");
  const [localImageUri, setLocalImageUri] = useState<string | null>(null);
  const [generated, setGenerated] = useState<Generated | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const hashtagText = useMemo(() => (generated ? generated.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ") : ""), [generated]);

  async function doRegister() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const out = await apiJson<{ token: string }>("/auth/register", { method: "POST", body: { email, password } });
      setToken(out.token);
      setInfo("Registered + logged in.");
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
      const out = await apiJson<{ token: string }>("/auth/login", { method: "POST", body: { email, password } });
      setToken(out.token);
      setInfo("Logged in.");
    } catch (e: any) {
      setError(e?.message ?? "login_failed");
    } finally {
      setBusy(false);
    }
  }

  async function pickFromLibrary() {
    setError(null);
    setInfo(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return setError("media_library_permission_denied");

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9
    });
    if (result.canceled) return;
    setLocalImageUri(result.assets[0]?.uri ?? null);
    setGenerated(null);
  }

  async function takePhoto() {
    setError(null);
    setInfo(null);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return setError("camera_permission_denied");

    const result = await ImagePicker.launchCameraAsync({ quality: 0.9 });
    if (result.canceled) return;
    setLocalImageUri(result.assets[0]?.uri ?? null);
    setGenerated(null);
  }

  async function generate() {
    if (!token) return setError("not_logged_in");
    if (!localImageUri) return setError("missing_image");

    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const out = await apiMultipart<Generated>("/ai/generate", {
        token,
        imageUri: localImageUri,
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
      const out = await apiJson<{
        ok: boolean;
        posted: boolean;
        reason?: string;
      }>("/publish", {
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

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.h1}>Automedia</Text>
        <Text style={styles.sub}>Take a product photo → AI generates a post → edit → publish.</Text>

        <View style={styles.card}>
          <Text style={styles.h2}>1) Login</Text>
          <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" style={styles.input} placeholder="Email" />
          <TextInput value={password} onChangeText={setPassword} secureTextEntry style={styles.input} placeholder="Password (min 8 chars)" />
          <View style={styles.row}>
            <PrimaryButton label="Register" onPress={doRegister} disabled={busy} />
            <View style={{ width: 12 }} />
            <PrimaryButton label="Login" onPress={doLogin} disabled={busy} />
          </View>
          <Text style={styles.muted}>Token: {token ? "yes" : "no"}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>2) Photo</Text>
          <View style={styles.row}>
            <PrimaryButton label="Take photo" onPress={takePhoto} disabled={busy} />
            <View style={{ width: 12 }} />
            <PrimaryButton label="Pick from library" onPress={pickFromLibrary} disabled={busy} />
          </View>

          {localImageUri ? (
            <View style={{ marginTop: 12 }}>
              <Image source={{ uri: localImageUri }} style={styles.preview} />
              <Text style={styles.muted}>Selected</Text>
            </View>
          ) : (
            <Text style={styles.muted}>No image selected yet.</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>3) Platform + Generate</Text>
          <View style={styles.row}>
            {(["instagram", "facebook", "tiktok"] as const).map((p) => (
              <Pressable
                key={p}
                onPress={() => setPlatform(p)}
                style={[styles.chip, platform === p && styles.chipActive]}
              >
                <Text style={[styles.chipText, platform === p && styles.chipTextActive]}>{p}</Text>
              </Pressable>
            ))}
          </View>
          <PrimaryButton label="Generate title + caption + hashtags" onPress={generate} disabled={busy || !localImageUri || !token} />
          <Text style={styles.muted}>API: {API_BASE_URL} (use your LAN IP when testing on a phone)</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>4) Edit + Publish</Text>
          {!generated ? (
            <Text style={styles.muted}>Generate first to edit.</Text>
          ) : (
            <>
              <Text style={styles.label}>Title</Text>
              <TextInput value={generated.title} onChangeText={(t) => setGenerated({ ...generated, title: t })} style={styles.input} />

              <Text style={styles.label}>Caption</Text>
              <TextInput
                value={generated.caption}
                onChangeText={(t) => setGenerated({ ...generated, caption: t })}
                style={[styles.input, { minHeight: 110 }]}
                multiline
              />

              <Text style={styles.label}>Hashtags</Text>
              <TextInput
                value={hashtagText}
                onChangeText={(t) =>
                  setGenerated({
                    ...generated,
                    hashtags: t
                      .split(/\s+/)
                      .map((h) => h.trim())
                      .filter(Boolean)
                      .map((h) => h.replace(/^#/, ""))
                  })
                }
                style={[styles.input, { minHeight: 70 }]}
                multiline
              />

              <PrimaryButton label="Publish" onPress={publish} disabled={busy} />
              <Text style={styles.muted}>Publishing is stubbed in MVP until OAuth + provider adapters are added.</Text>
            </>
          )}
        </View>

        {!!error && <Text style={styles.error}>Error: {error}</Text>}
        {!!info && <Text style={styles.info}>{info}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f7f7fb" },
  container: { padding: 16, paddingBottom: 40, gap: 12 },
  h1: { fontSize: 28, fontWeight: "700", color: "#111827" },
  sub: { color: "#4b5563", marginBottom: 4 },
  card: { backgroundColor: "white", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#e5e7eb" },
  h2: { fontSize: 16, fontWeight: "700", marginBottom: 10, color: "#111827" },
  input: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
    marginBottom: 10
  },
  label: { fontWeight: "600", marginBottom: 6, color: "#111827" },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginBottom: 10 },
  btn: { backgroundColor: "#111827", paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, flexGrow: 1, alignItems: "center" },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: "white", fontWeight: "700" },
  muted: { color: "#6b7280", marginTop: 6 },
  preview: { width: "100%", height: 220, borderRadius: 12, backgroundColor: "#f3f4f6" },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: "#e5e7eb", backgroundColor: "#fff", marginRight: 8, marginBottom: 8 },
  chipActive: { backgroundColor: "#111827", borderColor: "#111827" },
  chipText: { color: "#111827", fontWeight: "600" },
  chipTextActive: { color: "white" },
  error: { color: "#b91c1c", fontWeight: "600" },
  info: { color: "#065f46", fontWeight: "600" }
});

