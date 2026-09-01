import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const port = 18987;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vivant-valley-demo-"));
const child = spawn(process.execPath, ["server.js"], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  env: { ...process.env, PORT: String(port), DATA_FILE: path.join(temp, "db.json"), DEMO_MODE: "true", ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "admin-password-123", ADMIN_PAGE_PASSWORD: "admin-page-password-123" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

try {
  await waitForHealth();
  const user = await request("/api/v1/auth/register", { method: "POST", body: { email: "player@example.com", password: "player-password-123" } });
  assert.equal(user.status, 201);
  const cookies = user.cookies;
  const csrf = cookies.match(/(?:^|; )vv_csrf=([^;]+)/)?.[1];
  assert.ok(csrf);
  const authPage = await request("/login", { raw: true });
  assert.equal(authPage.status, 200);
  assert.match(authPage.text, /data-auth-mode="login"/);
  assert.match(authPage.text, /user\.css/);
  const catalog = await request("/api/v1/catalog", { cookies });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.base_url, "https://www.vivantvalley.com.cn/v1");
  assert.ok(catalog.data.items.some((model) => model.alias === "vv-dialogue"));
  const appPage = await request("/app", { raw: true });
  assert.equal(appPage.status, 200);
  assert.match(appPage.text, /账户概览/);
  const css = await request("/assets/user.css", { raw: true });
  assert.equal(css.status, 200);
  assert.match(css.contentType, /text\/css/);
  const key = await request("/api/v1/keys", { method: "POST", cookies, csrf, body: { label: "smoke laptop" } });
  assert.equal(key.status, 201);
  assert.match(key.data.key, /^vv_live_[A-Za-z0-9_-]{32,}$/);
  const models = await request("/v1/models", { headers: { authorization: `Bearer ${key.data.key}` } });
  assert.equal(models.status, 200);
  assert.ok(models.data.data.some((model) => model.id === "vv-dialogue"));
  const insufficient = await request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key.data.key}`, "idempotency-key": "smoke-1" }, body: { model: "vv-dialogue", messages: [{ role: "user", content: "hello" }], max_tokens: 64 } });
  assert.equal(insufficient.status, 402);

  const admin = await request("/api/v1/auth/login", { method: "POST", body: { email: "admin@example.com", password: "admin-password-123" } });
  assert.equal(admin.status, 200);
  const blockedAdminApi = await request("/api/v1/admin/settings/runtime", { cookies: admin.cookies });
  assert.equal(blockedAdminApi.status, 401);
  assert.equal(blockedAdminApi.data.error.code, "admin_gate_required");
  const lockedAdminPage = await request("/admin", { raw: true });
  assert.equal(lockedAdminPage.status, 200);
  assert.match(lockedAdminPage.text, /管理员访问/);
  const badAdminAccess = await request("/api/v1/admin/access", { method: "POST", body: { password: "wrong-password" } });
  assert.equal(badAdminAccess.status, 401);
  const adminAccess = await request("/api/v1/admin/access", { method: "POST", body: { password: "admin-page-password-123" } });
  assert.equal(adminAccess.status, 200);
  assert.equal(adminAccess.data.user.role, "admin");
  assert.match(adminAccess.cookies, /vv_admin_gate=/);
  const adminCsrf = adminAccess.cookies.match(/(?:^|; )vv_csrf=([^;]+)/)?.[1];
  const openAdminPage = await request("/admin", { cookies: adminAccess.cookies, raw: true });
  assert.equal(openAdminPage.status, 200);
  assert.match(openAdminPage.text, /管理员控制台/);
  const runtimeBefore = await request("/api/v1/admin/settings/runtime", { cookies: adminAccess.cookies });
  assert.equal(runtimeBefore.status, 200);
  assert.equal(runtimeBefore.data.demo_mode, true);
  const runtimeLive = await request("/api/v1/admin/settings/runtime", { method: "PATCH", cookies: adminAccess.cookies, csrf: adminCsrf, body: { demo_mode: false } });
  assert.equal(runtimeLive.status, 200);
  assert.equal(runtimeLive.data.demo_mode, false);
  const runtimeDemo = await request("/api/v1/admin/settings/runtime", { method: "PATCH", cookies: adminAccess.cookies, csrf: adminCsrf, body: { demo_mode: true } });
  assert.equal(runtimeDemo.status, 200);
  assert.equal(runtimeDemo.data.demo_mode, true);
  const topup = await request(`/api/v1/admin/users/${user.data.user.id}/credits`, { method: "POST", cookies: adminAccess.cookies, csrf: adminCsrf, body: { amount_micros: 100000, reason: "smoke" } });
  assert.equal(topup.status, 200);
  const completion = await request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key.data.key}`, "idempotency-key": "smoke-2" }, body: { model: "vv-dialogue", messages: [{ role: "user", content: "hello" }], max_tokens: 64 } });
  assert.equal(completion.status, 200);
  assert.equal(completion.data.model, "vv-dialogue");
  const replay = await request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key.data.key}`, "idempotency-key": "smoke-2" }, body: { model: "vv-dialogue", messages: [{ role: "user", content: "hello" }], max_tokens: 64 } });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, completion.data.id);
  const stream = await request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key.data.key}`, "idempotency-key": "smoke-3" }, body: { model: "vv-dialogue", messages: [{ role: "user", content: "hello" }], stream: true, max_tokens: 64 }, raw: true });
  assert.equal(stream.status, 200);
  assert.match(stream.text, /data: \[DONE\]/);
  const adminModels = await request("/api/v1/admin/models", { cookies: adminAccess.cookies });
  assert.equal(adminModels.status, 200);
  const createdProvider = await request("/api/v1/admin/providers", { method: "POST", cookies: adminAccess.cookies, csrf: adminCsrf, body: { name: "Smoke provider", base_url: "https://api.example.com/v1", default_model: "smoke-model", api_key: "sk-smoke-provider-secret" } });
  assert.equal(createdProvider.status, 201);
  assert.equal(createdProvider.data.keyHint, "sk-s...cret");
  assert.ok(!JSON.stringify(createdProvider.data).includes("sk-smoke-provider-secret"));
  const listedProviders = await request("/api/v1/admin/providers", { cookies: adminAccess.cookies });
  assert.equal(listedProviders.status, 200);
  assert.ok(listedProviders.data.items.some((provider) => provider.id === createdProvider.data.id));
  assert.ok(!JSON.stringify(listedProviders.data).includes("sk-smoke-provider-secret"));
  const boundModel = await request("/api/v1/admin/models/vv-dialogue", { method: "PATCH", cookies: adminAccess.cookies, csrf: adminCsrf, body: { providerId: createdProvider.data.id, providerModel: "smoke-model" } });
  assert.equal(boundModel.status, 200);
  assert.equal(boundModel.data.providerId, createdProvider.data.id);
  const inUseProvider = await request(`/api/v1/admin/providers/${createdProvider.data.id}`, { method: "DELETE", cookies: adminAccess.cookies, csrf: adminCsrf });
  assert.equal(inUseProvider.status, 409);
  const unboundModel = await request("/api/v1/admin/models/vv-dialogue", { method: "PATCH", cookies: adminAccess.cookies, csrf: adminCsrf, body: { providerId: null } });
  assert.equal(unboundModel.status, 200);
  const deletedProvider = await request(`/api/v1/admin/providers/${createdProvider.data.id}`, { method: "DELETE", cookies: adminAccess.cookies, csrf: adminCsrf });
  assert.equal(deletedProvider.status, 204);
  const updatedModel = await request("/api/v1/admin/models/vv-fast", { method: "PATCH", cookies: adminAccess.cookies, csrf: adminCsrf, body: { inputMicrosPer1k: 701 } });
  assert.equal(updatedModel.status, 200);
  assert.equal(updatedModel.data.inputMicrosPer1k, 701);
  const createdRedeem = await request("/api/v1/admin/redeem-codes", { method: "POST", cookies: adminAccess.cookies, csrf: adminCsrf, body: { value_micros: 5000, max_uses: 1 } });
  assert.equal(createdRedeem.status, 201);
  const redeemed = await request("/api/v1/redeem", { method: "POST", cookies, csrf, body: { code: createdRedeem.data.code } });
  assert.equal(redeemed.status, 200);
  const listedKeys = await request("/api/v1/keys", { cookies });
  const revoked = await request(`/api/v1/keys/${listedKeys.data.items[0].id}`, { method: "DELETE", cookies, csrf });
  assert.equal(revoked.status, 204);
  const revokedModels = await request("/v1/models", { headers: { authorization: `Bearer ${key.data.key}` } });
  assert.equal(revokedModels.status, 401);
  console.log("backend demo smoke checks passed");
} catch (error) {
  console.error(output);
  throw error;
} finally {
  child.kill("SIGTERM");
  fs.rmSync(temp, { recursive: true, force: true });
  if (output.includes("UnhandledPromiseRejection")) console.error(output);
}

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // server is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${output}`);
}

async function request(route, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (options.cookies) headers.cookie = options.cookies;
  if (options.csrf) headers["x-csrf-token"] = options.csrf;
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: options.method || "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const setCookies = response.headers.getSetCookie?.() || [];
  const cookies = setCookies.map((value) => value.split(";", 1)[0]).join("; ") || options.cookies || "";
  const text = await response.text();
  if (options.raw) return { status: response.status, text, cookies, contentType: response.headers.get("content-type") || "" };
  return { status: response.status, data: text ? JSON.parse(text) : null, cookies };
}
