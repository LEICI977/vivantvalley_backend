import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";

loadDotEnv();

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: positiveInt(process.env.PORT, 8787),
  dataFile: path.resolve(process.cwd(), process.env.DATA_FILE || "./data/db.json"),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  sessionTtlMs: positiveInt(process.env.SESSION_TTL_DAYS, 14) * 86_400_000,
  demoMode: process.env.DEMO_MODE !== "false",
  upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || "https://api.deepseek.com",
  upstreamApiKey: process.env.UPSTREAM_API_KEY || "",
  upstreamModel: process.env.UPSTREAM_MODEL || "deepseek-chat",
  pepper: process.env.BACKEND_PEPPER || "demo-pepper-change-me",
  adminPagePassword: process.env.ADMIN_PAGE_PASSWORD || "",
  invitationRequired: process.env.INVITATION_REQUIRED === "true",
  requestTimeoutMs: positiveInt(process.env.REQUEST_TIMEOUT_MS, 90_000),
  maxBodyBytes: positiveInt(process.env.MAX_BODY_BYTES, 1_048_576),
  rateLimitPerMinute: positiveInt(process.env.RATE_LIMIT_PER_MINUTE, 60),
};

const CARD_VALUE_MICROS_PER_YUAN = 1_000_000;
const CARD_BATCH_COUNT = 100;
const CARD_DENOMINATIONS_YUAN = new Set([1, 5, 10, 20]);

if (config.pepper === "demo-pepper-change-me") {
  console.warn("WARNING: BACKEND_PEPPER is using the demo value; change it before production use.");
}
if (!config.adminPagePassword) {
  console.warn("WARNING: ADMIN_PAGE_PASSWORD is empty; the extra administrator page gate is disabled.");
} else if (config.adminPagePassword.length < 16) {
  console.warn("WARNING: ADMIN_PAGE_PASSWORD should contain at least 16 characters.");
}

const rateBuckets = new Map();
const activeRequests = new Map();
const adminGateAttempts = new Map();
const upstreamNonThinkingModes = new Map();
const startedAt = Date.now();
let db = loadDatabase();
seedDatabase();
persistDatabase();

function loadDotEnv() {
  try {
    const contents = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || Object.hasOwn(process.env, match[1])) continue;
      let value = match[2];
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch {
    // .env is optional when variables are injected by the process manager.
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function now() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] || "";
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function keyHash(value) {
  return crypto.createHmac("sha256", config.pepper).update(value).digest("hex");
}

function secretKey() {
  return crypto.createHash("sha256").update(`vivant-valley-provider-secrets:${config.pepper}`).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

function decryptSecret(encoded) {
  const parts = String(encoded || "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("provider secret format is invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(parts[1], "hex"));
  decipher.setAuthTag(Buffer.from(parts[2], "hex"));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "hex")), decipher.final()]).toString("utf8");
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "未配置";
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function timingSafeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""), "utf8");
  const expectedBuffer = Buffer.from(String(expected || ""), "utf8");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function adminGateToken() {
  if (!config.adminPagePassword) return "";
  return crypto.createHmac("sha256", config.pepper).update(`admin-page:${config.adminPagePassword}`).digest("base64url");
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const actual = crypto.scryptSync(password, parts[1], 64);
    const expected = Buffer.from(parts[2], "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function emptyDatabase() {
  return {
    version: 1,
    users: [],
    sessions: [],
    deviceKeys: [],
    wallets: [],
    ledger: [],
    requests: [],
    redeemCodes: [],
    redeemBatches: [],
    providers: [],
    modelAliases: [],
    settings: { invitationRequired: config.invitationRequired, demoMode: config.demoMode },
  };
}

function loadDatabase() {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.dataFile, "utf8"));
    const fresh = emptyDatabase();
    const loaded = { ...fresh, ...parsed, settings: { ...fresh.settings, ...(parsed.settings || {}) } };
    if (!Array.isArray(loaded.providers)) loaded.providers = [];
    if (!Array.isArray(loaded.modelAliases)) loaded.modelAliases = [];
    if (!Array.isArray(loaded.redeemBatches)) loaded.redeemBatches = [];
    return loaded;
  } catch {
    return emptyDatabase();
  }
}

function persistDatabase() {
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  const temporary = `${config.dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, config.dataFile);
}

function seedDatabase() {
  if (!db.modelAliases.length) {
    db.modelAliases = [
      { alias: "vv-dialogue", providerId: null, providerModel: config.upstreamModel, enabled: true, maxInputTokens: 16_000, maxOutputTokens: 2_048, inputMicrosPer1k: 1_400, outputMicrosPer1k: 2_800, cachedInputMicrosPer1k: 350 },
      { alias: "vv-fast", providerId: null, providerModel: config.upstreamModel, enabled: true, maxInputTokens: 8_000, maxOutputTokens: 1_024, inputMicrosPer1k: 700, outputMicrosPer1k: 1_400, cachedInputMicrosPer1k: 175 },
    ];
  }
  for (const model of db.modelAliases) if (!Object.hasOwn(model, "providerId")) model.providerId = null;
  db.settings.invitationRequired = Boolean(db.settings.invitationRequired);
  db.settings.demoMode = Boolean(db.settings.demoMode);
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@example.com").trim().toLowerCase();
  if (!db.users.some((user) => user.email === adminEmail)) {
    const admin = { id: id(), email: adminEmail, passwordHash: passwordHash(process.env.ADMIN_PASSWORD || "change-this-admin-password"), role: "admin", status: "active", createdAt: now(), lastLoginAt: null };
    db.users.push(admin);
    db.wallets.push({ userId: admin.id, availableMicros: 0, reservedMicros: 0 });
    console.log(`Created demo administrator ${adminEmail}. Change ADMIN_PASSWORD before production use.`);
  }
}

function resolveEndpoint(base) {
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error("UPSTREAM_BASE_URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("UPSTREAM_BASE_URL must be a credential-free http(s) URL");
  }
  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname.toLowerCase().endsWith("/chat/completions")) pathname = pathname.slice(0, -"/chat/completions".length);
  parsed.pathname = `${pathname}/chat/completions`;
  return parsed;
}

function validateManagedBaseUrl(base) {
  let parsed;
  try { parsed = new URL(base); } catch { throw new Error("invalid provider URL"); }
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHosts.has(parsed.hostname))) throw new Error("managed provider URLs must use HTTPS");
  resolveEndpoint(base);
  return parsed;
}

function publicProvider(provider) {
  let keyHint = "未配置";
  if (provider.apiKeyCiphertext) {
    try { keyHint = maskSecret(decryptSecret(provider.apiKeyCiphertext)); } catch { keyHint = "已加密（不可读取）"; }
  }
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel || "",
    enabled: Boolean(provider.enabled),
    keyHint,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    lastCheckedAt: provider.lastCheckedAt || null,
    lastCheckStatus: provider.lastCheckStatus || null,
    source: "managed",
  };
}

function listAdminProviders() {
  const items = db.providers.map(publicProvider);
  items.unshift({
    id: null,
    name: "环境变量默认上游",
    baseUrl: config.upstreamBaseUrl,
    defaultModel: config.upstreamModel,
    enabled: true,
    keyHint: maskSecret(config.upstreamApiKey),
    createdAt: null,
    updatedAt: null,
    lastCheckedAt: null,
    lastCheckStatus: null,
    source: "environment",
  });
  return items;
}

function upstreamForAlias(alias) {
  if (!alias.providerId) {
    return { name: "环境变量默认上游", baseUrl: config.upstreamBaseUrl, endpoint: resolveEndpoint(config.upstreamBaseUrl), apiKey: config.upstreamApiKey, defaultModel: config.upstreamModel };
  }
  const provider = db.providers.find((value) => value.id === alias.providerId);
  if (!provider || !provider.enabled) throw httpError(503, "模型绑定的上游当前未启用。", "provider_disabled", "upstream_error");
  let apiKey;
  try { apiKey = decryptSecret(provider.apiKeyCiphertext); } catch { throw httpError(503, "模型绑定的上游密钥不可用。", "provider_secret_invalid", "upstream_error"); }
  if (!apiKey) throw httpError(503, "模型绑定的上游尚未配置 API Key。", "provider_not_configured", "upstream_error");
  return { name: provider.name, baseUrl: provider.baseUrl, endpoint: resolveEndpoint(provider.baseUrl), apiKey, defaultModel: provider.defaultModel || "" };
}

function runtimeMode() {
  const hasManagedKey = db.providers.some((provider) => provider.enabled && provider.apiKeyCiphertext);
  return db.settings.demoMode || (!config.upstreamApiKey && !hasManagedKey) ? "demo" : "upstream";
}

function demoModeEnabled() {
  return Boolean(db.settings.demoMode);
}

function findRedeemCode(rawCode, purpose = "credit") {
  const code = String(rawCode || "").trim();
  if (!code) return null;
  const candidates = [code];
  const upper = code.toUpperCase();
  if (upper !== code) candidates.push(upper);
  return db.redeemCodes.find((value) => candidates.some((candidate) => value.codeHash === hash(candidate))
    && (purpose === "invitation"
      ? !value.batchId && (!value.purpose || value.purpose === "invitation" || value.purpose === "general")
      : (!value.purpose || value.purpose === "credit" || value.purpose === "general"))
    && !value.disabledAt
    && value.usedCount < value.maxUses
    && (!value.expiresAt || new Date(value.expiresAt) > new Date()));
}

function consumeRedeemCode(code) {
  code.usedCount += 1;
  if (code.batchId) {
    const batch = db.redeemBatches.find((value) => value.id === code.batchId);
    if (batch) batch.usedCount = Math.min(batch.codeCount, Number(batch.usedCount || 0) + 1);
  }
}

function createCardCode(denominationYuan) {
  return `VV${denominationYuan}-${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
}

function publicRedeemBatch(batch) {
  return {
    id: batch.id,
    denomination_yuan: batch.denominationYuan,
    value_micros: batch.valueMicros,
    code_count: batch.codeCount,
    used_count: batch.usedCount || 0,
    remaining_count: Math.max(0, batch.codeCount - (batch.usedCount || 0)),
    expires_at: batch.expiresAt || null,
    disabled: Boolean(batch.disabledAt),
    created_at: batch.createdAt,
  };
}

function withNonThinkingMode(payload, mode) {
  const result = { ...payload };
  delete result.thinking;
  delete result.reasoning_effort;
  delete result.enable_thinking;
  if (mode === "enable_thinking_false") result.enable_thinking = false;
  if (mode === "thinking_disabled") result.thinking = { type: "disabled" };
  return result;
}

function canRetryNonThinkingMode(response, parsed) {
  if (response.status !== 400 && response.status !== 422) return false;
  const errorText = JSON.stringify(parsed?.error || parsed || "").toLowerCase();
  return errorText.includes("thinking");
}

async function postNonThinkingCompletion(endpoint, apiKey, payload, extraHeaders, signal) {
  const endpointKey = `${String(endpoint)}\n${String(payload.model || "")}`;
  const supportedModes = ["enable_thinking_false", "thinking_disabled", "omit"];
  const cachedMode = upstreamNonThinkingModes.get(endpointKey);
  const modes = cachedMode
    ? [cachedMode, ...supportedModes.filter((value) => value !== cachedMode)]
    : supportedModes;
  let lastResult;
  for (const mode of modes) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(withNonThinkingMode(payload, mode)),
      signal,
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch {}
    const result = { response, text, parsed, mode };
    if (response.ok) {
      upstreamNonThinkingModes.set(endpointKey, mode);
      return result;
    }
    lastResult = result;
    if (!canRetryNonThinkingMode(response, parsed)) break;
  }
  return lastResult;
}

async function probeProvider(provider) {
  let endpoint;
  try { endpoint = resolveEndpoint(provider.baseUrl); } catch { throw httpError(400, "上游地址无效。", "invalid_provider_url"); }
  let apiKey;
  try { apiKey = decryptSecret(provider.apiKeyCiphertext); } catch { throw httpError(503, "上游密钥不可用。", "provider_secret_invalid", "upstream_error"); }
  const boundAlias = db.modelAliases.find((value) => value.enabled && value.providerId === provider.id && String(value.providerModel || "").trim());
  const model = String(boundAlias?.providerModel || provider.defaultModel || "").trim();
  if (!model) throw httpError(400, "请先填写默认模型，或将一个已填写上游模型的模型别名绑定到该供应商。", "provider_model_required");
  const probeToolName = "vivant_valley_probe";
  const payload = {
    model,
    messages: [{ role: "user", content: "Call vivant_valley_probe with ok=true." }],
    tools: [{
      type: "function",
      function: {
        name: probeToolName,
        description: "Verify OpenAI-compatible tool calling.",
        parameters: {
          type: "object",
          properties: { ok: { type: "boolean", enum: [true] } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: { type: "function", function: { name: probeToolName } },
    stream: false,
    max_tokens: 64,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.requestTimeoutMs, 15_000));
  try {
    const result = await postNonThinkingCompletion(endpoint, apiKey, payload, {}, controller.signal);
    const { response, text, parsed } = result;
    if (parsed === undefined) throw invalidUpstreamJsonError(response, "provider_check_invalid_response");
    if (!response.ok) throw httpError(502, `上游返回 HTTP ${response.status}：${upstreamErrorMessage(parsed, "模型调用失败。")}`, "provider_check_failed", "upstream_error");
    const message = parsed?.choices?.[0]?.message;
    const call = Array.isArray(message?.tool_calls)
      ? message.tool_calls.find((value) => value?.function?.name === probeToolName)
      : null;
    if (!call) throw httpError(502, "上游虽然返回了 JSON，但没有按要求返回工具调用；当前模型不兼容 Mod 对话协议。", "provider_tool_call_unsupported", "upstream_error");
    const rawArguments = call.function.arguments;
    let argumentsValue;
    try { argumentsValue = typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments; } catch { throw httpError(502, "上游工具调用 arguments 不是有效 JSON。", "provider_tool_arguments_invalid", "upstream_error"); }
    if (!argumentsValue || argumentsValue.ok !== true) throw httpError(502, "上游工具调用没有返回有效的探测参数。", "provider_tool_arguments_invalid", "upstream_error");
    return { status: response.status, bodyBytes: Buffer.byteLength(text), model, protocol: "chat_completions_tool_call", nonThinkingMode: result.mode };
  } catch (error) {
    if (error.status) throw error;
    throw httpError(error.name === "AbortError" ? 408 : 502, error.name === "AbortError" ? "上游检测超时。" : "无法连接上游。", error.name === "AbortError" ? "provider_check_timeout" : "provider_unreachable", "upstream_error");
  } finally {
    clearTimeout(timer);
  }
}

function upstreamErrorMessage(parsed, fallback) {
  const message = parsed?.error?.message;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 500) : fallback;
}

function invalidUpstreamJsonError(response, code = "invalid_upstream_response") {
  const contentType = String(response.headers.get("content-type") || "未提供").split(";", 1)[0].trim().slice(0, 80) || "未提供";
  return httpError(
    502,
    `上游返回 HTTP ${response.status}，响应不是有效 JSON（Content-Type: ${contentType}）。请检查 Base URL、API Key 和上游网关状态。`,
    code,
    "upstream_error");
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function cookie(name, value, maxAge, httpOnly) {
  const flags = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (config.cookieSecure) flags.push("Secure");
  if (httpOnly) flags.push("HttpOnly");
  return flags.join("; ");
}

function appendCookie(res, value) {
  const existing = res.getHeader("set-cookie");
  const values = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader("set-cookie", [...values, value]);
}

function adminGatePassed(req) {
  if (!config.adminPagePassword) return true;
  return timingSafeStringEqual(parseCookies(req).vv_admin_gate, adminGateToken());
}

function adminGateAddress(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",", 1)[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function allowAdminGateAttempt(req) {
  const key = hash(adminGateAddress(req));
  const timestamp = Date.now();
  const current = adminGateAttempts.get(key);
  if (!current || current.resetAt <= timestamp) {
    adminGateAttempts.set(key, { failures: 0, resetAt: timestamp + 15 * 60_000 });
    return true;
  }
  return current.failures < 5;
}

function recordAdminGateFailure(req) {
  const key = hash(adminGateAddress(req));
  const timestamp = Date.now();
  const current = adminGateAttempts.get(key);
  if (!current || current.resetAt <= timestamp) adminGateAttempts.set(key, { failures: 1, resetAt: timestamp + 15 * 60_000 });
  else current.failures += 1;
}

function clearAdminGateFailures(req) {
  adminGateAttempts.delete(hash(adminGateAddress(req)));
}

function sendJson(res, status, payload, headers = {}) {
  if (status === 204) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", ...headers });
  res.end(body);
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self' 'unsafe-inline'; connect-src 'self'" });
  res.end(html);
}

function sendAsset(res, pathname) {
  const assets = {
    "/assets/user.css": { file: path.join(process.cwd(), "public/user.css"), type: "text/css; charset=utf-8", cache: "no-cache" },
    "/assets/auth.js": { file: path.join(process.cwd(), "public/auth.js"), type: "text/javascript; charset=utf-8", cache: "no-cache" },
    "/assets/app.js": { file: path.join(process.cwd(), "public/app.js"), type: "text/javascript; charset=utf-8", cache: "no-cache" },
    "/assets/auth-scene.jpg": { file: path.join(process.cwd(), "imagegen/auth-scene.jpg"), type: "image/jpeg", cache: "public, max-age=86400" },
    "/assets/vivant-logo.jpg": { file: path.join(process.cwd(), "imagegen/vivant-logo-crop.jpg"), type: "image/jpeg", cache: "public, max-age=86400" },
  };
  const asset = assets[pathname];
  if (!asset) return false;
  try {
    const body = fs.readFileSync(asset.file);
    res.writeHead(200, { "content-type": asset.type, "content-length": body.length, "cache-control": asset.cache });
    res.end(body);
  } catch {
    sendJson(res, 404, errorResponse("资源不存在。", "validation_error", "not_found"));
  }
  return true;
}

function errorResponse(message, type = "validation_error", code = "invalid_request", requestId = null) {
  return { error: { message, type, code, param: null, request_id: requestId } };
}

function requestId(req) {
  const supplied = String(req.headers["x-request-id"] || "").trim();
  return supplied.length > 0 && supplied.length <= 128 ? supplied : id();
}

function parseUrl(req) {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

async function readBody(req) {
  const declared = Number.parseInt(req.headers["content-length"] || "", 10);
  if (Number.isFinite(declared) && declared > config.maxBodyBytes) throw httpError(413, "request body too large", "request_too_large");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw httpError(413, "request body too large", "request_too_large");
    chunks.push(chunk);
  }
  if (!size) throw httpError(400, "request body is required", "invalid_json");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "request body must be valid JSON", "invalid_json");
  }
}

function httpError(status, message, code, type = status === 429 ? "rate_limit_error" : status === 402 ? "billing_error" : "validation_error") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.type = type;
  return error;
}

function publicUser(user) {
  const wallet = db.wallets.find((value) => value.userId === user.id) || { availableMicros: 0, reservedMicros: 0 };
  return { id: user.id, email: user.email, role: user.role, status: user.status, created_at: user.createdAt, last_login_at: user.lastLoginAt, wallet: { available_micros: wallet.availableMicros, reserved_micros: wallet.reservedMicros, currency: "credit_micros" } };
}

function session(req) {
  const token = bearerToken(req) || parseCookies(req).vv_session;
  if (!token) return null;
  const current = db.sessions.find((value) => value.tokenHash === hash(token) && new Date(value.expiresAt) > new Date());
  if (!current) return null;
  const user = db.users.find((value) => value.id === current.userId && value.status !== "deleted");
  return user ? { record: current, user } : null;
}

function startSession(res, user) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  db.sessions = db.sessions.filter((value) => new Date(value.expiresAt) > new Date());
  db.sessions.push({ id: id(), userId: user.id, tokenHash: hash(token), csrfHash: hash(csrf), createdAt: now(), lastSeenAt: now(), expiresAt: new Date(Date.now() + config.sessionTtlMs).toISOString() });
  persistDatabase();
  res.setHeader("set-cookie", [cookie("vv_session", token, Math.floor(config.sessionTtlMs / 1000), true), cookie("vv_csrf", csrf, Math.floor(config.sessionTtlMs / 1000), false)]);
  return csrf;
}

function startModSession(user) {
  const token = `vv_mod_${randomToken(32)}`;
  db.sessions = db.sessions.filter((value) => new Date(value.expiresAt) > new Date());
  const expiresAt = new Date(Date.now() + config.sessionTtlMs).toISOString();
  db.sessions.push({ id: id(), userId: user.id, tokenHash: hash(token), csrfHash: null, kind: "mod", createdAt: now(), lastSeenAt: now(), expiresAt });
  persistDatabase();
  return { token, expiresAt };
}

function requireSession(req, res, role = null) {
  const current = session(req);
  if (!current) {
    sendJson(res, 401, errorResponse("登录状态无效或已过期。", "auth_error", "invalid_session"));
    return null;
  }
  if (role && current.user.role !== role) {
    sendJson(res, 403, errorResponse("没有访问该页面的权限。", "forbidden_error", "admin_required"));
    return null;
  }
  return current;
}

function requireModSession(req) {
  const current = session(req);
  if (!current || current.record.kind !== "mod") {
    throw httpError(401, "托管账户会话无效或已过期。", "invalid_mod_session", "auth_error");
  }
  if (current.user.status !== "active") {
    throw httpError(403, "账户当前不可用。", "account_suspended", "forbidden_error");
  }
  current.record.lastSeenAt = now();
  return current;
}

function requireCsrf(req, current) {
  const provided = String(req.headers["x-csrf-token"] || "");
  return provided.length > 0 && provided.length === 32 && hash(provided) === current.record.csrfHash;
}

function device(req, res) {
  const header = String(req.headers.authorization || "");
  const modMatch = /^Bearer\s+(vv_mod_[A-Za-z0-9_-]{32,})$/i.exec(header.trim());
  if (modMatch) {
    const current = session(req);
    if (!current || current.record.kind !== "mod") {
      sendJson(res, 401, errorResponse("托管账户会话无效或已过期。", "auth_error", "invalid_mod_session"));
      return null;
    }
    if (current.user.status !== "active") {
      sendJson(res, 403, errorResponse("账户当前不可用。", "forbidden_error", "account_suspended"));
      return null;
    }
    current.record.lastSeenAt = now();
    return { key: { id: `mod:${current.record.id}` }, user: current.user, session: current.record };
  }
  const match = /^Bearer\s+(vv_live_[A-Za-z0-9_-]{32,})$/i.exec(header.trim());
  if (!match) {
    sendJson(res, 401, errorResponse("设备 Key 无效。", "auth_error", "invalid_device_key"));
    return null;
  }
  const key = db.deviceKeys.find((value) => value.keyHash === keyHash(match[1]) && !value.revokedAt && (!value.expiresAt || new Date(value.expiresAt) > new Date()));
  if (!key) {
    sendJson(res, 401, errorResponse("设备 Key 无效、已撤销或已过期。", "auth_error", "invalid_device_key"));
    return null;
  }
  const user = db.users.find((value) => value.id === key.userId);
  if (!user || user.status !== "active") {
    sendJson(res, 403, errorResponse("账户当前不可用。", "forbidden_error", "account_suspended"));
    return null;
  }
  key.lastUsedAt = now();
  return { key, user };
}

function checkRate(keyId) {
  const currentMinute = Math.floor(Date.now() / 60_000);
  const bucketKey = `${keyId}:${currentMinute}`;
  const count = (rateBuckets.get(bucketKey) || 0) + 1;
  rateBuckets.set(bucketKey, count);
  for (const [value] of rateBuckets) if (!value.endsWith(`:${currentMinute}`)) rateBuckets.delete(value);
  return count <= config.rateLimitPerMinute;
}

function getAlias(name) {
  return db.modelAliases.find((value) => value.alias === name && value.enabled);
}

function estimateTokens(messages) {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(messages || []), "utf8") / 4));
}

function costFor(usage, alias) {
  const prompt = Math.max(0, Number(usage.prompt_tokens || 0));
  const completion = Math.max(0, Number(usage.completion_tokens || 0));
  const cached = Math.min(prompt, Math.max(0, Number(usage.prompt_tokens_details?.cached_tokens || 0)));
  const billablePrompt = prompt - cached;
  return Math.ceil((billablePrompt * alias.inputMicrosPer1k + cached * alias.cachedInputMicrosPer1k + completion * alias.outputMicrosPer1k) / 1000);
}

function reserve(userId, amount, request) {
  const wallet = db.wallets.find((value) => value.userId === userId);
  if (!wallet || wallet.availableMicros < amount) throw httpError(402, "余额不足，请先充值或兑换额度。", "insufficient_balance", "billing_error");
  wallet.availableMicros -= amount;
  wallet.reservedMicros += amount;
  db.ledger.push({ id: id(), userId, kind: "reservation", amountMicros: -amount, balanceAfterMicros: wallet.availableMicros, requestId: request.id, createdAt: now(), metadata: { model_alias: request.modelAlias, reserved_micros: amount } });
}

function settle(userId, request, actual) {
  const wallet = db.wallets.find((value) => value.userId === userId);
  const reserved = request.reservedMicros;
  const release = Math.max(0, reserved - actual);
  wallet.reservedMicros = Math.max(0, wallet.reservedMicros - reserved);
  wallet.availableMicros += release;
  db.ledger.push({ id: id(), userId, kind: "settlement", amountMicros: 0, balanceAfterMicros: wallet.availableMicros, requestId: request.id, createdAt: now(), metadata: { charged_micros: actual, reserved_micros: reserved } });
  if (release > 0) db.ledger.push({ id: id(), userId, kind: "release", amountMicros: release, balanceAfterMicros: wallet.availableMicros, requestId: request.id, createdAt: now(), metadata: { reserved_micros: reserved, charged_micros: actual } });
}

function release(userId, request) {
  const wallet = db.wallets.find((value) => value.userId === userId);
  wallet.reservedMicros = Math.max(0, wallet.reservedMicros - request.reservedMicros);
  wallet.availableMicros += request.reservedMicros;
  db.ledger.push({ id: id(), userId, kind: "release", amountMicros: request.reservedMicros, balanceAfterMicros: wallet.availableMicros, requestId: request.id, createdAt: now(), metadata: { reason: "upstream_failure" } });
}

function normalizeResponse(response, alias, requestIdValue) {
  const result = response && typeof response === "object" ? response : {};
  result.id ||= `chatcmpl-${requestIdValue.replaceAll("-", "").slice(0, 24)}`;
  result.object ||= "chat.completion";
  result.created ||= Math.floor(Date.now() / 1000);
  result.model = alias.alias;
  result.choices = Array.isArray(result.choices) ? result.choices : [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }];
  if (!result.usage) result.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return result;
}

function demoCompletion(body, alias, requestIdValue) {
  const toolChoice = body.tool_choice;
  const requestedTool = typeof toolChoice === "object" ? toolChoice.function?.name : null;
  const tool = requestedTool || (Array.isArray(body.tools) && body.tools[0]?.function?.name);
  const promptTokens = estimateTokens(body.messages);
  if (tool && Array.isArray(body.tools)) {
    const argumentsValue = tool === "submit_final_response"
      ? JSON.stringify({ schema_version: 1, decision: "reply", reply: "这是托管服务 Demo 返回的测试回复。", travel_barks: [], memory_update: { summary_patch: "", signal: { valence: 0, warmth: 0, concern: 0, confidence: 0 }, topics: [], open_loops: [] } })
      : JSON.stringify({});
    return normalizeResponse({ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: `call_${randomToken(12)}`, type: "function", function: { name: tool, arguments: argumentsValue } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: promptTokens, completion_tokens: 32, total_tokens: promptTokens + 32 } }, alias, requestIdValue);
  }
  const content = String(process.env.DEMO_RESPONSE_TEXT || "你好，这是 Vivant Valley 托管服务 Demo 的回复。你可以在管理员网页为用户充值并查看用量。\n\n[Demo mode]");
  return normalizeResponse({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: estimateTokens([{ role: "assistant", content }]), total_tokens: promptTokens + estimateTokens([{ role: "assistant", content }]) } }, alias, requestIdValue);
}

async function upstreamCompletion(body, alias, requestIdValue) {
  if (demoModeEnabled()) return demoCompletion(body, alias, requestIdValue);
  const upstream = upstreamForAlias(alias);
  if (!upstream.apiKey) throw httpError(503, "当前模型尚未配置可用的上游 API Key。", "provider_not_configured", "upstream_error");
  const payload = { ...body, model: alias.providerModel || upstream.defaultModel || config.upstreamModel, stream: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const result = await postNonThinkingCompletion(upstream.endpoint, upstream.apiKey, payload, { "x-request-id": requestIdValue }, controller.signal);
    const { response, parsed } = result;
    if (parsed === undefined) throw invalidUpstreamJsonError(response);
    if (!response.ok) throw httpError(response.status === 429 ? 429 : 502, `上游返回 HTTP ${response.status}：${upstreamErrorMessage(parsed, "模型请求失败。")}`, response.status === 429 ? "upstream_rate_limited" : "upstream_error", "upstream_error");
    return normalizeResponse(parsed, alias, requestIdValue);
  } catch (error) {
    if (error.status) throw error;
    throw httpError(error.name === "AbortError" ? 408 : 502, error.name === "AbortError" ? "上游请求超时。" : "无法连接上游模型。", error.name === "AbortError" ? "upstream_timeout" : "upstream_unreachable", "upstream_error");
  } finally {
    clearTimeout(timer);
  }
}

function writeSse(res, response, requestIdValue) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-request-id": requestIdValue });
  const choice = response.choices?.[0] || {};
  const message = choice.message || {};
  const delta = { role: "assistant" };
  if (typeof message.content === "string") delta.content = message.content;
  if (Array.isArray(message.tool_calls)) delta.tool_calls = message.tool_calls;
  res.write(`data: ${JSON.stringify({ id: response.id, object: "chat.completion.chunk", created: response.created, model: response.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: response.id, object: "chat.completion.chunk", created: response.created, model: response.model, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }], usage: response.usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function chatCompletion(req, res) {
  const requestIdValue = requestId(req);
  const auth = device(req, res);
  if (!auth) return;
  if (!checkRate(auth.key.id)) {
    res.setHeader("retry-after", "60");
    sendJson(res, 429, errorResponse("请求过于频繁，请稍后再试。", "rate_limit_error", "rate_limited", requestIdValue));
    return;
  }
  if ((activeRequests.get(auth.key.id) || 0) >= 4) {
    res.setHeader("retry-after", "5");
    sendJson(res, 429, errorResponse("并发请求数已达上限。", "rate_limit_error", "concurrency_limited", requestIdValue));
    return;
  }
  let body;
  try { body = await readBody(req); } catch (error) { sendJson(res, error.status || 400, errorResponse(error.message, error.type || "validation_error", error.code || "invalid_request", requestIdValue)); return; }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 128) {
    sendJson(res, 400, errorResponse("messages 必须是 1 到 128 条消息。", "validation_error", "invalid_messages", requestIdValue)); return;
  }
  const alias = getAlias(String(body.model || ""));
  if (!alias) { sendJson(res, 400, errorResponse("不支持的模型别名。", "validation_error", "unknown_model", requestIdValue)); return; }
  const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens ?? 512);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > alias.maxOutputTokens) { sendJson(res, 400, errorResponse(`max_tokens 必须在 1 到 ${alias.maxOutputTokens} 之间。`, "validation_error", "invalid_max_tokens", requestIdValue)); return; }
  const idem = String(req.headers["idempotency-key"] || "").trim();
  const fingerprint = hash(JSON.stringify(body));
  if (idem) {
    const previous = db.requests.find((value) => value.userId === auth.user.id && value.idempotencyKey === idem);
    if (previous) {
      if (previous.fingerprint !== fingerprint) { sendJson(res, 409, errorResponse("Idempotency-Key 已用于不同请求。", "conflict_error", "idempotency_conflict", previous.id)); return; }
      if (previous.response) { res.setHeader("x-request-id", previous.id); res.setHeader("x-balance-micros", String((db.wallets.find((value) => value.userId === auth.user.id) || {}).availableMicros || 0)); if (body.stream) writeSse(res, previous.response, previous.id); else sendJson(res, 200, previous.response, { "x-request-id": previous.id }); return; }
      sendJson(res, 409, errorResponse("相同请求仍在处理中。", "conflict_error", "request_in_progress", previous.id)); return;
    }
  }
  const ceiling = Math.max(1, Math.ceil((Math.min(alias.maxInputTokens, estimateTokens(body.messages) + 1024) * alias.inputMicrosPer1k + maxTokens * alias.outputMicrosPer1k) / 1000));
  const request = { id: requestIdValue, userId: auth.user.id, deviceKeyId: auth.key.id, idempotencyKey: idem || null, fingerprint, modelAlias: alias.alias, status: "in_progress", reservedMicros: ceiling, createdAt: now(), completedAt: null, response: null, usage: null, chargedMicros: 0, errorCode: null };
  try { reserve(auth.user.id, ceiling, request); } catch (error) { sendJson(res, error.status || 402, errorResponse(error.message, error.type || "billing_error", error.code || "insufficient_balance", requestIdValue)); return; }
  db.requests.push(request);
  persistDatabase();
  activeRequests.set(auth.key.id, (activeRequests.get(auth.key.id) || 0) + 1);
  try {
    const response = await upstreamCompletion(body, alias, requestIdValue);
    const usage = response.usage || { prompt_tokens: estimateTokens(body.messages), completion_tokens: 1, total_tokens: estimateTokens(body.messages) + 1 };
    const charged = Math.min(ceiling, costFor(usage, alias));
    request.status = "completed";
    request.response = response;
    request.usage = usage;
    request.chargedMicros = charged;
    request.completedAt = now();
    settle(auth.user.id, request, charged);
    persistDatabase();
    const wallet = db.wallets.find((value) => value.userId === auth.user.id);
    const headers = { "x-request-id": requestIdValue, "x-balance-micros": String(wallet.availableMicros) };
    if (body.stream) writeSse(res, response, requestIdValue); else sendJson(res, 200, response, headers);
  } catch (error) {
    request.status = "failed";
    request.errorCode = error.code || "upstream_error";
    request.completedAt = now();
    release(auth.user.id, request);
    persistDatabase();
    sendJson(res, error.status || 502, errorResponse(error.message, error.type || "upstream_error", error.code || "upstream_error", requestIdValue), { "x-request-id": requestIdValue });
  } finally {
    activeRequests.set(auth.key.id, Math.max(0, (activeRequests.get(auth.key.id) || 1) - 1));
  }
}

function createKey(userId, label, expiresAt) {
  const value = `vv_live_${randomToken(32)}`;
  const record = { id: id(), userId, keyHash: keyHash(value), displayPrefix: value.slice(0, 13), label: String(label || "我的设备").trim().slice(0, 80) || "我的设备", createdAt: now(), lastUsedAt: null, expiresAt: expiresAt || null, revokedAt: null };
  db.deviceKeys.push(record);
  persistDatabase();
  return { value, record };
}

function listUsage(userId) {
  return db.requests.filter((value) => value.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map((value) => ({ request_id: value.id, model_alias: value.modelAlias, status: value.status, created_at: value.createdAt, usage: value.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_micros: value.chargedMicros || 0, latency_ms: 0, error_code: value.errorCode }));
}

async function api(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || "GET";
  try {
    if (method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { status: "ok", version: "0.2.0-demo", mode: runtimeMode(), uptime_seconds: Math.floor((Date.now() - startedAt) / 1000) });
    }
    if (method === "GET" && pathname === "/api/v1/auth/config") {
      return sendJson(res, 200, { invitation_required: Boolean(db.settings.invitationRequired) });
    }
    if (method === "POST" && pathname === "/api/v1/admin/access") {
      if (!config.adminPagePassword) throw httpError(503, "管理员网页密码尚未配置。", "admin_gate_not_configured", "server_error");
      if (!allowAdminGateAttempt(req)) {
        res.setHeader("retry-after", "900");
        throw httpError(429, "密码错误次数过多，请 15 分钟后再试。", "admin_gate_rate_limited", "rate_limit_error");
      }
      const body = await readBody(req);
      if (!timingSafeStringEqual(body.password, config.adminPagePassword)) {
        recordAdminGateFailure(req);
        throw httpError(401, "管理员网页密码错误。", "invalid_admin_page_password", "auth_error");
      }
      const adminEmail = (process.env.ADMIN_EMAIL || "admin@example.com").trim().toLowerCase();
      const admin = db.users.find((value) => value.email === adminEmail && value.role === "admin" && value.status === "active");
      if (!admin) throw httpError(503, "管理员账户当前不可用。", "admin_account_unavailable", "server_error");
      clearAdminGateFailures(req);
      admin.lastLoginAt = now();
      const csrf = startSession(res, admin);
      appendCookie(res, cookie("vv_admin_gate", adminGateToken(), Math.floor(config.sessionTtlMs / 1000), true));
      return sendJson(res, 200, { user: publicUser(admin), csrf_token: csrf });
    }
    if (method === "POST" && pathname === "/api/v1/auth/register") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email.includes("@") || email.length > 320 || password.length < 12) throw httpError(400, "请输入有效邮箱和至少 12 位密码。", "invalid_credentials");
      if (db.settings.invitationRequired) {
        const code = String(body.invitation_code || "").trim();
        const redeem = findRedeemCode(code, "invitation");
        if (!redeem) throw httpError(400, "当前注册需要有效邀请码。", "invitation_required");
        consumeRedeemCode(redeem);
      }
      if (db.users.some((value) => value.email === email)) throw httpError(409, "邮箱已注册。", "email_exists", "conflict_error");
      const user = { id: id(), email, passwordHash: passwordHash(password), role: "user", status: "active", createdAt: now(), lastLoginAt: null };
      db.users.push(user); db.wallets.push({ userId: user.id, availableMicros: 0, reservedMicros: 0 });
      const csrf = startSession(res, user);
      return sendJson(res, 201, { user: publicUser(user), csrf_token: csrf });
    }
    if (method === "POST" && pathname === "/api/v1/auth/login") {
      const body = await readBody(req); const email = String(body.email || "").trim().toLowerCase(); const user = db.users.find((value) => value.email === email);
      if (!user || user.status === "deleted" || !verifyPassword(String(body.password || ""), user.passwordHash)) throw httpError(401, "邮箱或密码错误。", "invalid_credentials", "auth_error");
      user.lastLoginAt = now(); const csrf = startSession(res, user); persistDatabase();
      return sendJson(res, 200, { user: publicUser(user), csrf_token: csrf });
    }
    if (method === "POST" && (pathname === "/api/v1/mod/auth/register" || pathname === "/api/v1/mod/auth/login")) {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email.includes("@") || email.length > 320 || password.length < 12) throw httpError(400, "请输入有效邮箱和至少 12 位密码。", "invalid_credentials");
      const register = pathname.endsWith("/register");
      let user = db.users.find((value) => value.email === email);
      if (register) {
        if (db.settings.invitationRequired) {
          const code = String(body.invitation_code || "").trim();
          const redeem = findRedeemCode(code, "invitation");
          if (!redeem) throw httpError(400, "当前注册需要有效邀请码。", "invitation_required");
          consumeRedeemCode(redeem);
        }
        if (user) throw httpError(409, "邮箱已注册。", "email_exists", "conflict_error");
        user = { id: id(), email, passwordHash: passwordHash(password), role: "user", status: "active", createdAt: now(), lastLoginAt: null };
        db.users.push(user);
        db.wallets.push({ userId: user.id, availableMicros: 0, reservedMicros: 0 });
      } else if (!user || user.status === "deleted" || !verifyPassword(password, user.passwordHash)) {
        throw httpError(401, "邮箱或密码错误。", "invalid_credentials", "auth_error");
      }
      if (user.status !== "active") throw httpError(403, "账户当前不可用。", "account_suspended", "forbidden_error");
      user.lastLoginAt = now();
      const access = startModSession(user);
      return sendJson(res, register ? 201 : 200, { access_token: access.token, token_type: "Bearer", expires_at: access.expiresAt, user: publicUser(user) });
    }
    if (method === "POST" && pathname === "/api/v1/mod/auth/logout") {
      const token = bearerToken(req);
      const current = session(req);
      if (!current || current.record.kind !== "mod") throw httpError(401, "托管账户会话无效或已过期。", "invalid_mod_session", "auth_error");
      db.sessions = db.sessions.filter((value) => value.id !== current.record.id);
      persistDatabase();
      return sendJson(res, 204, null);
    }
    if (method === "POST" && pathname === "/api/v1/auth/logout") {
      const current = requireSession(req, res); if (!current) return;
      if (!requireCsrf(req, current)) throw httpError(403, "CSRF 校验失败。", "csrf_failed", "forbidden_error");
      db.sessions = db.sessions.filter((value) => value.id !== current.record.id); persistDatabase();
      res.setHeader("set-cookie", [cookie("vv_session", "", 0, true), cookie("vv_csrf", "", 0, false), cookie("vv_admin_gate", "", 0, true)]); return sendJson(res, 204, null);
    }
    if (method === "GET" && pathname === "/api/v1/me") { const current = requireSession(req, res); if (!current) return; return sendJson(res, 200, publicUser(current.user)); }
    if (method === "GET" && pathname === "/api/v1/catalog") {
      const current = requireSession(req, res); if (!current) return;
      const items = db.modelAliases.filter((value) => value.enabled).map((value) => ({
        alias: value.alias,
        max_input_tokens: value.maxInputTokens,
        max_output_tokens: value.maxOutputTokens,
        input_micros_per_1k: value.inputMicrosPer1k,
        output_micros_per_1k: value.outputMicrosPer1k,
        cached_input_micros_per_1k: value.cachedInputMicrosPer1k,
      }));
      return sendJson(res, 200, { base_url: "https://www.vivantvalley.com.cn/v1", items });
    }
    if (method === "GET" && pathname === "/api/v1/mod/bootstrap") {
      const current = requireModSession(req);
      const items = db.modelAliases.filter((value) => value.enabled).map((value) => ({
        alias: value.alias,
        max_input_tokens: value.maxInputTokens,
        max_output_tokens: value.maxOutputTokens,
        input_micros_per_1k: value.inputMicrosPer1k,
        output_micros_per_1k: value.outputMicrosPer1k,
        cached_input_micros_per_1k: value.cachedInputMicrosPer1k,
      }));
      const wallet = db.wallets.find((value) => value.userId === current.user.id) || { availableMicros: 0, reservedMicros: 0 };
      return sendJson(res, 200, { user: publicUser(current.user), base_url: "https://www.vivantvalley.com.cn/v1", models: items, wallet: { available_micros: wallet.availableMicros, reserved_micros: wallet.reservedMicros, currency: "credit_micros" } });
    }
    if (method === "POST" && pathname === "/api/v1/mod/redeem") {
      const current = requireModSession(req);
      const body = await readBody(req);
      const code = findRedeemCode(body.code, "credit");
      if (!code) throw httpError(409, "兑换码无效、已使用或已过期。", "invalid_redeem_code", "conflict_error");
      consumeRedeemCode(code);
      const wallet = db.wallets.find((value) => value.userId === current.user.id);
      wallet.availableMicros += code.valueMicros;
      db.ledger.push({ id: id(), userId: current.user.id, kind: "redeem", amountMicros: code.valueMicros, balanceAfterMicros: wallet.availableMicros, createdAt: now(), metadata: { redeem_code: code.displayPrefix, source: "mod" } });
      persistDatabase();
      return sendJson(res, 200, { available_micros: wallet.availableMicros, reserved_micros: wallet.reservedMicros, currency: "credit_micros" });
    }
    if (method === "GET" && pathname === "/api/v1/usage") { const current = requireSession(req, res); if (!current) return; const items = listUsage(current.user.id); return sendJson(res, 200, { items, page: 1, page_size: items.length, total: items.length, totals: { prompt_tokens: items.reduce((sum, value) => sum + value.usage.prompt_tokens, 0), completion_tokens: items.reduce((sum, value) => sum + value.usage.completion_tokens, 0), cost_micros: items.reduce((sum, value) => sum + value.cost_micros, 0) } }); }
    if (method === "GET" && pathname === "/api/v1/ledger") { const current = requireSession(req, res); if (!current) return; const wallet = db.wallets.find((value) => value.userId === current.user.id); const items = db.ledger.filter((value) => value.userId === current.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map((value) => ({ id: value.id, kind: value.kind, amount_micros: value.amountMicros, balance_after_micros: value.balanceAfterMicros, created_at: value.createdAt, request_id: value.requestId || null, note: value.metadata?.reason || null })); return sendJson(res, 200, { wallet: { available_micros: wallet.availableMicros, reserved_micros: wallet.reservedMicros, currency: "credit_micros" }, items, page: 1, page_size: items.length, total: items.length }); }
    if (pathname === "/api/v1/keys" && method === "GET") { const current = requireSession(req, res); if (!current) return; return sendJson(res, 200, { items: db.deviceKeys.filter((value) => value.userId === current.user.id).map((value) => ({ id: value.id, display_prefix: value.displayPrefix, label: value.label, created_at: value.createdAt, last_used_at: value.lastUsedAt, expires_at: value.expiresAt, revoked: Boolean(value.revokedAt) })) }); }
    if (pathname === "/api/v1/keys" && method === "POST") { const current = requireSession(req, res); if (!current) return; if (!requireCsrf(req, current)) throw httpError(403, "CSRF 校验失败。", "csrf_failed", "forbidden_error"); const body = await readBody(req).catch((error) => error.status ? {} : Promise.reject(error)); const created = createKey(current.user.id, body.label, body.expires_at || null); return sendJson(res, 201, { id: created.record.id, key: created.value, display_prefix: created.record.displayPrefix, label: created.record.label, created_at: created.record.createdAt, last_used_at: null, expires_at: created.record.expiresAt, revoked: false }); }
    const keyMatch = /^\/api\/v1\/keys\/([^/]+)$/.exec(pathname);
    if (keyMatch && method === "DELETE") { const current = requireSession(req, res); if (!current) return; if (!requireCsrf(req, current)) throw httpError(403, "CSRF 校验失败。", "csrf_failed", "forbidden_error"); const key = db.deviceKeys.find((value) => value.id === keyMatch[1] && value.userId === current.user.id); if (!key) throw httpError(404, "设备 Key 不存在。", "not_found", "not_found_error"); key.revokedAt ||= now(); persistDatabase(); return sendJson(res, 204, null); }
    if (method === "POST" && pathname === "/api/v1/redeem") { const current = requireSession(req, res); if (!current) return; if (!requireCsrf(req, current)) throw httpError(403, "CSRF 校验失败。", "csrf_failed", "forbidden_error"); const body = await readBody(req); const code = findRedeemCode(body.code, "credit"); if (!code) throw httpError(409, "兑换码无效、已使用或已过期。", "invalid_redeem_code", "conflict_error"); consumeRedeemCode(code); const wallet = db.wallets.find((value) => value.userId === current.user.id); wallet.availableMicros += code.valueMicros; db.ledger.push({ id: id(), userId: current.user.id, kind: "redeem", amountMicros: code.valueMicros, balanceAfterMicros: wallet.availableMicros, createdAt: now(), metadata: { redeem_code: code.displayPrefix, batch_id: code.batchId || null, denomination_yuan: code.denominationYuan || null } }); persistDatabase(); return sendJson(res, 200, { available_micros: wallet.availableMicros, reserved_micros: wallet.reservedMicros, currency: "credit_micros", redeemed_value_micros: code.valueMicros }); }
    if (pathname === "/v1/models" && method === "GET") { const auth = device(req, res); if (!auth) return; return sendJson(res, 200, { object: "list", data: db.modelAliases.filter((value) => value.enabled).map((value) => ({ id: value.alias, object: "model", owned_by: "vivant-valley" })) }); }
    if ((pathname === "/v1/chat/completions" || pathname === "/chat/completions") && method === "POST") return chatCompletion(req, res);
    if (pathname.startsWith("/api/v1/admin/")) {
      if (!adminGatePassed(req)) return sendJson(res, 401, errorResponse("请先输入管理员网页密码。", "auth_error", "admin_gate_required"));
      return await adminApi(req, res, url);
    }
    sendJson(res, 404, errorResponse("接口不存在。", "validation_error", "not_found"));
  } catch (error) {
    if (error.status) return sendJson(res, error.status, errorResponse(error.message, error.type || "validation_error", error.code || "invalid_request"));
    console.error(error);
    return sendJson(res, 500, errorResponse("服务器内部错误。", "server_error", "internal_error"));
  }
}

async function adminApi(req, res, url) {
  const current = requireSession(req, res, "admin"); if (!current) return;
  const method = req.method || "GET"; const pathname = url.pathname;
  if (method !== "GET" && !requireCsrf(req, current)) throw httpError(403, "CSRF 校验失败。", "csrf_failed", "forbidden_error");
  if (method === "GET" && pathname === "/api/v1/admin/users") {
    const items = db.users.map((user) => publicUser(user)); return sendJson(res, 200, { items, page: 1, page_size: items.length, total: items.length });
  }
  const userMatch = /^\/api\/v1\/admin\/users\/([^/]+)$/.exec(pathname);
  if (userMatch && method === "PATCH") { const user = db.users.find((value) => value.id === userMatch[1]); if (!user) throw httpError(404, "用户不存在。", "not_found", "not_found_error"); const body = await readBody(req); if (body.status && ["active", "suspended", "deleted"].includes(body.status)) user.status = body.status; if (body.role && ["user", "admin"].includes(body.role)) user.role = body.role; dbAudit(current.user, "update_user", user.id, body); persistDatabase(); return sendJson(res, 200, publicUser(user)); }
  const creditMatch = /^\/api\/v1\/admin\/users\/([^/]+)\/credits$/.exec(pathname);
  if (creditMatch && method === "POST") { const user = db.users.find((value) => value.id === creditMatch[1]); if (!user) throw httpError(404, "用户不存在。", "not_found", "not_found_error"); const body = await readBody(req); const amount = Number(body.amount_micros); if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000_000) throw httpError(400, "充值金额无效。", "invalid_amount"); const wallet = db.wallets.find((value) => value.userId === user.id); wallet.availableMicros += amount; db.ledger.push({ id: id(), userId: user.id, kind: "admin_topup", amountMicros: amount, balanceAfterMicros: wallet.availableMicros, createdAt: now(), createdBy: current.user.id, metadata: { reason: String(body.reason || "管理员充值").slice(0, 500) } }); dbAudit(current.user, "top_up", user.id, { amount_micros: amount }); persistDatabase(); return sendJson(res, 200, { available_micros: wallet.availableMicros, reserved_micros: wallet.reservedMicros, currency: "credit_micros" }); }
  if (method === "POST" && pathname === "/api/v1/admin/redeem-codes") { const body = await readBody(req); const value = Number(body.value_micros); const maxUses = Number(body.max_uses || 1); if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000_000 || !Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 100_000) throw httpError(400, "兑换码参数无效。", "invalid_redeem_code"); const code = `vv_redeem_${randomToken(18)}`; const record = { id: id(), purpose: "general", codeHash: hash(code), displayPrefix: code.slice(0, 16), valueMicros: value, maxUses, usedCount: 0, expiresAt: body.expires_at || null, disabledAt: null, createdBy: current.user.id, createdAt: now() }; db.redeemCodes.push(record); dbAudit(current.user, "create_redeem_code", record.id, { value_micros: value, max_uses: maxUses, purpose: "general" }); persistDatabase(); return sendJson(res, 201, { id: record.id, code, display_prefix: record.displayPrefix, value_micros: value, max_uses: maxUses, expires_at: record.expiresAt }); }
  if (method === "POST" && pathname === "/api/v1/admin/redeem-batches") {
    const body = await readBody(req);
    const denomination = Number(body.denomination_yuan);
    const count = body.count === undefined ? CARD_BATCH_COUNT : Number(body.count);
    if (!CARD_DENOMINATIONS_YUAN.has(denomination)) throw httpError(400, "卡密面额只能是 1、5、10 或 20 元。", "invalid_card_denomination");
    if (count !== CARD_BATCH_COUNT) throw httpError(400, `每批卡密固定生成 ${CARD_BATCH_COUNT} 张。`, "invalid_card_batch_size");
    let expiresAt = body.expires_at === undefined || body.expires_at === null || String(body.expires_at).trim() === ""
      ? null
      : String(body.expires_at).trim();
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt) <= new Date())) throw httpError(400, "卡密有效期必须是未来的有效时间。", "invalid_card_expiry");
    const batchId = id();
    const createdAt = now();
    const valueMicros = denomination * CARD_VALUE_MICROS_PER_YUAN;
    const existingHashes = new Set(db.redeemCodes.map((value) => value.codeHash));
    const codes = [];
    const records = [];
    while (codes.length < CARD_BATCH_COUNT) {
      const code = createCardCode(denomination);
      const codeHash = hash(code);
      if (existingHashes.has(codeHash)) continue;
      existingHashes.add(codeHash);
      codes.push(code);
      records.push({ id: id(), purpose: "credit", batchId, codeHash, displayPrefix: code.slice(0, 8), valueMicros, denominationYuan: denomination, maxUses: 1, usedCount: 0, expiresAt, disabledAt: null, createdBy: current.user.id, createdAt });
    }
    const codesText = codes.join("\n");
    const batch = { id: batchId, denominationYuan: denomination, valueMicros, codeCount: CARD_BATCH_COUNT, usedCount: 0, expiresAt, disabledAt: null, codesCiphertext: encryptSecret(codesText), createdBy: current.user.id, createdAt };
    db.redeemCodes.push(...records);
    db.redeemBatches.push(batch);
    dbAudit(current.user, "create_redeem_batch", batch.id, { denomination_yuan: denomination, value_micros: valueMicros, code_count: CARD_BATCH_COUNT, expires_at: expiresAt });
    persistDatabase();
    return sendJson(res, 201, { batch: publicRedeemBatch(batch), codes, codes_text: codes.join("\n"), download_name: `vivant-valley-${denomination}yuan-${batch.id}.txt`, warning: "卡密明文仅在本次响应中返回；请立即下载并妥善保管。" });
  }
  if (method === "GET" && pathname === "/api/v1/admin/redeem-batches") return sendJson(res, 200, { items: db.redeemBatches.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(publicRedeemBatch) });
  const redeemBatchCodesMatch = /^\/api\/v1\/admin\/redeem-batches\/([^/]+)\/codes$/.exec(pathname);
  if (redeemBatchCodesMatch && method === "GET") {
    const batch = db.redeemBatches.find((value) => value.id === redeemBatchCodesMatch[1]);
    if (!batch) throw httpError(404, "卡密批次不存在。", "not_found", "not_found_error");
    if (!batch.codesCiphertext) throw httpError(410, "该批次没有可恢复的卡密明文。", "batch_codes_unavailable", "gone_error");
    let codesText;
    try { codesText = decryptSecret(batch.codesCiphertext); } catch { throw httpError(503, "卡密批次明文无法解密。", "batch_codes_unavailable", "server_error"); }
    return sendJson(res, 200, { batch: publicRedeemBatch(batch), codes_text: codesText, download_name: `vivant-valley-${batch.denominationYuan}yuan-${batch.id}.txt` });
  }
  const redeemBatchDisableMatch = /^\/api\/v1\/admin\/redeem-batches\/([^/]+)\/disable$/.exec(pathname);
  if (redeemBatchDisableMatch && method === "POST") {
    const batch = db.redeemBatches.find((value) => value.id === redeemBatchDisableMatch[1]);
    if (!batch) throw httpError(404, "卡密批次不存在。", "not_found", "not_found_error");
    if (!batch.disabledAt) {
      batch.disabledAt = now();
      for (const code of db.redeemCodes) if (code.batchId === batch.id && !code.disabledAt) code.disabledAt = batch.disabledAt;
      dbAudit(current.user, "disable_redeem_batch", batch.id, {});
      persistDatabase();
    }
    return sendJson(res, 200, publicRedeemBatch(batch));
  }
  if (method === "GET" && pathname === "/api/v1/admin/usage") { const values = db.requests; return sendJson(res, 200, { from: values[0]?.createdAt || now(), to: now(), requests: values.length, provider_cost_micros: values.reduce((sum, value) => sum + Math.floor((value.chargedMicros || 0) * 0.65), 0), user_charge_micros: values.reduce((sum, value) => sum + (value.chargedMicros || 0), 0), margin_micros: values.reduce((sum, value) => sum + Math.floor((value.chargedMicros || 0) * 0.35), 0) }); }
  if (method === "GET" && pathname === "/api/v1/admin/providers") return sendJson(res, 200, { items: listAdminProviders() });
  if (method === "POST" && pathname === "/api/v1/admin/providers") {
    const body = await readBody(req);
    const name = String(body.name || "").trim().slice(0, 80);
    const baseUrl = String(body.base_url || "").trim();
    const apiKey = String(body.api_key || "").trim();
    const defaultModel = String(body.default_model || "").trim().slice(0, 128);
    if (!name || name.length > 80) throw httpError(400, "上游名称无效。", "invalid_provider_name");
    if (!baseUrl) throw httpError(400, "必须填写上游 Base URL。", "invalid_provider_url");
    try { validateManagedBaseUrl(baseUrl); } catch { throw httpError(400, "上游 Base URL 必须使用 HTTPS（本机回环地址可用 HTTP）。", "invalid_provider_url"); }
    if (!apiKey) throw httpError(400, "必须填写上游 API Key。", "invalid_provider_key");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw httpError(400, "上游启用状态无效。", "invalid_provider_status");
    const provider = { id: id(), name, baseUrl, apiKeyCiphertext: encryptSecret(apiKey), defaultModel, enabled: body.enabled !== false, createdAt: now(), updatedAt: now(), lastCheckedAt: null, lastCheckStatus: null };
    db.providers.push(provider);
    dbAudit(current.user, "create_provider", provider.id, { name: provider.name, base_url: provider.baseUrl, default_model: provider.defaultModel, enabled: provider.enabled, api_key_updated: true });
    persistDatabase();
    return sendJson(res, 201, publicProvider(provider));
  }
  const providerTestMatch = /^\/api\/v1\/admin\/providers\/([^/]+)\/test$/.exec(pathname);
  if (providerTestMatch && method === "POST") {
    const provider = db.providers.find((value) => value.id === providerTestMatch[1]);
    if (!provider) throw httpError(404, "上游不存在。", "not_found", "not_found_error");
    try {
      const result = await probeProvider(provider);
      provider.lastCheckedAt = now(); provider.lastCheckStatus = "ok"; provider.updatedAt = now(); persistDatabase();
      return sendJson(res, 200, { ok: true, status: result.status, body_bytes: result.bodyBytes, model: result.model, protocol: result.protocol, non_thinking_mode: result.nonThinkingMode, checked_at: provider.lastCheckedAt });
    } catch (error) {
      provider.lastCheckedAt = now(); provider.lastCheckStatus = "failed"; provider.updatedAt = now(); persistDatabase(); throw error;
    }
  }
  const providerMatch = /^\/api\/v1\/admin\/providers\/([^/]+)$/.exec(pathname);
  if (providerMatch && method === "PATCH") {
    const provider = db.providers.find((value) => value.id === providerMatch[1]);
    if (!provider) throw httpError(404, "上游不存在。", "not_found", "not_found_error");
    const body = await readBody(req);
    const changes = {};
    if (body.name !== undefined) { const name = String(body.name).trim().slice(0, 80); if (!name) throw httpError(400, "上游名称无效。", "invalid_provider_name"); provider.name = name; changes.name = name; }
    if (body.base_url !== undefined) { const baseUrl = String(body.base_url).trim(); try { validateManagedBaseUrl(baseUrl); } catch { throw httpError(400, "上游 Base URL 必须使用 HTTPS（本机回环地址可用 HTTP）。", "invalid_provider_url"); } provider.baseUrl = baseUrl; changes.base_url = baseUrl; }
    if (body.default_model !== undefined) { const defaultModel = String(body.default_model).trim().slice(0, 128); provider.defaultModel = defaultModel; changes.default_model = defaultModel; }
    if (body.enabled !== undefined) { if (typeof body.enabled !== "boolean") throw httpError(400, "上游启用状态无效。", "invalid_provider_status"); provider.enabled = body.enabled; changes.enabled = body.enabled; }
    if (body.clear_api_key === true) { provider.apiKeyCiphertext = ""; changes.api_key_cleared = true; }
    if (body.api_key !== undefined) { const apiKey = String(body.api_key).trim(); if (!apiKey) throw httpError(400, "API Key 不能为空。", "invalid_provider_key"); provider.apiKeyCiphertext = encryptSecret(apiKey); changes.api_key_updated = true; }
    provider.updatedAt = now();
    dbAudit(current.user, "update_provider", provider.id, changes);
    persistDatabase();
    return sendJson(res, 200, publicProvider(provider));
  }
  if (providerMatch && method === "DELETE") {
    const provider = db.providers.find((value) => value.id === providerMatch[1]);
    if (!provider) throw httpError(404, "上游不存在。", "not_found", "not_found_error");
    if (db.modelAliases.some((value) => value.providerId === provider.id)) throw httpError(409, "仍有模型别名绑定此上游，请先切换模型路由。", "provider_in_use", "conflict_error");
    db.providers = db.providers.filter((value) => value.id !== provider.id);
    dbAudit(current.user, "delete_provider", provider.id, { name: provider.name });
    persistDatabase();
    return sendJson(res, 204, null);
  }
  if (method === "GET" && pathname === "/api/v1/admin/settings/registration") return sendJson(res, 200, { invite_required: Boolean(db.settings.invitationRequired) });
  if (method === "PATCH" && pathname === "/api/v1/admin/settings/registration") { const body = await readBody(req); db.settings.invitationRequired = Boolean(body.invite_required); dbAudit(current.user, "set_registration_gate", null, body); persistDatabase(); return sendJson(res, 200, { invite_required: db.settings.invitationRequired }); }
  if (method === "GET" && pathname === "/api/v1/admin/settings/runtime") return sendJson(res, 200, { demo_mode: demoModeEnabled() });
  if (method === "PATCH" && pathname === "/api/v1/admin/settings/runtime") {
    const body = await readBody(req);
    if (typeof body.demo_mode !== "boolean") throw httpError(400, "演示模式参数无效。", "invalid_runtime_setting");
    db.settings.demoMode = body.demo_mode;
    dbAudit(current.user, "set_runtime_mode", null, { demo_mode: db.settings.demoMode });
    persistDatabase();
    return sendJson(res, 200, { demo_mode: db.settings.demoMode });
  }
  if (method === "GET" && pathname === "/api/v1/admin/models") return sendJson(res, 200, { items: db.modelAliases });
  const modelMatch = /^\/api\/v1\/admin\/models\/([^/]+)$/.exec(pathname);
  if (modelMatch && method === "PATCH") { const model = db.modelAliases.find((value) => value.alias === modelMatch[1]); if (!model) throw httpError(404, "模型别名不存在。", "not_found", "not_found_error"); const body = await readBody(req); for (const field of ["maxInputTokens", "maxOutputTokens", "inputMicrosPer1k", "outputMicrosPer1k", "cachedInputMicrosPer1k"]) if (body[field] !== undefined && (!Number.isSafeInteger(Number(body[field])) || Number(body[field]) < 0)) throw httpError(400, "模型数值配置无效。", "invalid_model_pricing"); if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw httpError(400, "模型启用状态无效。", "invalid_model_status"); if (body.providerModel !== undefined && String(body.providerModel).length > 128) throw httpError(400, "上游模型名称过长。", "invalid_provider_model"); if (body.providerId !== undefined && body.providerId !== null && !db.providers.some((value) => value.id === String(body.providerId))) throw httpError(400, "绑定的上游不存在。", "invalid_provider_id"); for (const field of ["enabled", "providerId", "providerModel", "maxInputTokens", "maxOutputTokens", "inputMicrosPer1k", "outputMicrosPer1k", "cachedInputMicrosPer1k"]) if (body[field] !== undefined) model[field] = field === "providerModel" ? String(body[field]) : field === "providerId" ? (body[field] === null ? null : String(body[field])) : body[field]; const auditBody = { ...body }; delete auditBody.api_key; dbAudit(current.user, "update_model_alias", model.alias, auditBody); persistDatabase(); return sendJson(res, 200, model); }
  sendJson(res, 404, errorResponse("管理员接口不存在。", "validation_error", "not_found"));
}

function dbAudit(actor, action, target, metadata) {
  // Demo keeps audit rows in a compact request-compatible ledger side channel.
  db.ledger.push({ id: id(), userId: actor.id, kind: "adjustment", amountMicros: 0, balanceAfterMicros: 0, createdAt: now(), metadata: { admin_action: action, target, ...metadata } });
}

const style = `*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:#1769e0}button{border:0;border-radius:7px;padding:10px 14px;background:#1769e0;color:#fff;font-weight:700;cursor:pointer}button.secondary{background:#e6edf7;color:#172033}button.danger{background:#cf3f4f}.wrap{width:min(1120px,calc(100% - 32px));margin:0 auto}.top{background:#111c31;color:#fff;padding:18px 0}.top .row{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{font-weight:800;letter-spacing:.02em}.panel{background:#fff;border:1px solid #dfe6f0;border-radius:8px;padding:20px;margin:18px 0;box-shadow:0 3px 12px #1720330d}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}.stat{font-size:26px;font-weight:800;margin-top:8px}.muted{color:#64748b;font-size:13px}.form{max-width:440px;margin:48px auto}.field{display:grid;gap:6px;margin:14px 0}input,select{width:100%;padding:11px;border:1px solid #c8d3e2;border-radius:6px;font:inherit}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e8edf4;font-size:14px}code{background:#eef3fa;padding:3px 6px;border-radius:4px;word-break:break-all}.notice{padding:10px;border-radius:6px;background:#eef5ff;margin:10px 0}.error{background:#fff0f0;color:#a52332}.success{background:#ecfaf1;color:#176b38}.actions{display:flex;gap:8px;flex-wrap:wrap}.small{font-size:12px}.keybox{padding:12px;background:#111c31;color:#fff;border-radius:6px;word-break:break-all}.hidden{display:none}@media(max-width:640px){.wrap{width:min(100% - 20px,1120px)}.panel{padding:14px;overflow:auto}th,td{white-space:nowrap}}`;

function shell(title, content, script = "") { return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Vivant Valley</title><style>${style}</style></head><body>${content}${script}</body></html>`; }

function authPage(register = false) {
  const title = register ? "注册" : "登录";
  const switchText = register ? "已有账户？登录" : "没有账户？注册";
  const switchHref = register ? "/login" : "/register";
  return shell(title, `<main class="wrap"><section class="panel form"><h1>Vivant Valley</h1><p class="muted">托管 AI 服务${register ? " · 创建账户" : " · 登录账户"}</p><form id="form"><div class="field"><label>邮箱</label><input id="email" type="email" required autocomplete="email"></div><div class="field"><label>密码（至少 12 位）</label><input id="password" type="password" required minlength="12" autocomplete="${register ? "new-password" : "current-password"}></div>${register ? '<div class="field"><label>邀请码（如已启用）</label><input id="invitation_code"></div>' : ""}<button>${title}</button></form><div id="message" class="notice hidden"></div><p><a href="${switchHref}">${switchText}</a></p></section></main>`, `<script>document.getElementById('form').addEventListener('submit',async(e)=>{e.preventDefault();const body={email:email.value,password:password.value${register ? ",invitation_code:invitation_code.value" : ""}};const r=await fetch('/api/v1/auth/${register ? "register" : "login"}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok){message.textContent=d.error?.message||'请求失败';message.className='notice error';message.classList.remove('hidden');return}location.href=d.user.role==='admin'?'/admin':'/app';});</script>`); }

function adminAccessPage() {
  const content = `<main class="wrap"><section class="panel form"><h1>管理员访问</h1><p class="muted">Vivant Valley 管理员控制台</p><form id="adminAccessForm"><div class="field"><label>网页密码</label><input id="adminPagePassword" type="password" required autocomplete="current-password" autofocus></div><button id="adminAccessSubmit" type="submit">进入控制台</button></form><div id="adminAccessMessage" class="notice hidden"></div><p><a href="/app">返回用户控制台</a></p></section></main>`;
  const script = `<script>document.getElementById('adminAccessForm').addEventListener('submit',async(event)=>{event.preventDefault();const button=document.getElementById('adminAccessSubmit');const message=document.getElementById('adminAccessMessage');button.disabled=true;try{const response=await fetch('/api/v1/admin/access',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('adminPagePassword').value})});const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'请求失败');location.replace('/admin')}catch(error){message.textContent=error.message;message.className='notice error';message.classList.remove('hidden')}finally{button.disabled=false}});</script>`;
  return shell("管理员访问", content, script);
}

function appPage(admin = false) {
  const heading = admin ? "管理员控制台" : "用户控制台";
  const content = `<header class="top"><div class="wrap row"><div class="brand">Vivant Valley · ${heading}</div><div class="actions"><a href="/app" style="color:#fff">用户控制台</a>${admin ? '' : '<a id="adminLink" class="hidden" href="/admin" style="color:#fff">管理员</a>'}<button id="logout" class="secondary">退出</button></div></div></header><main class="wrap"><div id="message" class="notice hidden"></div><section class="grid"><div class="panel"><div class="muted">当前账户</div><div id="email" class="stat">...</div><div id="role" class="muted"></div></div><div class="panel"><div class="muted">可用额度（credit_micros）</div><div id="balance" class="stat">...</div><div class="muted">上游模型 Key 不会暴露给用户</div></div><div class="panel"><div class="muted">托管模型</div><div class="stat">vv-dialogue</div><div class="muted">可在管理员页面调整路由和价格</div></div></section><section class="panel"><h2>设备 Key</h2><p class="muted">创建后只显示一次。将 Key 填入 Mod 的官方托管服务配置。</p><div class="actions"><input id="label" placeholder="设备名称" style="max-width:260px"><button id="createKey">创建设备 Key</button></div><div id="newKey" class="keybox hidden"></div><div id="keys"></div></section><section class="panel"><h2>最近用量</h2><div id="usage"></div></section><section class="panel"><h2>额度账本</h2><div id="ledger"></div></section><section class="panel"><h2>兑换额度</h2><div class="actions"><input id="redeemCode" placeholder="vv_redeem_..."><button id="redeem">兑换</button></div></section></main>`;
  const script = `<script>const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const csrf=()=>decodeURIComponent((document.cookie.match(/(?:^|; )vv_csrf=([^;]*)/)||[])[1]||'');const show=(text,ok=false)=>{message.textContent=text;message.className='notice '+(ok?'success':'error');message.classList.remove('hidden')};const api=async(path,opts={})=>{opts.headers={...(opts.headers||{}),'x-csrf-token':csrf()};const r=await fetch(path,opts);const d=r.status===204?null:await r.json();if(!r.ok)throw new Error(d?.error?.message||'请求失败');return d};async function load(){try{const me=await api('/api/v1/me');email.textContent=me.email;role.textContent=me.role==='admin'?'管理员账户':'普通用户';balance.textContent=(me.wallet.available_micros||0).toLocaleString();if(me.role==='admin'&&document.getElementById('adminLink'))adminLink.classList.remove('hidden');const keysData=await api('/api/v1/keys');keys.innerHTML=keysData.items.length?'<table><tr><th>名称</th><th>前缀</th><th>状态</th><th>操作</th></tr>'+keysData.items.map(k=>'<tr><td>'+esc(k.label)+'</td><td><code>'+esc(k.display_prefix)+'...</code></td><td>'+(!k.revoked?'可用':'已撤销')+'</td><td>'+(!k.revoked?'<button class="danger" data-revoke="'+k.id+'">撤销</button>':'')+'</td></tr>').join('')+'</table>':'<p class="muted">还没有设备 Key。</p>';const u=await api('/api/v1/usage');usage.innerHTML=u.items.length?'<table><tr><th>时间</th><th>模型</th><th>Token</th><th>扣费</th><th>状态</th></tr>'+u.items.map(x=>'<tr><td>'+esc(x.created_at)+'</td><td>'+esc(x.model_alias)+'</td><td>'+x.usage.total_tokens+'</td><td>'+x.cost_micros+'</td><td>'+esc(x.status)+'</td></tr>').join('')+'</table>':'<p class="muted">暂无调用记录。</p>';const l=await api('/api/v1/ledger');ledger.innerHTML=l.items.length?'<table><tr><th>时间</th><th>类型</th><th>金额</th><th>余额</th></tr>'+l.items.map(x=>'<tr><td>'+esc(x.created_at)+'</td><td>'+esc(x.kind)+'</td><td>'+x.amount_micros+'</td><td>'+x.balance_after_micros+'</td></tr>').join('')+'</table>':'<p class="muted">暂无账本记录。</p>'}catch(e){if(String(e.message).includes('登录'))location.href='/login';else show(e.message)}}async function revoke(id){try{await api('/api/v1/keys/'+id,{method:'DELETE'});show('设备 Key 已撤销。',true);load()}catch(e){show(e.message)}}document.addEventListener('click',(event)=>{const button=event.target.closest('[data-revoke]');if(button)revoke(button.dataset.revoke)});createKey.onclick=async()=>{try{const d=await api('/api/v1/keys',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:label.value})});newKey.textContent=d.key;newKey.classList.remove('hidden');show('Key 已创建，请立即复制保存。',true);load()}catch(e){show(e.message)}};redeem.onclick=async()=>{try{await api('/api/v1/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:redeemCode.value})});show('兑换成功。',true);load()}catch(e){show(e.message)}};logout.onclick=async()=>{try{await api('/api/v1/auth/logout',{method:'POST'});location.href='/login'}catch(e){show(e.message)}};load();</script>`;
  return shell(heading, content, script);
}

function userShell(title, bodyClass, content, script) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#ffffff"><title>${title} · Vivant Valley</title><link rel="stylesheet" href="/assets/user.css"></head><body class="${bodyClass}">${content}<script defer src="${script}"></script></body></html>`;
}

function authPageV2(register = false) {
  const mode = register ? "register" : "login";
  const content = `<div class="auth-layout"><section class="auth-visual" aria-label="Vivant Valley"><div class="auth-visual-content"><h1>Vivant Valley</h1><p>连接你的山谷，让角色对话、记忆与故事持续生长。</p><div class="service-state">托管服务在线</div></div></section><main class="auth-main"><div class="auth-panel"><a class="brand-lockup" href="/"><span class="brand-mark"><img src="/assets/vivant-logo.jpg" alt=""></span><span class="brand-name"><span>Vivant Valley</span><small>玩家服务中心</small></span></a><h2>${register ? "创建账户" : "欢迎回来"}</h2><p class="auth-subtitle">${register ? "注册后可创建设备 Key 并管理使用额度。" : "登录后管理设备 Key、额度与调用记录。"}</p><form class="auth-form" data-auth-form novalidate><div class="field-group"><label for="email">邮箱</label><input id="email" name="email" type="email" required maxlength="320" autocomplete="email" inputmode="email" placeholder="name@example.com"></div><div class="field-group"><div class="field-label-row"><label for="password">密码</label></div><div class="password-wrap"><input id="password" name="password" type="password" required minlength="12" maxlength="256" autocomplete="${register ? "new-password" : "current-password"}" placeholder="至少 12 位"><button class="password-toggle" type="button" data-password-toggle="password" aria-pressed="false">显示</button></div>${register ? '<p class="field-hint">至少 12 位，建议同时使用字母、数字和符号。</p>' : ""}</div>${register ? '<div class="field-group"><label for="passwordConfirmation">确认密码</label><div class="password-wrap"><input id="passwordConfirmation" name="password_confirmation" type="password" required minlength="12" maxlength="256" autocomplete="new-password" placeholder="再次输入密码"><button class="password-toggle" type="button" data-password-toggle="passwordConfirmation" aria-pressed="false">显示</button></div></div><div id="invitationField" class="field-group hidden"><label for="invitationCode">邀请码</label><input id="invitationCode" name="invitation_code" type="text" maxlength="128" autocomplete="off" placeholder="输入邀请码"></div>' : ""}<div id="authMessage" class="auth-message hidden" role="alert"></div><button id="authSubmit" class="auth-submit" type="submit">${register ? "创建账户" : "登录"}</button></form><p class="auth-switch">${register ? '已有账户？<a href="/login">直接登录</a>' : '还没有账户？<a href="/register">创建账户</a>'}</p><p class="auth-footnote">账户凭据仅用于 Vivant Valley 托管服务。</p></div></main></div>`;
  return userShell(register ? "注册" : "登录", "auth-page", content, "/assets/auth.js").replace('<body class="auth-page">', `<body class="auth-page" data-auth-mode="${mode}">`);
}

function appPageV2() {
  const content = `<header class="console-header"><a class="brand-lockup" href="/app"><span class="brand-mark"><img src="/assets/vivant-logo.jpg" alt=""></span><span class="brand-name"><span>Vivant Valley</span><small>玩家服务中心</small></span></a><div class="header-actions"><span id="headerEmail" class="header-account">正在加载...</span><a id="adminLink" class="button-secondary button-small hidden" href="/admin">管理后台</a><button id="logoutButton" class="button-quiet button-small" type="button">退出</button></div></header><div class="console-shell"><aside class="side-nav" aria-label="用户控制台导航"><nav class="nav-group"><button class="nav-button" type="button" data-view="overview" aria-current="page">概览</button><button class="nav-button" type="button" data-view="keys" aria-current="false">设备 Key</button><button class="nav-button" type="button" data-view="usage" aria-current="false">调用记录</button><button class="nav-button" type="button" data-view="credits" aria-current="false">额度中心</button></nav><div class="side-note"><strong id="sideEmail">正在加载...</strong><span>Vivant Valley 托管账户</span></div></aside><main class="console-main" tabindex="-1"><section class="page-panel is-active" data-panel="overview"><div class="page-heading"><div><h1>账户概览</h1><p>服务状态、接入配置和最近使用情况。</p></div><div class="heading-actions"><button class="button-secondary" type="button" data-refresh>刷新</button><button type="button" data-open-key-dialog>创建设备 Key</button></div></div><div class="metric-grid"><article class="metric-card"><span class="metric-label">可用额度</span><strong id="balanceMetric" class="metric-value"><span class="loading-line"></span></strong><div class="metric-meta">额度单位</div></article><article class="metric-card"><span class="metric-label">累计请求</span><strong id="requestMetric" class="metric-value"><span class="loading-line"></span></strong><div class="metric-meta">最近 100 条内统计</div></article><article class="metric-card"><span class="metric-label">累计 Token</span><strong id="tokenMetric" class="metric-value"><span class="loading-line"></span></strong><div class="metric-meta">输入与输出合计</div></article><article class="metric-card"><span class="metric-label">可用设备 Key</span><strong id="keyMetric" class="metric-value"><span class="loading-line"></span></strong><div class="metric-meta">当前有效凭据</div></article></div><div class="overview-grid"><div><section class="work-panel"><div class="panel-header"><div><h2>Mod 配置</h2><p>官方托管服务连接参数</p></div><span id="setupKeyState" class="status-badge warning">正在检查</span></div><div class="panel-body"><dl class="config-list"><div class="config-row"><dt>Base URL</dt><dd><code id="setupBaseUrl" class="config-value">https://www.vivantvalley.com.cn/v1</code></dd><button class="button-secondary button-small" type="button" data-copy="https://www.vivantvalley.com.cn/v1" data-copy-message="Base URL 已复制">复制</button></div><div class="config-row"><dt>模型</dt><dd><code id="setupModel" class="config-value">vv-dialogue</code></dd><button class="button-secondary button-small" type="button" data-copy="vv-dialogue" data-copy-message="模型名已复制">复制</button></div><div class="config-row"><dt>API Key</dt><dd><span class="config-value">使用你创建的 vv_live_... 设备 Key</span></dd><button class="button-secondary button-small" type="button" data-open-key-dialog>新建</button></div></dl></div></section><section class="work-panel"><div class="panel-header"><div><h2>最近调用</h2><p>最近 5 条模型请求</p></div><button class="button-quiet button-small" type="button" data-view="usage">查看全部</button></div><div id="recentUsage"></div></section></div><aside class="work-panel"><div class="panel-header"><div><h2>可用模型</h2><p>公开模型别名和当前价格</p></div></div><div id="modelList" class="panel-body model-list"><span class="loading-line"></span></div></aside></div></section><section class="page-panel" data-panel="keys"><div class="page-heading"><div><h1>设备 Key</h1><p>为每台设备使用独立凭据，遗失后可单独撤销。</p></div><div class="heading-actions"><button class="button-secondary" type="button" data-refresh>刷新</button><button type="button" data-open-key-dialog>创建 Key</button></div></div><section class="work-panel"><div class="panel-header"><div><h2>设备凭据</h2><p>Key 明文仅在创建成功时显示一次</p></div></div><div id="keysTable"><div class="empty-state"><div>正在加载...</div></div></div></section></section><section class="page-panel" data-panel="usage"><div class="page-heading"><div><h1>调用记录</h1><p>查看模型、Token、扣费和请求结果。</p></div><div class="heading-actions"><button class="button-secondary" type="button" data-refresh>刷新</button></div></div><section class="work-panel"><div class="panel-header"><div><h2>请求明细</h2><p id="usageCountLabel">正在加载...</p></div><div class="filter-bar"><label class="visually-hidden" for="usageModelFilter">模型</label><select id="usageModelFilter"><option value="">全部模型</option></select><label class="visually-hidden" for="usageStatusFilter">状态</label><select id="usageStatusFilter"><option value="">全部状态</option><option value="completed">成功</option><option value="failed">失败</option><option value="in_progress">处理中</option></select></div></div><div id="usageTable"><div class="empty-state"><div>正在加载...</div></div></div></section></section><section class="page-panel" data-panel="credits"><div class="page-heading"><div><h1>额度中心</h1><p>兑换额度并核对每笔账户变动。</p></div><div class="heading-actions"><button class="button-secondary" type="button" data-refresh>刷新</button></div></div><div class="redeem-layout"><section class="work-panel"><div class="panel-header"><div><h2>兑换码</h2><p>有效兑换码会立即增加账户额度</p></div></div><div class="panel-body"><form id="redeemForm" class="redeem-form"><div class="field-group"><label for="redeemCode">兑换码</label><input id="redeemCode" type="text" required maxlength="128" autocomplete="off" placeholder="vv_redeem_..."></div><button id="redeemSubmit" type="submit">兑换</button></form></div></section><aside class="credit-summary"><span class="metric-label">当前可用额度</span><strong id="creditBalance" class="metric-value">...</strong><p class="credit-note">另有 <span id="creditReserved">0</span> 额度正在请求中预留。</p></aside></div><section class="work-panel"><div class="panel-header"><div><h2>额度流水</h2><p>充值、兑换、预留、结算和退回记录</p></div></div><div id="ledgerTable"><div class="empty-state"><div>正在加载...</div></div></div></section></section></main></div><dialog id="createKeyDialog"><form id="createKeyForm"><div class="dialog-header"><h2>创建设备 Key</h2><p>建议每台电脑创建一个独立 Key。</p></div><div class="dialog-body"><div class="field-group"><label for="keyLabel">设备名称</label><input id="keyLabel" type="text" required maxlength="80" placeholder="例如：家用电脑"></div><div class="field-group"><label for="keyExpiry">有效期</label><select id="keyExpiry"><option value="0">永不过期</option><option value="30">30 天</option><option value="90">90 天</option><option value="365">365 天</option></select></div></div><div class="dialog-actions"><button class="button-secondary" type="button" data-close-dialog="createKeyDialog">取消</button><button id="createKeySubmit" type="submit">创建 Key</button></div></form></dialog><dialog id="createdKeyDialog"><div class="dialog-header"><h2>设备 Key 已创建</h2><p>关闭后无法再次查看完整内容。</p></div><div class="dialog-body"><div class="secret-box"><code id="createdKeyValue" class="secret-value"></code></div><p class="secret-warning">请妥善保管，不要发送给其他人或填写到非官方网页。</p></div><div class="dialog-actions"><button id="copyCreatedKey" class="button-secondary" type="button" data-copy="" data-copy-message="设备 Key 已复制">复制 Key</button><button type="button" data-close-dialog="createdKeyDialog">我已保存</button></div></dialog><div id="toastRegion" class="toast-region" aria-live="polite"></div>`;
  // The web console keeps legacy device-key management for older Mod builds;
  // new players authenticate directly inside the Mod with a hosted session.
  return userShell("用户控制台", "console-page", content, "/assets/app.js");
}

function adminPage() {
  const content = `<header class="top"><div class="wrap row"><div class="brand">Vivant Valley · 管理员控制台</div><div class="actions"><a href="/app" style="color:#fff">用户控制台</a><button id="logout" class="secondary">退出</button></div></div></header><main class="wrap"><div id="message" class="notice hidden"></div><section class="grid"><div class="panel"><div class="muted">请求总数</div><div id="requests" class="stat">...</div></div><div class="panel"><div class="muted">用户扣费</div><div id="charges" class="stat">...</div></div><div class="panel"><div class="muted">预计毛利</div><div id="margin" class="stat">...</div></div></section><section class="panel"><h2>上游供应商</h2><p class="muted">API Key 只在提交时接收，服务端以加密形式保存，列表只显示掩码。环境变量默认上游仅用于兼容旧配置。</p><form id="providerForm" class="grid"><input id="providerId" type="hidden"><div class="field"><label>名称</label><input id="providerName" required maxlength="80" placeholder="DeepSeek 主账号"></div><div class="field"><label>Base URL</label><input id="providerBaseUrl" required maxlength="300" placeholder="https://api.deepseek.com"></div><div class="field"><label>默认模型</label><input id="providerModel" maxlength="128" placeholder="deepseek-chat"></div><div class="field"><label>API Key <span class="muted">编辑时留空表示不更换</span></label><input id="providerApiKey" type="password" autocomplete="new-password" placeholder="sk-..."></div><div class="actions"><button id="saveProvider" type="submit">添加上游</button><button id="clearProvider" type="button" class="secondary">清空</button></div></form><div id="providers"></div></section><section class="panel"><h2>用户管理</h2><div id="users"></div></section><section class="panel"><h2>模型路由与价格</h2><p class="muted">用户只看到模型别名；每个别名可绑定不同供应商和上游模型。</p><div id="models"></div></section><section class="panel"><h2>注册和兑换码</h2><label><input id="inviteRequired" type="checkbox"> 要求邀请码注册</label><button id="saveInvite">保存</button><hr><div class="actions"><input id="redeemValue" type="number" placeholder="兑换额度 micros"><input id="redeemUses" type="number" value="1" min="1" placeholder="使用次数"><button id="createRedeem">创建兑换码</button></div><div id="createdCode" class="keybox hidden"></div></section></main>`;
  const script = `<script>const csrf=()=>decodeURIComponent((document.cookie.match(/(?:^|; )vv_csrf=([^;]*)/)||[])[1]||'');const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const show=(text,ok=false)=>{message.textContent=text;message.className='notice '+(ok?'success':'error');message.classList.remove('hidden')};const api=async(path,opts={})=>{opts.headers={...(opts.headers||{}),'x-csrf-token':csrf()};const r=await fetch(path,opts);const d=r.status===204?null:await r.json();if(!r.ok)throw new Error(d?.error?.message||'请求失败');return d};let providerCache=[];function renderProviders(items){providerCache=items;providers.innerHTML='<table><tr><th>名称</th><th>Base URL</th><th>Key</th><th>状态</th><th>最近检测</th><th>操作</th></tr>'+items.map(x=>'<tr><td>'+esc(x.name)+(x.source==='environment'?' <span class="muted">（环境变量）</span>':'')+'</td><td><code>'+esc(x.baseUrl)+'</code></td><td><code>'+esc(x.keyHint)+'</code></td><td>'+(x.enabled?'启用':'停用')+'</td><td>'+esc(x.lastCheckStatus||'未检测')+'</td><td>'+(x.source==='managed'?'<button data-edit-provider="'+x.id+'">编辑</button> <button class="secondary" data-toggle-provider="'+x.id+'" data-enabled="'+x.enabled+'">'+(x.enabled?'停用':'启用')+'</button> <button class="secondary" data-test-provider="'+x.id+'">检测</button> <button class="danger" data-delete-provider="'+x.id+'">删除</button>':'<span class="muted">由 .env 管理</span>')+'</td></tr>').join('')+'</table>'}function renderModels(items){const opts='<option value="">环境变量默认上游</option>'+providerCache.filter(x=>x.source==='managed').map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join('');models.innerHTML='<table><tr><th>别名</th><th>供应商</th><th>上游模型</th><th>输入/1K</th><th>输出/1K</th><th>启用</th><th>操作</th></tr>'+items.map(x=>'<tr data-model-row="'+esc(x.alias)+'"><td><code>'+esc(x.alias)+'</code></td><td><select data-provider>'+opts+'</select></td><td><input data-provider-model value="'+esc(x.providerModel||'')+'" maxlength="128"></td><td><input data-input-price type="number" value="'+x.inputMicrosPer1k+'" min="0"></td><td><input data-output-price type="number" value="'+x.outputMicrosPer1k+'" min="0"></td><td>'+x.enabled+'</td><td><button data-save-model="'+esc(x.alias)+'">保存</button></td></tr>').join('')+'</table>';items.forEach(x=>{const row=models.querySelector('[data-model-row="'+CSS.escape(x.alias)+'"]');if(row)row.querySelector('[data-provider]').value=x.providerId||''})}async function load(){try{const me=await api('/api/v1/me');if(me.role!=='admin')return location.href='/app';const p=await api('/api/v1/admin/providers');renderProviders(p.items);const u=await api('/api/v1/admin/users');users.innerHTML='<table><tr><th>邮箱</th><th>状态</th><th>余额</th><th>操作</th></tr>'+u.items.map(x=>'<tr><td>'+esc(x.email)+'</td><td>'+esc(x.status)+'</td><td>'+x.wallet.available_micros+'</td><td><button data-topup="'+x.id+'">充值 100000</button> <button class="secondary" data-toggle-user="'+x.id+'" data-status="'+x.status+'">'+(x.status==='active'?'封禁':'解封')+'</button></td></tr>').join('')+'</table>';const s=await api('/api/v1/admin/usage');requests.textContent=s.requests;charges.textContent=s.user_charge_micros.toLocaleString();margin.textContent=s.margin_micros.toLocaleString();const m=await api('/api/v1/admin/models');renderModels(m.items);const gate=await api('/api/v1/admin/settings/registration');inviteRequired.checked=gate.invite_required}catch(e){if(String(e.message).includes('登录'))location.href='/login';else show(e.message)}}async function saveProviderForm(e){e.preventDefault();try{const id=providerId.value;const body={name:providerName.value,base_url:providerBaseUrl.value,default_model:providerModel.value};if(providerApiKey.value)body.api_key=providerApiKey.value;const d=await api(id?'/api/v1/admin/providers/'+id:'/api/v1/admin/providers',{method:id?'PATCH':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});show(id?'上游已更新。':'上游已添加。',true);clearProviderForm();load()}catch(e){show(e.message)}}function clearProviderForm(){providerId.value='';providerName.value='';providerBaseUrl.value='';providerModel.value='';providerApiKey.value='';saveProvider.textContent='添加上游'}function editProvider(id){const p=providerCache.find(x=>x.id===id);if(!p)return;providerId.value=p.id;providerName.value=p.name;providerBaseUrl.value=p.baseUrl;providerModel.value=p.defaultModel;providerApiKey.value='';saveProvider.textContent='保存上游';window.scrollTo({top:0,behavior:'smooth'})}async function toggleProvider(id,enabled){try{await api('/api/v1/admin/providers/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:!enabled})});show('上游状态已更新。',true);load()}catch(e){show(e.message)}}async function testProvider(id){try{const d=await api('/api/v1/admin/providers/'+id+'/test',{method:'POST'});show('上游检测成功，HTTP '+d.status+'.',true);load()}catch(e){show(e.message);load()}}async function deleteProvider(id){if(!window.confirm('删除上游？已绑定模型必须先切换。'))return;try{await api('/api/v1/admin/providers/'+id,{method:'DELETE'});show('上游已删除。',true);load()}catch(e){show(e.message)}}async function topUp(id){try{await api('/api/v1/admin/users/'+id+'/credits',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amount_micros:100000,reason:'管理员充值'})});show('充值成功。',true);load()}catch(e){show(e.message)}}async function toggleUser(id,status){try{await api('/api/v1/admin/users/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:status==='active'?'suspended':'active'})});show('用户状态已更新。',true);load()}catch(e){show(e.message)}}async function saveModel(alias,row){try{await api('/api/v1/admin/models/'+encodeURIComponent(alias),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({providerId:row.querySelector('[data-provider]').value||null,providerModel:row.querySelector('[data-provider-model]').value,inputMicrosPer1k:Number(row.querySelector('[data-input-price]').value),outputMicrosPer1k:Number(row.querySelector('[data-output-price]').value)})});show('模型路由和价格已保存。',true);load()}catch(e){show(e.message)}}providerForm.addEventListener('submit',saveProviderForm);clearProvider.onclick=clearProviderForm;document.addEventListener('click',(event)=>{const edit=event.target.closest('[data-edit-provider]');if(edit)return editProvider(edit.dataset.editProvider);const toggle=event.target.closest('[data-toggle-provider]');if(toggle)return toggleProvider(toggle.dataset.toggleProvider,toggle.dataset.enabled==='true');const test=event.target.closest('[data-test-provider]');if(test)return testProvider(test.dataset.testProvider);const del=event.target.closest('[data-delete-provider]');if(del)return deleteProvider(del.dataset.deleteProvider);const top=event.target.closest('[data-topup]');if(top)return topUp(top.dataset.topup);const userToggle=event.target.closest('[data-toggle-user]');if(userToggle)return toggleUser(userToggle.dataset.toggleUser,userToggle.dataset.status);const model=event.target.closest('[data-save-model]');if(model)return saveModel(model.dataset.saveModel,model.closest('[data-model-row]'))});saveInvite.onclick=async()=>{try{await api('/api/v1/admin/settings/registration',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({invite_required:inviteRequired.checked})});show('注册设置已保存。',true)}catch(e){show(e.message)}};createRedeem.onclick=async()=>{try{const d=await api('/api/v1/admin/redeem-codes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value_micros:Number(redeemValue.value),max_uses:Number(redeemUses.value)})});createdCode.textContent=d.code;createdCode.classList.remove('hidden');show('兑换码已创建，请保存明文。',true)}catch(e){show(e.message)}};logout.onclick=async()=>{try{await api('/api/v1/auth/logout',{method:'POST'});location.href='/login'}catch(e){show(e.message)}};load();</script>`;
  return shell("管理员控制台", content, script);
}

function adminPageWithRuntime() {
  const runtimePanel = `<section class="panel"><h2>运行模式</h2><div class="actions"><label><input id="demoMode" type="checkbox"> 演示模式</label><button id="saveRuntime">保存</button><span id="runtimeState" class="muted"></span></div><p class="muted">开启时不会调用任何真实上游，只返回 Demo 响应；关闭后才会按模型路由调用已配置的供应商。</p></section>`;
  const runtimeScript = `<script>(()=>{const csrf=()=>decodeURIComponent((document.cookie.match(/(?:^|; )vv_csrf=([^;]*)/)||[])[1]||'');const runtimeApi=async(path,opts={})=>{opts.headers={...(opts.headers||{}),'x-csrf-token':csrf()};const r=await fetch(path,opts);const d=r.status===204?null:await r.json();if(!r.ok)throw new Error(d?.error?.message||'请求失败');return d};const state=document.getElementById('runtimeState');const checkbox=document.getElementById('demoMode');const save=document.getElementById('saveRuntime');if(!checkbox||!save)return;const render=(enabled)=>{checkbox.checked=Boolean(enabled);state.textContent=enabled?'当前：演示模式，不调用真实上游':'当前：真实上游已启用'};runtimeApi('/api/v1/admin/settings/runtime').then((d)=>render(d.demo_mode)).catch((error)=>{state.textContent=error.message});save.addEventListener('click',async()=>{save.disabled=true;try{const d=await runtimeApi('/api/v1/admin/settings/runtime',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({demo_mode:checkbox.checked})});render(d.demo_mode);if(typeof show==='function')show(d.demo_mode?'已开启演示模式。':'已关闭演示模式，后续请求将调用真实上游。',true)}catch(error){if(typeof show==='function')show(error.message)}finally{save.disabled=false}})})();</script>`;
  const batchPanel = `<section class="panel"><h2>卡密批量生成</h2><p class="muted">每次生成固定 100 张一次性卡密。卡密明文只在本次生成结果中显示，请立即下载保存；服务器仅保存哈希。</p><div class="actions"><button type="button" data-card-denomination="1">生成 1 元 × 100</button><button type="button" data-card-denomination="5">生成 5 元 × 100</button><button type="button" data-card-denomination="10">生成 10 元 × 100</button><button type="button" data-card-denomination="20">生成 20 元 × 100</button></div><div id="cardBatchMessage" class="notice hidden"></div><div id="cardBatchResult" class="hidden"><p><strong id="cardBatchSummary"></strong></p><textarea id="cardBatchCodes" rows="12" readonly spellcheck="false" style="width:100%;font-family:monospace"></textarea><div class="actions" style="margin-top:10px"><button id="downloadCardBatch" type="button">下载 TXT</button><button id="copyCardBatch" type="button" class="secondary">复制全部卡密</button></div></div><h3 style="margin-top:24px">已生成批次</h3><div id="cardBatchList"><p class="muted">正在加载...</p></div></section>`;
  const batchScript = `<script>(()=>{const csrf=()=>decodeURIComponent((document.cookie.match(/(?:^|; )vv_csrf=([^;]*)/)||[])[1]||'');const api=async(path,opts={})=>{opts.headers={...(opts.headers||{}),'x-csrf-token':csrf()};const response=await fetch(path,opts);const data=response.status===204?null:await response.json();if(!response.ok)throw new Error(data?.error?.message||'请求失败');return data};const message=document.getElementById('cardBatchMessage');const result=document.getElementById('cardBatchResult');const summary=document.getElementById('cardBatchSummary');const codes=document.getElementById('cardBatchCodes');const list=document.getElementById('cardBatchList');let downloadName='vivant-valley-card-codes.txt';const show=(text,ok=false)=>{message.textContent=text;message.className='notice '+(ok?'success':'error');message.classList.remove('hidden')};const esc=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));const downloadText=(text,name)=>{const blob=new Blob([text.endsWith('\\n')?text:text+'\\n'],{type:'text/plain;charset=utf-8'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000)};const render=async()=>{try{const data=await api('/api/v1/admin/redeem-batches');if(!data.items.length){list.innerHTML='<p class="muted">暂无批次。</p>';return}list.innerHTML='<table><tr><th>批次</th><th>面额</th><th>数量</th><th>剩余</th><th>状态</th><th>创建时间</th><th>操作</th></tr>'+data.items.map((item)=>'<tr><td><code>'+esc(item.id.slice(0,8))+'...</code></td><td>'+item.denomination_yuan+' 元</td><td>'+item.code_count+'</td><td>'+item.remaining_count+'</td><td>'+(item.disabled?'已停用':'可用')+'</td><td>'+esc(item.created_at)+'</td><td><button type="button" class="secondary" data-download-batch="'+esc(item.id)+'">下载卡密</button> '+(item.disabled||item.remaining_count===0?'':'<button type="button" class="danger" data-disable-batch="'+esc(item.id)+'">停用</button>')+'</td></tr>').join('')+'</table>'}catch(error){list.innerHTML='<p class="error">'+esc(error.message)+'</p>'}};const setBusy=(busy)=>document.querySelectorAll('[data-card-denomination]').forEach((button)=>{button.disabled=busy});document.querySelectorAll('[data-card-denomination]').forEach((button)=>button.addEventListener('click',async()=>{const denomination=Number(button.dataset.cardDenomination);setBusy(true);try{const data=await api('/api/v1/admin/redeem-batches',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({denomination_yuan:denomination})});codes.value=data.codes_text;downloadName=data.download_name;summary.textContent=denomination+' 元批次已生成：'+data.codes.length+' 张';result.classList.remove('hidden');show('卡密已生成，请立即下载并保存。',true);downloadText(data.codes_text,data.download_name);render()}catch(error){show(error.message)}finally{setBusy(false)}}));document.getElementById('downloadCardBatch')?.addEventListener('click',()=>downloadText(codes.value,downloadName));document.getElementById('copyCardBatch')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(codes.value);show('卡密已复制。',true)}catch{show('浏览器不允许自动复制，请手动复制文本。')}});document.addEventListener('click',async(event)=>{const download=event.target.closest('[data-download-batch]');if(download){download.disabled=true;try{const data=await api('/api/v1/admin/redeem-batches/'+encodeURIComponent(download.dataset.downloadBatch)+'/codes');downloadText(data.codes_text,data.download_name);show('卡密已下载。',true)}catch(error){show(error.message)}finally{download.disabled=false}return}const button=event.target.closest('[data-disable-batch]');if(!button)return;if(!window.confirm('停用该批次后，剩余卡密将无法兑换，确定继续吗？'))return;button.disabled=true;try{await api('/api/v1/admin/redeem-batches/'+encodeURIComponent(button.dataset.disableBatch)+'/disable',{method:'POST'});show('批次已停用。',true);render()}catch(error){show(error.message)}finally{button.disabled=false}});render()})();</script>`;
  return adminPage()
    .replace('<section class="panel"><h2>上游供应商</h2>', `${runtimePanel}<section class="panel"><h2>上游供应商</h2>`)
    .replace('</main>', `${batchPanel}</main>`)
    .replace('</body>', `${runtimeScript}${batchScript}</body>`);
}

function web(req, res, url) {
  if (req.method !== "GET") return sendJson(res, 405, errorResponse("Method Not Allowed", "validation_error", "method_not_allowed"));
  if (url.pathname === "/" || url.pathname === "/login") return sendHtml(res, authPageV2(false));
  if (url.pathname === "/register") return sendHtml(res, authPageV2(true));
  if (url.pathname === "/app") return sendHtml(res, appPageV2());
  if (url.pathname === "/admin") {
    const current = session(req);
    if (!adminGatePassed(req) || current?.user.role !== "admin") return sendHtml(res, config.adminPagePassword ? adminAccessPage() : authPage(false));
    return sendHtml(res, adminPageWithRuntime());
  }
  return sendJson(res, 404, errorResponse("页面不存在。", "validation_error", "not_found"));
}

const server = http.createServer((req, res) => {
  res.setHeader("x-content-type-options", "nosniff");
  let url;
  try { url = parseUrl(req); } catch { return sendJson(res, 400, errorResponse("请求地址无效。")); }
  if (req.method === "GET" && url.pathname.startsWith("/assets/")) return sendAsset(res, url.pathname) || sendJson(res, 404, errorResponse("资源不存在。", "validation_error", "not_found"));
  if (url.pathname === "/health" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/") || url.pathname === "/chat/completions") return api(req, res, url);
  return web(req, res, url);
});

server.listen(config.port, config.host, () => {
  console.log(`Vivant Valley backend demo listening on http://${config.host}:${config.port}`);
  console.log(`Data file: ${config.dataFile}`);
  console.log(`Mode: ${config.demoMode || !config.upstreamApiKey ? "demo" : "upstream"}`);
  console.log(`Admin: ${process.env.ADMIN_EMAIL || "admin@example.com"}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
