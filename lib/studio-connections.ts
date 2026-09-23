import { verify as verifyConnection } from "./integrations";
import { now, parse, runtime, text } from "./studio-server";
import { UbersuggestMcpClient } from "../cloud-runner/src/ubersuggest-mcp";

type JsonObject = Record<string, unknown>;
type OAuthTokens = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string; expiresAt?: number };
type GoogleCredentials = { clientId: string; clientSecret: string; redirectUri: string };
type GoogleResource = { id: string; label: string; detail?: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ubersuggestIssuer = "https://ubersuggest-mcp.neilpatelapi.com";
const googleProviders = ["gsc", "ga4", "drive", "youtube"] as const;

function bytesToBase64(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function base64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function encryptionKey() {
  const secret = runtime().DATA_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 24) throw new Error("DATA_ENCRYPTION_KEYをCloudflare Worker Secretへ設定してください。");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), encoder.encode(JSON.stringify(value)));
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

async function unseal<T>(value: string): Promise<T> {
  const [iv, ciphertext] = value.split(".");
  if (!iv || !ciphertext) throw new Error("暗号化された接続情報を読み込めませんでした。");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, await encryptionKey(), base64ToBytes(ciphertext));
  return JSON.parse(decoder.decode(clear)) as T;
}

async function jsonRequest(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > 2_000_000) throw new Error("接続先の応答が大きすぎます。");
    const payload = await response.json().catch(() => ({})) as JsonObject;
    if (!response.ok) {
      const nested = payload.error && typeof payload.error === "object" ? payload.error as JsonObject : {};
      throw new Error(text(payload.message || nested.message || `接続先APIエラー (${response.status})`, 240));
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function saveCredential(provider: string, value: unknown, expiresAt: string | null = null, scopes: string[] = []) {
  await runtime().DB.prepare("INSERT INTO integration_credentials (provider,secret_cipher,expires_at,scopes_json,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET secret_cipher=excluded.secret_cipher,expires_at=excluded.expires_at,scopes_json=excluded.scopes_json,updated_at=excluded.updated_at")
    .bind(provider, await seal(value), expiresAt, JSON.stringify(scopes), now()).run();
}

async function loadCredential<T>(provider: string): Promise<{ value: T; expiresAt: string | null; scopes: string[] } | null> {
  const row = await runtime().DB.prepare("SELECT secret_cipher,expires_at,scopes_json FROM integration_credentials WHERE provider=?").bind(provider).first<Record<string, string>>();
  if (!row?.secret_cipher) return null;
  return { value: await unseal<T>(row.secret_cipher), expiresAt: row.expires_at || null, scopes: parse(row.scopes_json || "[]", []) };
}

async function setProfile(provider: string, status: string, config: JsonObject, checkedAt: string | null) {
  const existing = await runtime().DB.prepare("SELECT public_config FROM integration_profiles WHERE provider=?").bind(provider).first<{ public_config: string }>();
  const previous = parse(existing?.public_config || "{}", {} as JsonObject);
  const merged = { ...previous, ...config };
  if (Array.isArray(config.resources)) {
    const resources = config.resources.filter((item): item is GoogleResource => Boolean(item && typeof item === "object" && "id" in item && "label" in item));
    const selected = resources.find(item => item.id === previous.selectedResourceId) || (resources.length === 1 ? resources[0] : undefined);
    if (selected) {
      merged.selectedResourceId = selected.id;
      merged.selectedResourceLabel = selected.label;
      merged.selectedResourceDetail = selected.detail || "";
    } else {
      delete merged.selectedResourceId;
      delete merged.selectedResourceLabel;
      delete merged.selectedResourceDetail;
    }
  }
  await runtime().DB.prepare("INSERT INTO integration_profiles (provider,public_config,status,checked_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET public_config=excluded.public_config,status=excluded.status,checked_at=excluded.checked_at,updated_at=excluded.updated_at")
    .bind(provider, JSON.stringify(merged), status, checkedAt, now()).run();
  return { provider, status, public_config: merged, checked_at: checkedAt };
}

function redirectResult(request: Request, provider: string, result: string) {
  const origin = new URL(request.url).origin;
  return Response.redirect(`${origin}/?page=connections&provider=${encodeURIComponent(provider)}&connection=${encodeURIComponent(result)}`, 302);
}

async function cleanupOAuthStates() {
  await runtime().DB.prepare("DELETE FROM integration_oauth_states WHERE expires_at<=?").bind(now()).run();
}

export async function verifyStaticIntegration(provider: string, body: JsonObject) {
  const saved = await loadCredential<Record<string, string>>(provider);
  const env = runtime();
  const supplied = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, text(value, key.toLowerCase().includes("key") || key.toLowerCase().includes("password") || key.toLowerCase().includes("token") ? 4000 : 800)]));
  let connector = provider;
  let input: Record<string, string> = { ...(saved?.value || {}), ...supplied };
  if (provider === "anthropic") input.apiKey ||= env.ANTHROPIC_API_KEY || "";
  if (provider === "openai") { connector = "image"; input.apiKey ||= env.OPENAI_API_KEY || ""; }
  if (provider === "wordpress") input = { siteUrl: input.siteUrl || input.site_url || env.WORDPRESS_URL || "", username: input.username || env.WORDPRESS_USERNAME || "", applicationPassword: input.applicationPassword || input.application_password || env.WORDPRESS_APPLICATION_PASSWORD || "" };
  if (provider === "notion") input.token ||= env.NOTION_API_KEY || "";
  if (provider === "pagespeed") input.apiKey ||= env.PAGESPEED_API_KEY || "";
  const result = await verifyConnection(connector, input);
  if (Object.values(supplied).some(Boolean)) await saveCredential(provider, result.secret);
  return setProfile(provider, "CONFIGURED", result.publicConfig, now());
}

export async function startUbersuggestOAuth(request: Request) {
  await cleanupOAuthStates();
  const redirectUri = `${new URL(request.url).origin}/api/oauth/ubersuggest/callback`;
  const registration = await jsonRequest(`${ubersuggestIssuer}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "動画一次情報記事制作アプリ", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  const clientId = text(registration.client_id, 500);
  if (!clientId) throw new Error("Ubersuggest MCP OAuthクライアントを登録できませんでした。");
  const state = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  await runtime().DB.prepare("INSERT INTO integration_oauth_states (state,provider,secret_cipher,expires_at,created_at) VALUES (?,?,?,?,?)")
    .bind(state, "ubersuggest", await seal({ clientId, verifier, redirectUri }), new Date(Date.now() + 10 * 60_000).toISOString(), now()).run();
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "profile domain keywords serp backlinks site_audit content projects utility", state, code_challenge: challenge, code_challenge_method: "S256" });
  return { authorizationUrl: `${ubersuggestIssuer}/authorize?${params}` };
}

export async function finishUbersuggestOAuth(request: Request) {
  const url = new URL(request.url), state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
  const pending = await runtime().DB.prepare("SELECT secret_cipher FROM integration_oauth_states WHERE state=? AND provider='ubersuggest' AND expires_at>?").bind(state, now()).first<{ secret_cipher: string }>();
  await runtime().DB.prepare("DELETE FROM integration_oauth_states WHERE state=?").bind(state).run();
  if (!pending || !code) return redirectResult(request, "ubersuggest", url.searchParams.get("error") ? "denied" : "session_expired");
  try {
    const setup = await unseal<{ clientId: string; verifier: string; redirectUri: string }>(pending.secret_cipher);
    const token = await jsonRequest(`${ubersuggestIssuer}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: setup.clientId, redirect_uri: setup.redirectUri, code_verifier: setup.verifier }) }) as OAuthTokens;
    if (!token.access_token) throw new Error("Ubersuggest MCPアクセストークンを取得できませんでした。");
    const expiresAt = new Date(Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000).toISOString();
    await saveCredential("ubersuggest", { clientId: setup.clientId, accessToken: token.access_token, refreshToken: token.refresh_token || "" }, expiresAt, String(token.scope || "").split(" ").filter(Boolean));
    const tools = await new UbersuggestMcpClient(token.access_token).listTools();
    await setProfile("ubersuggest", "CONFIGURED", { mode: "oauth_pkce", mcpUrl: `${ubersuggestIssuer}/mcp`, toolCount: tools.length }, now());
    return redirectResult(request, "ubersuggest", "connected");
  } catch (error) {
    await setProfile("ubersuggest", "CONNECTION_ERROR", { lastError: text(error instanceof Error ? error.message : error, 240) }, null);
    return redirectResult(request, "ubersuggest", "failed");
  }
}

export async function getUbersuggestAccessToken() {
  const saved = await loadCredential<{ clientId: string; accessToken: string; refreshToken: string }>("ubersuggest");
  if (!saved) {
    const fallback = runtime().UBERSUGGEST_ACCESS_TOKEN || "";
    if (!fallback) throw new Error("Ubersuggest MCPを接続してください。");
    return fallback;
  }
  if (saved.value.accessToken && (!saved.expiresAt || Date.parse(saved.expiresAt) > Date.now() + 120_000)) return saved.value.accessToken;
  if (!saved.value.clientId || !saved.value.refreshToken) throw new Error("Ubersuggest MCPの再接続が必要です。");
  const token = await jsonRequest(`${ubersuggestIssuer}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.value.refreshToken, client_id: saved.value.clientId }) }) as OAuthTokens;
  if (!token.access_token) throw new Error("Ubersuggest MCPトークンを更新できませんでした。");
  const expiresAt = new Date(Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000).toISOString();
  await saveCredential("ubersuggest", { ...saved.value, accessToken: token.access_token, refreshToken: token.refresh_token || saved.value.refreshToken }, expiresAt, saved.scopes);
  return token.access_token;
}

async function googleCredentials(request: Request, body: JsonObject = {}): Promise<GoogleCredentials> {
  const clientId = text(body.client_id, 1000), clientSecret = text(body.client_secret, 3000);
  if (clientId && clientSecret) await saveCredential("google_oauth_config", { clientId, clientSecret });
  const saved = await loadCredential<{ clientId: string; clientSecret: string }>("google_oauth_config");
  const env = runtime();
  const resolvedId = clientId || env.GOOGLE_OAUTH_CLIENT_ID || saved?.value.clientId || "";
  const resolvedSecret = clientSecret || env.GOOGLE_OAUTH_CLIENT_SECRET || saved?.value.clientSecret || "";
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI || `${new URL(request.url).origin}/api/oauth/google/callback`;
  if (!resolvedId || !resolvedSecret) throw new Error("Google OAuth Client IDとClient Secretを設定してください。");
  return { clientId: resolvedId, clientSecret: resolvedSecret, redirectUri };
}

export async function startGoogleOAuth(request: Request, body: JsonObject) {
  await cleanupOAuthStates();
  const credentials = await googleCredentials(request, body), state = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await runtime().DB.prepare("INSERT INTO integration_oauth_states (state,provider,secret_cipher,expires_at,created_at) VALUES (?,?,?,?,?)")
    .bind(state, "google", await seal({ redirectUri: credentials.redirectUri }), new Date(Date.now() + 10 * 60_000).toISOString(), now()).run();
  const scopes = ["https://www.googleapis.com/auth/analytics.readonly", "https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/youtube.readonly"];
  const params = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: credentials.redirectUri, response_type: "code", scope: scopes.join(" "), access_type: "offline", include_granted_scopes: "true", prompt: "consent", state });
  return { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
}

async function saveGoogleTokens(tokens: OAuthTokens) {
  const previous = await loadCredential<OAuthTokens>("google_oauth"), expiresAt = new Date(Date.now() + Math.max(60, Number(tokens.expires_in || 3600)) * 1000).toISOString();
  const merged = { ...previous?.value, ...tokens, refresh_token: tokens.refresh_token || previous?.value.refresh_token || "", expiresAt: Date.parse(expiresAt) };
  await saveCredential("google_oauth", merged, expiresAt, String(tokens.scope || previous?.value.scope || "").split(" ").filter(Boolean));
  return merged;
}

async function googleAccessToken(request: Request) {
  const saved = await loadCredential<OAuthTokens>("google_oauth");
  if (!saved?.value.access_token) throw new Error("Googleアカウントを接続してください。");
  if (!saved.expiresAt || Date.parse(saved.expiresAt) > Date.now() + 120_000) return saved.value.access_token;
  if (!saved.value.refresh_token) throw new Error("Googleアカウントの再接続が必要です。");
  const credentials = await googleCredentials(request);
  const token = await jsonRequest("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, refresh_token: saved.value.refresh_token, grant_type: "refresh_token" }) }) as OAuthTokens;
  const merged = await saveGoogleTokens({ ...token, refresh_token: token.refresh_token || saved.value.refresh_token });
  if (!merged.access_token) throw new Error("Googleアクセストークンを更新できませんでした。");
  return merged.access_token;
}

export async function verifyGoogleIntegrations(request: Request, suppliedToken?: string) {
  const accessToken = suppliedToken || await googleAccessToken(request), headers = { Authorization: `Bearer ${accessToken}` };
  const verify = async (provider: typeof googleProviders[number], load: () => Promise<JsonObject>) => {
    try { return await setProfile(provider, "CONFIGURED", await load(), now()); }
    catch (error) { return setProfile(provider, "CONNECTION_ERROR", { lastError: text(error instanceof Error ? error.message : error, 240) }, null); }
  };
  return Promise.all([
    verify("gsc", async () => {
      const data = await jsonRequest("https://www.googleapis.com/webmasters/v3/sites", { headers });
      const sites = Array.isArray(data.siteEntry) ? data.siteEntry as JsonObject[] : [];
      const resources = sites.map(site => ({ id: text(site.siteUrl, 500), label: text(site.siteUrl, 500), detail: text(site.permissionLevel, 120) })).filter(item => item.id);
      return { resourceName: `${resources.length}サイト`, sites, resources };
    }),
    verify("ga4", async () => {
      const data = await jsonRequest("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", { headers });
      const accounts = Array.isArray(data.accountSummaries) ? data.accountSummaries as JsonObject[] : [];
      const resources = accounts.flatMap(account => {
        const properties = Array.isArray(account.propertySummaries) ? account.propertySummaries as JsonObject[] : [];
        return properties.map(property => ({ id: text(property.property, 500), label: text(property.displayName || property.property, 500), detail: text(account.displayName || account.account, 500) })).filter(item => item.id);
      });
      return { resourceName: `${resources.length}プロパティ`, accounts, resources };
    }),
    verify("drive", async () => {
      const [about, shared] = await Promise.all([
        jsonRequest("https://www.googleapis.com/drive/v3/about?fields=user", { headers }),
        jsonRequest("https://www.googleapis.com/drive/v3/drives?pageSize=100&fields=drives(id,name),nextPageToken", { headers }),
      ]);
      const user = (about.user && typeof about.user === "object" ? about.user : {}) as JsonObject;
      const drives = Array.isArray(shared.drives) ? shared.drives as JsonObject[] : [];
      const resources: GoogleResource[] = [{ id: "root", label: "マイドライブ", detail: text(user.emailAddress || user.displayName, 500) }, ...drives.map(drive => ({ id: text(drive.id, 500), label: text(drive.name || drive.id, 500), detail: "共有ドライブ" })).filter(item => item.id)];
      return { resourceName: `${resources.length}ドライブ`, user, drives, resources };
    }),
    verify("youtube", async () => {
      const data = await jsonRequest("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true", { headers });
      const channels = Array.isArray(data.items) ? data.items as JsonObject[] : [];
      const resources = channels.map(channel => { const snippet = (channel.snippet && typeof channel.snippet === "object" ? channel.snippet : {}) as JsonObject; return { id: text(channel.id, 500), label: text(snippet.title || channel.id, 500), detail: "YouTubeチャンネル" }; }).filter(item => item.id);
      return { resourceName: `${resources.length}チャンネル`, channels, resources };
    }),
  ]);
}

export async function selectGoogleResource(provider: string, body: JsonObject) {
  if (!(googleProviders as readonly string[]).includes(provider)) throw new Error("Google連携の選択対象ではありません。");
  const resourceId = text(body.resourceId, 500);
  if (!resourceId) throw new Error("利用する対象を選択してください。");
  const row = await runtime().DB.prepare("SELECT public_config,status,checked_at FROM integration_profiles WHERE provider=?").bind(provider).first<{ public_config: string; status: string; checked_at: string | null }>();
  if (!row || row.status !== "CONFIGURED") throw new Error("先にGoogleアカウントを接続してください。");
  const config = parse(row.public_config || "{}", {} as JsonObject), resources = Array.isArray(config.resources) ? config.resources as JsonObject[] : [];
  const selected = resources.find(item => text(item.id, 500) === resourceId);
  if (!selected) throw new Error("選択した対象が現在のGoogleアカウントに見つかりません。再取得してください。");
  return setProfile(provider, "CONFIGURED", { selectedResourceId: resourceId, selectedResourceLabel: text(selected.label, 500), selectedResourceDetail: text(selected.detail, 500) }, row.checked_at || now());
}

export async function finishGoogleOAuth(request: Request) {
  const url = new URL(request.url), state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
  const pending = await runtime().DB.prepare("SELECT secret_cipher FROM integration_oauth_states WHERE state=? AND provider='google' AND expires_at>?").bind(state, now()).first<{ secret_cipher: string }>();
  await runtime().DB.prepare("DELETE FROM integration_oauth_states WHERE state=?").bind(state).run();
  if (!pending || !code) return redirectResult(request, "google", url.searchParams.get("error") ? "denied" : "session_expired");
  try {
    const stateData = await unseal<{ redirectUri: string }>(pending.secret_cipher), credentials = await googleCredentials(request);
    const tokens = await jsonRequest("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code, grant_type: "authorization_code", redirect_uri: stateData.redirectUri }) }) as OAuthTokens;
    if (!tokens.access_token) throw new Error("Googleアクセストークンを取得できませんでした。");
    await saveGoogleTokens(tokens);
    await verifyGoogleIntegrations(request, tokens.access_token);
    return redirectResult(request, "google", "connected");
  } catch (error) {
    const message = text(error instanceof Error ? error.message : error, 240);
    await Promise.all(googleProviders.map(provider => setProfile(provider, "CONNECTION_ERROR", { lastError: message }, null)));
    return redirectResult(request, "google", "failed");
  }
}

export async function checkIntegration(provider: string, request: Request, body: JsonObject = {}) {
  if (provider === "ubersuggest") {
    const token = await getUbersuggestAccessToken(), tools = await new UbersuggestMcpClient(token).listTools();
    return setProfile(provider, "CONFIGURED", { mode: "mcp", mcpUrl: `${ubersuggestIssuer}/mcp`, toolCount: tools.length }, now());
  }
  if ((googleProviders as readonly string[]).includes(provider)) {
    const results = await verifyGoogleIntegrations(request);
    return results.find(item => item.provider === provider) || results;
  }
  return verifyStaticIntegration(provider, body);
}

export async function disconnectIntegration(provider: string) {
  if ((googleProviders as readonly string[]).includes(provider)) {
    await runtime().DB.prepare("DELETE FROM integration_credentials WHERE provider='google_oauth'").run();
    await runtime().DB.batch(googleProviders.map(item => runtime().DB.prepare("UPDATE integration_profiles SET status='NOT_CONFIGURED',checked_at=NULL,updated_at=? WHERE provider=?").bind(now(), item)));
    return { providers: googleProviders };
  }
  await runtime().DB.prepare("DELETE FROM integration_credentials WHERE provider=?").bind(provider).run();
  await runtime().DB.prepare("UPDATE integration_profiles SET status='NOT_CONFIGURED',checked_at=NULL,updated_at=? WHERE provider=?").bind(now(), provider).run();
  return { providers: [provider] };
}
