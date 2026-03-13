import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GoogleVoice = {
  name?: string;
  languageCodes?: string[];
  ssmlGender?: string;
  naturalSampleRateHertz?: number;
};
type VoicesResponse = { voices?: GoogleVoice[] };
type SynthesizeResponse = { audioContent?: string };

type GeminiCandidate = {
  content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
};
type GeminiResponse = { candidates?: GeminiCandidate[]; error?: { message?: string } };

type OAuthTokens = {
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
};

type Engine = "gemini" | "cloud";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, "out");
const TOKEN_PATH = path.join(__dirname, "google-tts-tokens.json");
const VOICE_STATE_PATH = path.join(__dirname, "voice-state.json");
const VOICE_CONFIG_PATH = path.join(__dirname, "voice-config.json");
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

const DEFAULT_ENGINE: Engine = "gemini";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_AUTO_VOICE_GEMINI_MODEL = "gemini-2.5-pro-preview-tts";
const DEFAULT_GEMINI_VOICE = "Leda";
const DEFAULT_GEMINI_STYLE =
  "请用自然、温和、专业的口吻表达。语气不评判，带一点自然的回应感，节奏自然，更像真实对话，不像朗读稿件。";
const DEFAULT_AUTO_VOICE_ACCOUNTS = ["your-bot-account-id"] as const;
const LEGACY_AUTO_VOICE_PRIMARY_ACCOUNT_ID = DEFAULT_AUTO_VOICE_ACCOUNTS[0];
const GEMINI_TTS_RETRY_DELAYS_MS = [300, 1000];
const AUTO_VOICE_FALLBACK_DELAY_MS = 1200;
const AUTO_VOICE_RECENT_TTL_MS = 30_000;
const AUTO_VOICE_SLASH_COMMAND_SKIP_TTL_MS = 90_000;
const DEFAULT_CLOUD_LANG = "cmn-CN";
const DEFAULT_CLOUD_VOICE = "cmn-CN-Wavenet-A";
const SUPPORTED_AUTO_VOICE_GEMINI_MODELS = [
  DEFAULT_GEMINI_MODEL,
  DEFAULT_AUTO_VOICE_GEMINI_MODEL,
] as const;

// Gemini TTS voices (multi-language, no lang code needed)
const GEMINI_VOICES = [
  "Aoede", "Charon", "Fenrir", "Kore", "Puck",
  "Achernar", "Gacrux", "Leda", "Orus", "Zephyr",
];

const LANG_ALIASES: Record<string, string> = {
  "zh-CN": "cmn-CN", "zh-TW": "cmn-TW", zh: "cmn-CN",
  en: "en-US", ja: "ja-JP", ko: "ko-KR",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function lower(value: unknown): string {
  return trim(value).toLowerCase();
}

function resolveLang(input: string): string {
  return LANG_ALIASES[input] || input;
}

function normalizeConversationId(value: unknown, channelId?: string): string {
  const trimmed = trim(value);
  const normalizedChannelId = trim(channelId);
  if (!trimmed || !normalizedChannelId) return trimmed;
  const prefix = `${normalizedChannelId}:`;
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    ? trimmed.slice(prefix.length)
    : trimmed;
}

function normalizeAutoVoiceAccountId(value: unknown): string {
  return trim(value).toLowerCase();
}

function normalizeAutoVoiceAccounts(values: unknown): string[] {
  if (!Array.isArray(values)) return [...DEFAULT_AUTO_VOICE_ACCOUNTS];
  const normalized = Array.from(new Set(
    values
      .map((value) => normalizeAutoVoiceAccountId(value))
      .filter(Boolean),
  ));
  return normalized.length > 0 ? normalized : [...DEFAULT_AUTO_VOICE_ACCOUNTS];
}

type VoicePluginConfig = {
  autoVoiceAccounts?: string[];
  autoVoiceModel?: string;
  accounts?: Record<string, {
    defaultVoice?: string;
    defaultStyle?: string;
    defaultStyleByModel?: Record<string, string>;
  }>;
};

let cachedVoicePluginConfigMtimeMs = -1;
let cachedVoicePluginConfig: VoicePluginConfig = {};

function loadVoicePluginConfigSync(): VoicePluginConfig {
  try {
    const stat = statSync(VOICE_CONFIG_PATH);
    if (stat.mtimeMs === cachedVoicePluginConfigMtimeMs) return cachedVoicePluginConfig;
    const raw = readFileSync(VOICE_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as VoicePluginConfig;
    cachedVoicePluginConfigMtimeMs = stat.mtimeMs;
    cachedVoicePluginConfig = parsed && typeof parsed === "object" ? parsed : {};
    return cachedVoicePluginConfig;
  } catch {
    cachedVoicePluginConfigMtimeMs = -1;
    cachedVoicePluginConfig = {};
    return cachedVoicePluginConfig;
  }
}

function getAutoVoiceAccountIds(): string[] {
  return normalizeAutoVoiceAccounts(loadVoicePluginConfigSync().autoVoiceAccounts);
}

function normalizeAutoVoiceModel(value: unknown): string {
  const model = trim(value);
  return (SUPPORTED_AUTO_VOICE_GEMINI_MODELS as readonly string[]).includes(model)
    ? model
    : DEFAULT_AUTO_VOICE_GEMINI_MODEL;
}

function getAutoVoiceModel(): string {
  return normalizeAutoVoiceModel(loadVoicePluginConfigSync().autoVoiceModel);
}

function getVoiceAccountConfig(accountId?: string): {
  defaultVoice?: string;
  defaultStyle?: string;
  defaultStyleByModel?: Record<string, string>;
} {
  const normalizedAccountId = normalizeAutoVoiceAccountId(accountId);
  if (!normalizedAccountId) return {};
  const accounts = loadVoicePluginConfigSync().accounts;
  if (!accounts || typeof accounts !== "object") return {};
  for (const [key, value] of Object.entries(accounts)) {
    if (normalizeAutoVoiceAccountId(key) !== normalizedAccountId) continue;
    return value && typeof value === "object" ? value : {};
  }
  return {};
}

function getConfiguredDefaultVoice(accountId?: string): string {
  return trim(getVoiceAccountConfig(accountId).defaultVoice) || DEFAULT_GEMINI_VOICE;
}

function getConfiguredDefaultStyle(accountId?: string): string {
  return trim(getVoiceAccountConfig(accountId).defaultStyle) || DEFAULT_GEMINI_STYLE;
}

function buildVoiceStateKey(params: {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
}): string | null {
  const channelId = trim(params.channelId);
  const accountId = normalizeAutoVoiceAccountId(params.accountId);
  const conversationId = normalizeConversationId(params.conversationId, channelId);
  if (!channelId || !accountId || !conversationId) return null;
  return `${channelId}::${accountId}::${conversationId}`;
}

function buildRawVoiceStateKey(params: {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
}): string | null {
  const channelId = trim(params.channelId);
  const accountId = normalizeAutoVoiceAccountId(params.accountId);
  const conversationId = trim(params.conversationId);
  if (!channelId || !accountId || !conversationId) return null;
  return `${channelId}::${accountId}::${conversationId}`;
}

function buildPrefixedVoiceStateKey(params: {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
}): string | null {
  const channelId = trim(params.channelId);
  const accountId = normalizeAutoVoiceAccountId(params.accountId);
  const conversationId = trim(params.conversationId);
  if (!channelId || !accountId || !conversationId) return null;
  if (conversationId.toLowerCase().startsWith(`${channelId.toLowerCase()}:`)) {
    return `${channelId}::${accountId}::${conversationId}`;
  }
  return `${channelId}::${accountId}::${channelId}:${conversationId}`;
}

function buildLegacyVoiceStateKey(params: {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
}): string | null {
  const channelId = trim(params.channelId);
  const conversationId = normalizeConversationId(params.conversationId, channelId);
  const accountId = normalizeAutoVoiceAccountId(params.accountId);
  if (!channelId || !conversationId || accountId !== LEGACY_AUTO_VOICE_PRIMARY_ACCOUNT_ID) return null;
  return `${channelId}::${conversationId}`;
}

function buildPrefixedLegacyVoiceStateKey(params: {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
}): string | null {
  const channelId = trim(params.channelId);
  const conversationId = trim(params.conversationId);
  const accountId = normalizeAutoVoiceAccountId(params.accountId);
  if (!channelId || !conversationId || accountId !== LEGACY_AUTO_VOICE_PRIMARY_ACCOUNT_ID) return null;
  if (conversationId.toLowerCase().startsWith(`${channelId.toLowerCase()}:`)) {
    return `${channelId}::${conversationId}`;
  }
  return `${channelId}::${channelId}:${conversationId}`;
}

function buildRawLegacyVoiceStateKey(params: {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
}): string | null {
  const channelId = trim(params.channelId);
  const conversationId = trim(params.conversationId);
  const accountId = normalizeAutoVoiceAccountId(params.accountId);
  if (!channelId || !conversationId || accountId !== LEGACY_AUTO_VOICE_PRIMARY_ACCOUNT_ID) return null;
  return `${channelId}::${conversationId}`;
}

function buildVoiceStateKeyCandidates(params: {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
}): string[] {
  return Array.from(new Set([
    buildVoiceStateKey(params),
    buildRawVoiceStateKey(params),
    buildPrefixedVoiceStateKey(params),
    buildLegacyVoiceStateKey(params),
    buildRawLegacyVoiceStateKey(params),
    buildPrefixedLegacyVoiceStateKey(params),
  ].filter((value): value is string => Boolean(value))));
}

function buildVoiceScopeKey(params: {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
}): string | null {
  return buildVoiceStateKeyCandidates(params)[0] ?? null;
}

function resolveCommandConversationId(ctx: {
  from?: string;
  to?: string;
  channel?: string;
  channelId?: string;
  messageThreadId?: number;
}): string {
  const channelId = trim(ctx.channelId) || trim(ctx.channel);
  const base = normalizeConversationId(trim(ctx.from) || trim(ctx.to), channelId);
  if (!base) return "";
  if (ctx.messageThreadId == null) return base;
  if (base.includes(":topic:") || /:\d+$/.test(base)) return base;
  return `${base}:topic:${Math.trunc(ctx.messageThreadId)}`;
}

function normalizeVoiceState(state?: VoiceReplyState): VoiceReplyState {
  return {
    enabled: state?.enabled === true,
    voice: trim(state?.voice) || undefined,
    style: trim(state?.style) || undefined,
    updatedAt: typeof state?.updatedAt === "number" ? state.updatedAt : undefined,
    skipNextOutboundCount:
      typeof state?.skipNextOutboundCount === "number" && state.skipNextOutboundCount > 0
        ? Math.trunc(state.skipNextOutboundCount)
        : 0,
  };
}

function compactVoiceState(state: VoiceReplyState): VoiceReplyState | null {
  const normalized = normalizeVoiceState(state);
  if (
    normalized.enabled !== true &&
    !normalized.voice &&
    !normalized.style &&
    (normalized.skipNextOutboundCount || 0) === 0
  ) {
    return null;
  }
  return normalized;
}

let cachedVoiceReplyStore: VoiceReplyStore | null = null;

function migrateVoiceReplyStore(store: VoiceReplyStore): { store: VoiceReplyStore; changed: boolean } {
  const next: VoiceReplyStore = { ...store };
  let changed = false;
  for (const [key, value] of Object.entries(store)) {
    const parts = key.split("::");
    if (parts.length !== 2) continue;
    if (parts[0] !== "telegram" || !parts[1]) continue;
    const migratedKey = `telegram::${LEGACY_AUTO_VOICE_PRIMARY_ACCOUNT_ID}::${parts[1]}`;
    if (!(migratedKey in next)) next[migratedKey] = value;
    delete next[key];
    changed = true;
  }
  return { store: next, changed };
}

async function loadVoiceReplyStore(): Promise<VoiceReplyStore> {
  if (cachedVoiceReplyStore) return cachedVoiceReplyStore;
  try {
    const raw = await readFile(VOICE_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as VoiceReplyStore;
    const normalized = parsed && typeof parsed === "object" ? parsed : {};
    const migrated = migrateVoiceReplyStore(normalized);
    cachedVoiceReplyStore = migrated.store;
    if (migrated.changed) await saveVoiceReplyStore(migrated.store);
  } catch {
    cachedVoiceReplyStore = {};
  }
  return cachedVoiceReplyStore;
}

async function saveVoiceReplyStore(store: VoiceReplyStore): Promise<void> {
  cachedVoiceReplyStore = store;
  await mkdir(__dirname, { recursive: true });
  const tmpPath = `${VOICE_STATE_PATH}.tmp`;
  await writeFile(tmpPath, JSON.stringify(store, null, 2));
  await rename(tmpPath, VOICE_STATE_PATH);
}

async function updateVoiceReplyState(
  params: { channelId?: string; accountId?: string; conversationId?: string },
  updater: (current: VoiceReplyState) => VoiceReplyState,
): Promise<VoiceReplyState | null> {
  const key = buildVoiceStateKey(params);
  if (!key) return null;
  const keyCandidates = buildVoiceStateKeyCandidates(params);
  const store = { ...(await loadVoiceReplyStore()) };
  const existingKey = keyCandidates.find((candidate) => candidate in store);
  const existing = existingKey ? store[existingKey] : undefined;
  const next = updater(normalizeVoiceState(existing));
  const compacted = compactVoiceState(next);
  if (compacted) store[key] = compacted;
  else delete store[key];
  for (const candidate of keyCandidates) {
    if (candidate !== key) delete store[candidate];
  }
  await saveVoiceReplyStore(store);
  return compacted;
}

async function readVoiceReplyState(params: {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
}): Promise<VoiceReplyState> {
  const keyCandidates = buildVoiceStateKeyCandidates(params);
  if (keyCandidates.length === 0) return normalizeVoiceState();
  const store = await loadVoiceReplyStore();
  const match = keyCandidates.find((candidate) => candidate in store);
  return normalizeVoiceState(match ? store[match] : undefined);
}

function getEffectiveVoice(state: VoiceReplyState, accountId?: string): string {
  return trim(state.voice) || getConfiguredDefaultVoice(accountId);
}

function getEffectiveStyle(state: VoiceReplyState, accountId?: string): string {
  return trim(state.style) || getConfiguredDefaultStyle(accountId);
}

function isResetKeyword(value: string): boolean {
  const normalized = lower(value);
  return normalized === "default" || normalized === "reset" || trim(value) === "默认";
}

function normalizeGeminiVoice(value: string): string | null {
  const normalized = lower(value);
  return GEMINI_VOICES.find((voice) => voice.toLowerCase() === normalized) ?? null;
}

function unwrapJsonFence(value: string): string {
  const trimmed = trim(value);
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? trim(match[1]) : trimmed;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const AUTO_VOICE_META_REPLY_PATTERNS = [
  /^(?:✅\s*)?New session started\b/i,
  /^🎙️\s*语音模式已(?:开启|关闭)\s*$/u,
  /^🎙️\s*当前语音模式：/u,
  /^🎛️\s*当前语音风格：/u,
  /^🎛️\s*语音风格已/u,
  /^🎚️\s*当前语音声线：/u,
  /^🎚️\s*语音声线已/u,
  /^当前 voice 不可用/u,
  /^这个语音命令当前未对这个 bot 开启/u,
];
const PLUGIN_SKIP_COUNT_COMMANDS = new Set([
  "autovoice",
  "voice_style",
  "voice_voice",
  "voicevoice",
  "voicev",
  "gtts",
]);

function isAutoVoiceMetaReply(value: string): boolean {
  const trimmed = trim(value);
  if (!trimmed) return false;
  return AUTO_VOICE_META_REPLY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isSlashCommandLike(value: string): boolean {
  const trimmed = trim(value);
  if (!trimmed) return false;
  return /^\/[a-z][a-z0-9_]*(?:@[a-z0-9_]+)?(?:\s|$)/i.test(trimmed);
}

function extractSlashCommandName(value: string): string {
  const trimmed = trim(value);
  const match = trimmed.match(/^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?(?:\s|$)/i);
  return lower(match?.[1]);
}

function extractSpeechText(raw: string): {
  text?: string;
  skipReason?: "json_without_response" | "meta_reply";
} {
  const trimmed = trim(raw);
  if (!trimmed) return {};
  if (isAutoVoiceMetaReply(trimmed)) return { skipReason: "meta_reply" };
  const jsonCandidate = unwrapJsonFence(trimmed);
  const parsed = tryParseJsonRecord(jsonCandidate);
  if (!parsed) return { text: trimmed };
  const response = trim(parsed.response);
  if (response) return { text: response };
  return { skipReason: "json_without_response" };
}

type ParsedSayArgs = {
  text: string;
  lang: string;
  voice: string;
  engine: Engine;
  model: string;
  style: string;
  voiceExplicit: boolean;
};

type VoiceReplyState = {
  enabled?: boolean;
  voice?: string;
  style?: string;
  updatedAt?: number;
  skipNextOutboundCount?: number;
};

type VoiceReplyStore = Record<string, VoiceReplyState>;

function splitCommandArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function parseSayArgs(tokens: string[]): ParsedSayArgs {
  let lang = DEFAULT_CLOUD_LANG;
  let voice = "";
  let engine: Engine = DEFAULT_ENGINE;
  let model = DEFAULT_GEMINI_MODEL;
  let style = "";
  const textParts: string[] = [];
  let voiceExplicit = false;
  let langExplicit = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === "--lang" || t === "-l") && tokens[i + 1]) {
      lang = resolveLang(tokens[++i]);
      langExplicit = true;
    } else if ((t === "--voice" || t === "-v") && tokens[i + 1]) {
      voice = tokens[++i];
      voiceExplicit = true;
    } else if ((t === "--style" || t === "-s") && tokens[i + 1]) {
      style = tokens[++i];
    } else if ((t === "--engine" || t === "-e") && tokens[i + 1]) {
      const v = tokens[++i].toLowerCase();
      if (v === "cloud" || v === "google") engine = "cloud";
      else engine = "gemini";
    } else if ((t === "--model" || t === "-m") && tokens[i + 1]) {
      model = tokens[++i];
    } else if (t === "--pro") {
      model = "gemini-2.5-pro-preview-tts";
    } else if (t === "--flash") {
      model = "gemini-2.5-flash-preview-tts";
    } else {
      textParts.push(t);
    }
  }

  // Set defaults per engine
  if (engine === "gemini" && !voiceExplicit) {
    voice = DEFAULT_GEMINI_VOICE;
  } else if (engine === "cloud") {
    if (!voiceExplicit) voice = langExplicit ? "" : DEFAULT_CLOUD_VOICE;
  }

  return { text: textParts.join(" ").trim(), lang, voice, engine, model, style, voiceExplicit };
}

function buildGeminiSpeechPrompt(text: string, style: string): string {
  const cleanText = trim(text);
  const cleanStyle = trim(style);
  if (!cleanStyle) return cleanText;
  return [
    "请只朗读下面的正文，不要朗读说明文字，不要添加额外内容。",
    `风格要求：${cleanStyle}`,
    `正文：${cleanText}`,
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiTtsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|network|socket|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|timeout|terminated/i.test(message)) {
    return true;
  }
  const statusMatch = message.match(/Gemini TTS failed \((\d{3})\):/i);
  const status = statusMatch ? Number(statusMatch[1]) : NaN;
  if (status === 429 || status >= 500) return true;
  if (status === 400 && /Model tried to generate text, but it should only be used for TTS/i.test(message)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auth: OAuth for Cloud TTS
// ---------------------------------------------------------------------------

async function loadOAuthTokens(): Promise<OAuthTokens | null> {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, "utf8")) as OAuthTokens;
  } catch {
    return null;
  }
}

async function refreshAccessToken(tokens: OAuthTokens): Promise<OAuthTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: tokens.client_id,
      client_secret: tokens.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`OAuth refresh failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  return tokens;
}

async function resolveCloudAuth(api: OpenClawPluginApi): Promise<string | null> {
  let tokens = await loadOAuthTokens();
  if (tokens?.refresh_token) {
    try {
      if (Date.now() > tokens.expires_at - 60_000) {
        api.logger.info("[google-tts] refreshing OAuth access token");
        tokens = await refreshAccessToken(tokens);
      }
      return tokens.access_token;
    } catch (error) {
      api.logger.warn(`[google-tts] OAuth refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const envToken = trim(process.env.GOOGLE_ACCESS_TOKEN);
  return envToken || null;
}

// ---------------------------------------------------------------------------
// Auth: API key for Gemini TTS
// ---------------------------------------------------------------------------

async function resolveGeminiApiKey(api: OpenClawPluginApi): Promise<string | null> {
  // 1. Env var
  const envKey = trim(process.env.GOOGLE_API_KEY);
  if (envKey) return envKey;

  // 2. Read from the plugin's own token file (most reliable)
  try {
    const raw = await readFile(TOKEN_PATH, "utf8");
    const data = JSON.parse(raw) as { gemini_api_key?: string };
    const key = trim(data.gemini_api_key);
    if (key) return key;
  } catch (error) {
    api.logger.warn(`[google-tts] token file read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// PCM → MP3 conversion via ffmpeg
// ---------------------------------------------------------------------------

function pcmToMp3(pcmPath: string, mp3Path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcmPath, mp3Path],
      (err) => (err ? reject(new Error(`ffmpeg failed: ${err.message}`)) : resolve()),
    );
  });
}

function pcmToOggOpus(pcmPath: string, oggPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-f",
        "s16le",
        "-ar",
        "24000",
        "-ac",
        "1",
        "-i",
        pcmPath,
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-application",
        "voip",
        "-frame_duration",
        "60",
        oggPath,
      ],
      (err) => (err ? reject(new Error(`ffmpeg failed: ${err.message}`)) : resolve()),
    );
  });
}

type OpenClawTelegramConfig = {
  channels?: {
    telegram?: {
      botToken?: string;
      accounts?: Record<string, { botToken?: string }>;
    };
  };
};

let cachedOpenClawConfig: OpenClawTelegramConfig | null = null;

async function loadOpenClawConfig(): Promise<OpenClawTelegramConfig | null> {
  if (cachedOpenClawConfig) return cachedOpenClawConfig;
  try {
    const raw = await readFile(OPENCLAW_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as OpenClawTelegramConfig;
    cachedOpenClawConfig = parsed;
    return parsed;
  } catch {
    return null;
  }
}

async function resolveTelegramBotToken(accountId?: string): Promise<string | null> {
  const cfg = await loadOpenClawConfig();
  const telegram = cfg?.channels?.telegram;
  const trimmedAccountId = trim(accountId);
  const accountToken = trimmedAccountId ? trim(telegram?.accounts?.[trimmedAccountId]?.botToken) : "";
  return accountToken || trim(telegram?.botToken) || null;
}

function resolveTelegramChatTarget(...values: Array<unknown>): { chatId: string; messageThreadId?: number } | null {
  for (const rawValue of values) {
    const trimmed = trim(rawValue);
    if (!trimmed) continue;
    const source = trimmed.startsWith("telegram:") ? trimmed.slice("telegram:".length) : trimmed;
    const threadMatch = source.match(/:topic:(\d+)$/i);
    const messageThreadId = threadMatch ? Number.parseInt(threadMatch[1], 10) : undefined;
    const withoutThread = threadMatch ? source.slice(0, threadMatch.index) : source;
    if (/^-?\d+$/.test(withoutThread)) {
      return { chatId: withoutThread, ...(Number.isFinite(messageThreadId) ? { messageThreadId } : {}) };
    }
    const groupMatch = withoutThread.match(/(?:^|:group:)(-?\d+)(?:$|:)/i);
    if (groupMatch?.[1]) {
      return { chatId: groupMatch[1], ...(Number.isFinite(messageThreadId) ? { messageThreadId } : {}) };
    }
    const numericMatch = withoutThread.match(/-?\d+/);
    if (numericMatch?.[0]) {
      return { chatId: numericMatch[0], ...(Number.isFinite(messageThreadId) ? { messageThreadId } : {}) };
    }
  }
  return null;
}

function runExecFile(
  file: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options?.timeout ?? 90_000,
        maxBuffer: options?.maxBuffer ?? 2 * 1024 * 1024,
        env: process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const details = [stderr, stdout].map((value) => trim(value)).filter(Boolean).join(" | ");
          reject(new Error(details ? `${file} failed: ${details}` : `${file} failed: ${err.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function sendTelegramVoiceDirect(params: {
  api: OpenClawPluginApi;
  accountId?: string;
  to?: string;
  conversationId?: string;
  voicePath: string;
}): Promise<{ messageId?: string }> {
  const token = await resolveTelegramBotToken(params.accountId);
  if (!token) throw new Error("Telegram bot token not found for voice send");

  const target = resolveTelegramChatTarget(params.to, params.conversationId);
  if (!target?.chatId) throw new Error("Telegram chat target could not be resolved for voice send");

  const url = `https://api.telegram.org/bot${token}/sendVoice`;
  const args = [
    "-sS",
    "--fail-with-body",
    "--connect-timeout",
    "15",
    "--max-time",
    "90",
    "-X",
    "POST",
    url,
    "-F",
    `chat_id=${target.chatId}`,
    "-F",
    `voice=@${params.voicePath};type=audio/ogg`,
  ];
  if (typeof target.messageThreadId === "number" && Number.isFinite(target.messageThreadId)) {
    args.push("-F", `message_thread_id=${target.messageThreadId}`);
  }

  const { stdout } = await runExecFile("curl", args);
  const parsed = tryParseJsonRecord(trim(stdout));
  if (!parsed || parsed.ok !== true) {
    throw new Error(`Telegram sendVoice API failed: ${trim(stdout) || "invalid response"}`);
  }

  const result = parsed.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const messageId = result.message_id;
    if (typeof messageId === "number" || typeof messageId === "string") {
      return { messageId: String(messageId) };
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Engine: Gemini TTS
// ---------------------------------------------------------------------------

async function synthesizeGemini(
  apiKey: string,
  text: string,
  voice: string,
  model: string,
  style = "",
): Promise<Buffer> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildGeminiSpeechPrompt(text, style) }] }],
        generationConfig: {
          response_modalities: ["AUDIO"],
          speech_config: {
            voice_config: { prebuilt_voice_config: { voice_name: voice } },
          },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini TTS failed (${res.status}): ${await res.text()}`);

  const data = (await res.json()) as GeminiResponse;
  if (data.error) throw new Error(`Gemini TTS error: ${data.error.message}`);

  const audioData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!audioData) throw new Error("Gemini TTS returned no audio data");
  return Buffer.from(audioData, "base64");
}

async function synthesizeGeminiWithRetry(
  api: OpenClawPluginApi,
  apiKey: string,
  text: string,
  voice: string,
  model: string,
  style = "",
): Promise<Buffer> {
  let attempt = 0;
  while (true) {
    try {
      return await synthesizeGemini(apiKey, text, voice, model, style);
    } catch (error) {
      if (attempt >= GEMINI_TTS_RETRY_DELAYS_MS.length || !isRetryableGeminiTtsError(error)) {
        throw error;
      }
      const delayMs = GEMINI_TTS_RETRY_DELAYS_MS[attempt];
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn(`[google-tts] Gemini TTS attempt ${attempt + 1} failed; retrying in ${delayMs}ms: ${message}`);
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Engine: Cloud TTS
// ---------------------------------------------------------------------------

async function synthesizeCloud(
  accessToken: string,
  text: string,
  lang: string,
  voice: string,
): Promise<Buffer> {
  const voiceSpec: Record<string, string> = { languageCode: lang };
  if (voice) voiceSpec.name = voice;

  const res = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      input: { text },
      voice: voiceSpec,
      audioConfig: { audioEncoding: "MP3" },
    }),
  });
  if (!res.ok) throw new Error(`Cloud TTS failed (${res.status}): ${await res.text()}`);

  const data = (await res.json()) as SynthesizeResponse;
  if (!data.audioContent) throw new Error("Cloud TTS returned no audioContent");
  return Buffer.from(data.audioContent, "base64");
}

// ---------------------------------------------------------------------------
// Voice listing
// ---------------------------------------------------------------------------

function formatVoices(voices: GoogleVoice[], langCode?: string): string {
  const filtered = langCode
    ? voices.filter((v) => (v.languageCodes || []).includes(langCode))
    : voices;
  const top = filtered.slice(0, 30);
  const lines = [`Cloud TTS voices: ${filtered.length}`, ""];
  for (const voice of top) {
    lines.push(`- ${voice.name || "(unnamed)"}`);
    lines.push(`  languages: ${(voice.languageCodes || []).join(", ") || "-"}`);
    lines.push(`  gender: ${voice.ssmlGender || "-"}`);
  }
  if (filtered.length > top.length) {
    lines.push("", `(showing first ${top.length})`);
  }
  lines.push("", "Gemini TTS voices (multi-language):");
  for (const v of GEMINI_VOICES) lines.push(`- ${v}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin = {
  id: "google-tts",
  name: "Google TTS",
  description: "Google TTS with Gemini and Cloud engines",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const isAutoVoiceAccountEnabled = (accountId?: string): boolean => {
      const normalized = normalizeAutoVoiceAccountId(accountId);
      return Boolean(normalized) && new Set(getAutoVoiceAccountIds()).has(normalized);
    };
    const pendingAutoVoiceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const inFlightAutoVoice = new Set<string>();
    const recentAutoVoiceRuns = new Map<string, number>();
    const recentSlashCommandReplySkips = new Map<string, { count: number; expiresAt: number }>();

    const resolveStateParamsFromCommand = (ctx: {
      channel?: string;
      channelId?: string;
      accountId?: string;
      from?: string;
      to?: string;
      messageThreadId?: number;
    }) => ({
      channelId: trim(ctx.channelId) || trim(ctx.channel),
      accountId: trim(ctx.accountId) || undefined,
      conversationId: resolveCommandConversationId(ctx),
    });

    const resolveStateParamsFromHook = (ctx: {
      channelId?: string;
      accountId?: string;
      conversationId?: string;
    }, eventTo?: string) => ({
      channelId: trim(ctx.channelId),
      accountId: trim(ctx.accountId) || undefined,
      conversationId: trim(ctx.conversationId) || trim(eventTo) || undefined,
    });

    const resolveStateParamsFromInbound = (ctx: {
      channelId?: string;
      accountId?: string;
      conversationId?: string;
    }, eventFrom?: string) => ({
      channelId: trim(ctx.channelId),
      accountId: trim(ctx.accountId) || undefined,
      conversationId: trim(ctx.conversationId) || trim(eventFrom) || undefined,
    });

    const buildAutoVoiceSignature = (ctx: {
      channelId?: string;
      accountId?: string;
      conversationId?: string;
    }, eventTo: string, content: string) => {
      const channelId = trim(ctx.channelId);
      const accountId = trim(ctx.accountId);
      const conversationId = normalizeConversationId(trim(ctx.conversationId) || trim(eventTo), channelId);
      return `${channelId}::${accountId}::${conversationId}::${content}`;
    };

    const pruneRecentAutoVoiceRuns = () => {
      const cutoff = Date.now() - AUTO_VOICE_RECENT_TTL_MS;
      for (const [signature, timestamp] of recentAutoVoiceRuns.entries()) {
        if (timestamp < cutoff) recentAutoVoiceRuns.delete(signature);
      }
    };

    const pruneRecentSlashCommandReplySkips = () => {
      const now = Date.now();
      for (const [key, entry] of recentSlashCommandReplySkips.entries()) {
        if (!entry || entry.count <= 0 || entry.expiresAt <= now) {
          recentSlashCommandReplySkips.delete(key);
        }
      }
    };

    const markRecentSlashCommandReplySkip = (
      params: { channelId?: string; accountId?: string; conversationId?: string },
    ) => {
      const key = buildVoiceScopeKey(params);
      if (!key) return;
      pruneRecentSlashCommandReplySkips();
      const existing = recentSlashCommandReplySkips.get(key);
      recentSlashCommandReplySkips.set(key, {
        count: (existing?.count || 0) + 1,
        expiresAt: Date.now() + AUTO_VOICE_SLASH_COMMAND_SKIP_TTL_MS,
      });
      api.logger.info(`[google-tts] marked slash-command auto voice skip key=${key}`);
    };

    const consumeRecentSlashCommandReplySkip = (
      params: { channelId?: string; accountId?: string; conversationId?: string },
    ): boolean => {
      const key = buildVoiceScopeKey(params);
      if (!key) return false;
      pruneRecentSlashCommandReplySkips();
      const entry = recentSlashCommandReplySkips.get(key);
      if (!entry || entry.count <= 0) return false;
      if (entry.count <= 1) recentSlashCommandReplySkips.delete(key);
      else {
        recentSlashCommandReplySkips.set(key, {
          count: entry.count - 1,
          expiresAt: entry.expiresAt,
        });
      }
      return true;
    };

    const hasRecentSlashCommandReplySkip = (
      params: { channelId?: string; accountId?: string; conversationId?: string },
    ): boolean => {
      const key = buildVoiceScopeKey(params);
      if (!key) return false;
      pruneRecentSlashCommandReplySkips();
      const entry = recentSlashCommandReplySkips.get(key);
      return Boolean(entry && entry.count > 0);
    };

    const clearPendingAutoVoice = (signature: string) => {
      const timer = pendingAutoVoiceTimers.get(signature);
      if (!timer) return;
      clearTimeout(timer);
      pendingAutoVoiceTimers.delete(signature);
    };

    const bumpSkipCount = async (
      params: { channelId?: string; accountId?: string; conversationId?: string },
      mutate?: (current: VoiceReplyState) => VoiceReplyState,
    ) => {
      return await updateVoiceReplyState(params, (current) => {
        const next = mutate ? mutate(current) : { ...current };
        return {
          ...next,
          skipNextOutboundCount: (next.skipNextOutboundCount || 0) + 1,
          updatedAt: Date.now(),
        };
      });
    };

    const registerVoiceCommand = (
      name: string,
      description: string,
      nativeNames: (Partial<Record<string, string>> & { default?: string }) | undefined,
      handler: (ctx: {
        channel?: string;
        channelId?: string;
        accountId?: string;
        from?: string;
        to?: string;
        args?: string;
        messageThreadId?: number;
      }) => Promise<{ text: string }>,
    ) => {
      api.registerCommand({
        name,
        description,
        ...(nativeNames ? { nativeNames } : {}),
        acceptsArgs: true,
        handler: async (ctx) => {
          if (!isAutoVoiceAccountEnabled(ctx.accountId)) {
            return {
              text:
                "这个语音命令当前未对这个 bot 开启。请在 google-tts 的 voice-config.json 里把对应 accountId 加入 autoVoiceAccounts。",
            };
          }
          return await handler(ctx);
        },
      });
    };

    registerVoiceCommand("autovoice", "Toggle Telegram voice bubble replies for the current chat", void 0, async (ctx) => {
      const params = resolveStateParamsFromCommand(ctx);
      const stateKey = buildVoiceStateKey(params) ?? buildLegacyVoiceStateKey(params) ?? "<missing>";
      api.logger.info(
        `[google-tts] /autovoice invoked channel=${trim(ctx.channelId) || trim(ctx.channel)} ` +
        `account=${trim(ctx.accountId) || "-"} from=${trim(ctx.from) || "-"} ` +
        `to=${trim(ctx.to) || "-"} thread=${ctx.messageThreadId ?? "-"} key=${stateKey} ` +
        `args=${JSON.stringify(trim(ctx.args))}`,
      );
      const mode = lower(ctx.args);
      const current = await readVoiceReplyState(params);
      const enabled =
        mode === "status"
          ? current.enabled === true
          : mode === "on"
            ? true
            : mode === "off"
              ? false
              : !(current.enabled === true);
      const updated = await bumpSkipCount(params, (state) => ({
        ...state,
        enabled,
      }));
      if (mode === "status") {
        return {
          text: updated?.enabled
            ? "🎙️ 当前语音模式：已开启"
            : "🎙️ 当前语音模式：已关闭",
        };
      }
      return {
        text: enabled
          ? "🎙️ 语音模式已开启"
          : "🎙️ 语音模式已关闭",
      };
    });

    registerVoiceCommand("voice_style", "Set or inspect the current chat voice style", void 0, async (ctx) => {
      const params = resolveStateParamsFromCommand(ctx);
      const stateKey = buildVoiceStateKey(params) ?? buildLegacyVoiceStateKey(params) ?? "<missing>";
      api.logger.info(
        `[google-tts] /voice_style invoked channel=${trim(ctx.channelId) || trim(ctx.channel)} ` +
        `account=${trim(ctx.accountId) || "-"} from=${trim(ctx.from) || "-"} ` +
        `to=${trim(ctx.to) || "-"} thread=${ctx.messageThreadId ?? "-"} key=${stateKey} ` +
        `args=${JSON.stringify(trim(ctx.args))}`,
      );
      const raw = trim(ctx.args);
      if (!raw) {
        const current = await bumpSkipCount(params);
        return {
          text: `🎛️ 当前语音风格：${getEffectiveStyle(current ?? {}, ctx.accountId)}`,
        };
      }
      if (isResetKeyword(raw)) {
        await bumpSkipCount(params, (state) => ({
          ...state,
          style: undefined,
        }));
        return { text: "🎛️ 语音风格已恢复账号默认" };
      }
      const updated = await bumpSkipCount(params, (state) => ({
        ...state,
        style: raw,
      }));
      return {
        text: `🎛️ 语音风格已更新：${trim(updated?.style) || raw}`,
      };
    });

    const handleVoiceVoiceCommand = async (ctx: {
      channel?: string;
      channelId?: string;
      accountId?: string;
      from?: string;
      to?: string;
      args?: string;
      messageThreadId?: number;
    }) => {
      const params = resolveStateParamsFromCommand(ctx);
      const stateKey = buildVoiceStateKey(params) ?? buildLegacyVoiceStateKey(params) ?? "<missing>";
      api.logger.info(
        `[google-tts] /voice_voice invoked channel=${trim(ctx.channelId) || trim(ctx.channel)} ` +
        `account=${trim(ctx.accountId) || "-"} from=${trim(ctx.from) || "-"} ` +
        `to=${trim(ctx.to) || "-"} thread=${ctx.messageThreadId ?? "-"} key=${stateKey} ` +
        `args=${JSON.stringify(trim(ctx.args))}`,
      );
      const raw = trim(ctx.args);
      if (!raw) {
        const current = await bumpSkipCount(params);
        return {
          text: [
            `🎚️ 当前语音声线：${getEffectiveVoice(current ?? {}, ctx.accountId)}`,
            `可选：${GEMINI_VOICES.join(", ")}`,
          ].join("\n"),
        };
      }
      if (isResetKeyword(raw)) {
        await bumpSkipCount(params, (state) => ({
          ...state,
          voice: undefined,
        }));
        return { text: `🎚️ 语音声线已恢复默认：${getConfiguredDefaultVoice(ctx.accountId)}` };
      }
      const nextVoice = normalizeGeminiVoice(raw);
      if (!nextVoice) {
        await bumpSkipCount(params);
        return { text: `当前 voice 不可用，可选：${GEMINI_VOICES.join(", ")}` };
      }
      const updated = await bumpSkipCount(params, (state) => ({
        ...state,
        voice: nextVoice,
      }));
      return {
        text: `🎚️ 语音声线已更新：${trim(updated?.voice) || nextVoice}`,
      };
    };

    registerVoiceCommand("voice_voice", "Set or inspect the current chat voice name", void 0, handleVoiceVoiceCommand);
    registerVoiceCommand("voicevoice", "Alias for /voice_voice", void 0, handleVoiceVoiceCommand);
    registerVoiceCommand("voicev", "Alias for /voice_voice", void 0, handleVoiceVoiceCommand);

    api.on("message_received", (event, ctx) => {
      if (trim(ctx.channelId) !== "telegram" || !isAutoVoiceAccountEnabled(ctx.accountId)) return;
      if (!isSlashCommandLike(event.content)) return;
      const commandName = extractSlashCommandName(event.content);
      if (PLUGIN_SKIP_COUNT_COMMANDS.has(commandName)) return;
      const params = resolveStateParamsFromInbound(ctx, event.from);
      const key = buildVoiceScopeKey(params);
      if (!key) return;
      markRecentSlashCommandReplySkip(params);
      api.logger.info(
        `[google-tts] message_received slash command detected account=${trim(ctx.accountId) || "-"} ` +
        `from=${trim(event.from) || "-"} key=${key} command=${commandName || "-"} ` +
        `content=${JSON.stringify(trim(event.content))}`,
      );
    });

    const runAutoVoice = async (
      source: "message_sent" | "message_sending_fallback",
      event: { to: string; content: string },
      ctx: { channelId?: string; accountId?: string; conversationId?: string },
    ) => {
      if (trim(ctx.channelId) !== "telegram") return;
      if (!isAutoVoiceAccountEnabled(ctx.accountId)) return;
      const content = trim(event.content);
      if (!content) return;

      pruneRecentAutoVoiceRuns();
      const signature = buildAutoVoiceSignature(ctx, event.to, content);
      if (recentAutoVoiceRuns.has(signature) || inFlightAutoVoice.has(signature)) return;

      const params = resolveStateParamsFromHook(ctx, event.to);
      const stateKey = buildVoiceScopeKey(params) ?? "<missing>";
      api.logger.info(
        `[google-tts] ${source} to=${trim(event.to) || "-"} conv=${trim(ctx.conversationId) || "-"} ` +
        `account=${trim(ctx.accountId) || "-"} key=${stateKey} textLen=${content.length}`,
      );

      const shouldSkipForSlashCommand =
        source === "message_sending_fallback"
          ? hasRecentSlashCommandReplySkip(params)
          : consumeRecentSlashCommandReplySkip(params);
      if (shouldSkipForSlashCommand) {
        api.logger.info(`[google-tts] ${source} skipping auto voice after slash-command reply key=${stateKey}`);
        return;
      }

      const current = await readVoiceReplyState(params);
      if ((current.skipNextOutboundCount || 0) > 0) {
        api.logger.info(
          `[google-tts] ${source} skipNextOutboundCount=${current.skipNextOutboundCount} key=${stateKey}`,
        );
        await updateVoiceReplyState(params, (state) => ({
          ...state,
          skipNextOutboundCount: Math.max(0, (state.skipNextOutboundCount || 0) - 1),
          updatedAt: state.updatedAt,
        }));
        return;
      }
      if (current.enabled !== true) {
        api.logger.info(`[google-tts] ${source} voice disabled for key=${stateKey}`);
        return;
      }

      const extracted = extractSpeechText(content);
      if (!extracted.text) {
        if (extracted.skipReason === "json_without_response") {
          api.logger.info(`[google-tts] ${source} skipping auto voice for JSON reply without response field`);
        } else if (extracted.skipReason === "meta_reply") {
          api.logger.info(`[google-tts] ${source} skipping auto voice for command/meta reply`);
        }
        return;
      }

      const apiKey = await resolveGeminiApiKey(api);
      if (!apiKey) {
        api.logger.warn(`[google-tts] ${source} auto voice skipped: Gemini API key not configured`);
        return;
      }

      inFlightAutoVoice.add(signature);
      try {
        await mkdir(OUT_DIR, { recursive: true });
        const ts = Date.now();
        const pcmPath = path.join(OUT_DIR, `gtts-${ts}.pcm`);
        const oggPath = path.join(OUT_DIR, `gtts-${ts}.ogg`);
        const voice = getEffectiveVoice(current, ctx.accountId);
        const style = getEffectiveStyle(current, ctx.accountId);
        const model = getAutoVoiceModel();
        api.logger.info(
          `[google-tts] ${source} auto voice synth start key=${stateKey} voice=${voice} ` +
          `model=${model} styleLen=${style.length} speechLen=${extracted.text.length}`,
        );
        const pcmBuf = await synthesizeGeminiWithRetry(
          api,
          apiKey,
          extracted.text,
          voice,
          model,
          style,
        );
        await writeFile(pcmPath, pcmBuf);
        await pcmToOggOpus(pcmPath, oggPath);
        try {
          const result = await sendTelegramVoiceDirect({
            api,
            accountId: trim(ctx.accountId) || undefined,
            to: event.to,
            conversationId: ctx.conversationId,
            voicePath: oggPath,
          });
          api.logger.info(
            `[google-tts] ${source} auto voice direct send ok key=${stateKey} ` +
            `file=${path.basename(oggPath)} message=${trim(result.messageId) || "-"}`,
          );
        } catch (directError) {
          api.logger.warn(
            `[google-tts] ${source} direct voice send failed; falling back to runtime sender: ` +
            `${directError instanceof Error ? directError.message : String(directError)}`,
          );
          await api.runtime.channel.telegram.sendMessageTelegram(event.to, "", {
            accountId: trim(ctx.accountId) || undefined,
            mediaUrl: oggPath,
            mediaLocalRoots: [OUT_DIR],
            asVoice: true,
          });
        }
        recentAutoVoiceRuns.set(signature, Date.now());
        api.logger.info(`[google-tts] ${source} auto voice send ok key=${stateKey} file=${path.basename(oggPath)}`);
      } catch (error) {
        api.logger.warn(
          `[google-tts] ${source} auto voice send failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        inFlightAutoVoice.delete(signature);
      }
    };

    api.on("message_sending", (event, ctx) => {
      if (trim(ctx.channelId) !== "telegram" || !isAutoVoiceAccountEnabled(ctx.accountId)) return;
      const content = trim(event.content);
      if (!content) return;
      const signature = buildAutoVoiceSignature(ctx, event.to, content);
      if (pendingAutoVoiceTimers.has(signature) || inFlightAutoVoice.has(signature)) return;
      api.logger.info(`[google-tts] message_sending scheduled fallback auto voice`);
      const timer = setTimeout(() => {
        pendingAutoVoiceTimers.delete(signature);
        void runAutoVoice("message_sending_fallback", event, ctx);
      }, AUTO_VOICE_FALLBACK_DELAY_MS);
      pendingAutoVoiceTimers.set(signature, timer);
    });

    api.on("message_sent", async (event, ctx) => {
      if (trim(ctx.channelId) !== "telegram" || !isAutoVoiceAccountEnabled(ctx.accountId) || event.success !== true) return;
      const content = trim(event.content);
      if (!content) return;
      const signature = buildAutoVoiceSignature(ctx, event.to, content);
      clearPendingAutoVoice(signature);
      await runAutoVoice("message_sent", event, ctx);
    });

    api.registerCommand({
      name: "gtts",
      description:
        "TTS: say [--engine gemini|cloud] [--voice name] [--pro|--flash] <text>",
      acceptsArgs: true,
      handler: async (ctx) => {
        await bumpSkipCount(resolveStateParamsFromCommand(ctx));
        const args = trim(ctx.args);
        const [subcommand = "status", ...rest] = splitCommandArgs(args);

        // --- status ---
        if (subcommand === "status") {
          const geminiKey = await resolveGeminiApiKey(api);
          const cloudToken = await resolveCloudAuth(api);
          return {
            text: [
              "Google TTS status:",
              `- defaultEngine: ${DEFAULT_ENGINE}`,
              `- geminiModel: ${DEFAULT_GEMINI_MODEL}`,
              `- geminiVoice: ${DEFAULT_GEMINI_VOICE}`,
              `- geminiApiKey: ${geminiKey ? geminiKey.slice(0, 8) + "…" : "NOT SET"}`,
              `- cloudVoice: ${DEFAULT_CLOUD_VOICE}`,
              `- cloudAuth: ${cloudToken ? "ok (oauth)" : "NOT SET"}`,
              `- autoVoiceAccounts: ${getAutoVoiceAccountIds().join(", ")}`,
              `- autoVoiceModel: ${getAutoVoiceModel()}`,
              `- voiceConfigPath: ${VOICE_CONFIG_PATH}`,
              `- outDir: ${OUT_DIR}`,
            ].join("\n"),
          };
        }

        // --- defaults ---
        if (subcommand === "defaults") {
          return {
            text: [
              "Google TTS defaults:",
              `- engine: ${DEFAULT_ENGINE}`,
              `- geminiModel: ${DEFAULT_GEMINI_MODEL}`,
              `- autoVoiceModel: ${getAutoVoiceModel()}`,
              `- geminiVoice: ${DEFAULT_GEMINI_VOICE}`,
              `- autoVoiceAccounts: ${getAutoVoiceAccountIds().join(", ")}`,
              `- cloudLang: ${DEFAULT_CLOUD_LANG}`,
              `- cloudVoice: ${DEFAULT_CLOUD_VOICE}`,
              "",
              "Gemini voices: " + GEMINI_VOICES.join(", "),
              "",
              "Language aliases:",
              ...Object.entries(LANG_ALIASES).map(([k, v]) => `  ${k} -> ${v}`),
              "",
              "Gemini models:",
              "  gemini-2.5-flash-preview-tts  (fast, --flash)",
              "  gemini-2.5-pro-preview-tts    (quality, --pro)",
            ].join("\n"),
          };
        }

        // --- voices ---
        if (subcommand === "voices") {
          const cloudToken = await resolveCloudAuth(api);
          if (!cloudToken) {
            return {
              text: [
                "Cloud TTS not configured (need OAuth). Gemini TTS voices:",
                "",
                ...GEMINI_VOICES.map((v) => `- ${v}`),
                "",
                "Gemini voices are multi-language — no lang code needed.",
              ].join("\n"),
            };
          }
          const rawLang = trim(rest[0]) || undefined;
          const langCode = rawLang ? resolveLang(rawLang) : undefined;
          const res = await fetch("https://texttospeech.googleapis.com/v1/voices", {
            headers: { authorization: `Bearer ${cloudToken}` },
          });
          if (!res.ok) throw new Error(`Cloud TTS voices failed: ${await res.text()}`);
          const data = (await res.json()) as VoicesResponse;
          return { text: formatVoices(data.voices || [], langCode) };
        }

        // --- say ---
        if (subcommand === "say") {
          const parsed = parseSayArgs(rest);
          if (!parsed.text) {
            return {
              text: [
                "Usage: /gtts say [flags] <text>",
                "",
                "Flags:",
                "  --engine, -e   gemini (default) | cloud",
                "  --voice, -v    voice name (Leda, Kore, Puck, cmn-CN-Wavenet-A...)",
                "  --style, -s    Gemini speech style instruction",
                "  --lang, -l     language code for cloud engine",
                "  --pro          use gemini-2.5-pro-preview-tts",
                "  --flash        use gemini-2.5-flash-preview-tts (default)",
                "  --model, -m    explicit model name",
              ].join("\n"),
            };
          }

          await mkdir(OUT_DIR, { recursive: true });
          const ts = Date.now();
          let engineLabel: string;

          if (parsed.engine === "gemini") {
            const apiKey = await resolveGeminiApiKey(api);
            if (!apiKey) {
              return { text: "Gemini API key not found. Set GOOGLE_API_KEY or configure google:default auth profile." };
            }

            const geminiVoice = parsed.voiceExplicit ? parsed.voice : getConfiguredDefaultVoice(ctx.accountId);
            const geminiStyle = parsed.style || getConfiguredDefaultStyle(ctx.accountId);
            const pcmBuf = await synthesizeGeminiWithRetry(api, apiKey, parsed.text, geminiVoice, parsed.model, geminiStyle);
            const pcmPath = path.join(OUT_DIR, `gtts-${ts}.pcm`);
            const mp3Path = path.join(OUT_DIR, `gtts-${ts}.mp3`);
            await writeFile(pcmPath, pcmBuf);
            await pcmToMp3(pcmPath, mp3Path);

            engineLabel = `${parsed.model}:${geminiVoice}`;
            return {
              text: `${engineLabel} · ${parsed.text.length} chars`,
              mediaUrl: mp3Path,
              audioAsVoice: true,
            };
          }

          // cloud engine
          const cloudToken = await resolveCloudAuth(api);
          if (!cloudToken) {
            return { text: "Cloud TTS not configured. Run: node src/oauth-setup.mjs" };
          }

          const mp3Buf = await synthesizeCloud(cloudToken, parsed.text, parsed.lang, parsed.voice);
          const mp3Path = path.join(OUT_DIR, `gtts-${ts}.mp3`);
          await writeFile(mp3Path, mp3Buf);

          engineLabel = `cloud:${parsed.voice || parsed.lang}`;
          return {
            text: `${engineLabel} · ${parsed.text.length} chars`,
            mediaUrl: mp3Path,
            audioAsVoice: true,
          };
        }

        // --- help ---
        return {
          text: [
            "Google TTS commands:",
            "",
            "/gtts say <text>             - Gemini TTS (default)",
            "/gtts say --pro <text>       - Gemini Pro (higher quality)",
            "/gtts say -e cloud <text>    - Cloud TTS (Wavenet/Chirp)",
            "/gtts say -v Leda <text>     - change voice",
            "/gtts say --style '温柔一点' <text> - change speaking style",
            "/gtts voices [lang]          - list voices",
            "/gtts defaults              - show config",
            "/gtts status                - auth info",
          ].join("\n"),
        };
      },
    });

    // -----------------------------------------------------------------------
    // Agent tool: gtts — lets the AI agent call Gemini Pro TTS directly
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "gtts",
      label: "Google Gemini TTS",
      description:
        "Convert text to speech using Google Gemini Pro TTS. Returns a voice message. Use this tool when voice mode is enabled to send the AI-generated response as audio.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to convert to speech (must be the AI's own response, never the user's raw message)" },
          voice: { type: "string", description: "Gemini voice name (default: Leda). Options: Aoede, Charon, Fenrir, Kore, Puck, Achernar, Gacrux, Leda, Orus, Zephyr" },
          style: { type: "string", description: "Optional speaking style instruction for Gemini Pro TTS. Example: 温柔、专业的心理咨询师口吻，像面对面聊天，不要像读稿。" },
        },
        required: ["text"],
      } as any,
      async execute(_toolCallId: string, params: { text: string; voice?: string; style?: string }) {
        const text = (params.text || "").trim();
        if (!text) {
          return {
            content: [{ type: "text" as const, text: "Error: no text provided" }],
            details: { error: "no text" },
          };
        }

        const apiKey = await resolveGeminiApiKey(api);
        if (!apiKey) {
          return {
            content: [{ type: "text" as const, text: "Gemini API key not found. Set GOOGLE_API_KEY or add gemini_api_key to google-tts-tokens.json." }],
            details: { error: "no api key" },
          };
        }

        const voice = params.voice || DEFAULT_GEMINI_VOICE;
        const style = trim(params.style) || DEFAULT_GEMINI_STYLE;
        const model = "gemini-2.5-pro-preview-tts";

        await mkdir(OUT_DIR, { recursive: true });
        const ts = Date.now();
        const pcmPath = path.join(OUT_DIR, `gtts-${ts}.pcm`);
        const mp3Path = path.join(OUT_DIR, `gtts-${ts}.mp3`);

        const pcmBuf = await synthesizeGeminiWithRetry(api, apiKey, text, voice, model, style);
        await writeFile(pcmPath, pcmBuf);
        await pcmToMp3(pcmPath, mp3Path);

        return {
          content: [{ type: "text" as const, text: `[[audio_as_voice]]\nMEDIA:${mp3Path}` }],
          details: { audioPath: mp3Path, provider: "gemini-pro", voice, style, chars: text.length },
        };
      },
    });
  },
};

export default plugin;
