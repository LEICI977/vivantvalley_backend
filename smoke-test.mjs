import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = 18987;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vivant-valley-demo-"));
const child = spawn(process.execPath, ["server.js"], {
  cwd: path.dirname(fileURLToPath(import.meta.url)),
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
  const modLogin = await request("/api/v1/mod/auth/login", { method: "POST", body: { email: "player@example.com", password: "player-password-123" } });
  assert.equal(modLogin.status, 200);
  assert.match(modLogin.data.access_token, /^vv_mod_[A-Za-z0-9_-]{32,}$/);
  const modToken = modLogin.data.access_token;
  const bootstrap = await request("/api/v1/mod/bootstrap", { headers: { authorization: `Bearer ${modToken}` } });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.base_url, "https://www.vivantvalley.com.cn/v1");
  assert.ok(bootstrap.data.models.some((model) => model.alias === "vv-dialogue"));
  const models = await request("/v1/models", { headers: { authorization: `Bearer ${key.data.key}` } });
  assert.equal(models.status, 200);
  assert.ok(models.data.data.some((model) => model.id === "vv-dialogue"));
  const modModels = await request("/v1/models", { headers: { authorization: `Bearer ${modToken}` } });
  assert.equal(modModels.status, 200);
  assert.ok(modModels.data.data.some((model) => model.id === "vv-dialogue"));
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
  assert.match(openAdminPage.text, /data-card-denomination/);
  const adminInlineScripts = openAdminPage.text.split("<script>").slice(1).map((part) => part.split("</script>")[0]);
  assert.ok(adminInlineScripts.length >= 3);
  adminInlineScripts.forEach((script) => assert.doesNotThrow(() => new Function(script)));
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
  const suspended = await request(`/api/v1/admin/users/${user.data.user.id}`, { method: "PATCH", cookies: adminAccess.cookies, csrf: adminCsrf, body: { status: "suspended" } });
  assert.equal(suspended.status, 200);
  const suspendedModels = await request("/v1/models", { headers: { authorization: `Bearer ${modToken}` } });
  assert.equal(suspendedModels.status, 403);
  const suspendedBootstrap = await request("/api/v1/mod/bootstrap", { headers: { authorization: `Bearer ${modToken}` } });
  assert.equal(suspendedBootstrap.status, 403);
  const suspendedRedeem = await request("/api/v1/mod/redeem", { method: "POST", headers: { authorization: `Bearer ${modToken}` }, body: { code: "not-used" } });
  assert.equal(suspendedRedeem.status, 403);
  const restored = await request(`/api/v1/admin/users/${user.data.user.id}`, { method: "PATCH", cookies: adminAccess.cookies, csrf: adminCsrf, body: { status: "active" } });
  assert.equal(restored.status, 200);
  const topup = await request(`/api/v1/admin/users/${user.data.user.id}/credits`, { method: "POST", cookies: adminAccess.cookies, csrf: adminCsrf, body: { amount_micros: 100000, reason: "smoke" } });
  assert.equal(topup.status, 200);
  const completion = await request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key.data.key}`, "idempotency-key": "smoke-2" }, body: { model: "vv-dialogue", messages: [{ role: "user", content: "hello" }], max_tokens: 64 } });
  assert.equal(completion.status, 200);
  assert.equal(completion.data.model, "vv-dialogue");
  const actionRound = await request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${modToken}`, "idempotency-key": "mod-tool-1" },
    body: {
      model: "vv-dialogue",
      messages: [{ role: "system", content: "Choose an allowed action." }, { role: "user", content: "Come to the mines with me." }],
      tools: [{ type: "function", function: { name: "invite_mine_guard", description: "Accept a mine invitation.", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
      tool_choice: "auto",
      stream: false,
      max_tokens: 256,
    },
  });
  assert.equal(actionRound.status, 200);
  const actionCall = actionRound.data.choices[0].message.tool_calls[0];
  assert.equal(actionCall.function.name, "invite_mine_guard");
  assert.equal(typeof actionCall.function.arguments, "string");
  const finalRound = await request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${modToken}`, "idempotency-key": "mod-tool-2" },
    body: {
      model: "vv-dialogue",
      messages: [
        { role: "system", content: "Return the final NPC response." },
        { role: "user", content: "Come to the mines with me." },
        actionRound.data.choices[0].message,
        { role: "tool", tool_call_id: actionCall.id, content: JSON.stringify({ ok: true, status: "completed" }) },
      ],
      tools: [{ type: "function", function: { name: "submit_final_response", description: "Submit the final response.", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "submit_final_response" } },
      stream: false,
      max_tokens: 512,
    },
  });
  assert.equal(finalRound.status, 200);
  const finalCall = finalRound.data.choices[0].message.tool_calls[0];
  assert.equal(finalCall.function.name, "submit_final_response");
  assert.equal(typeof finalCall.function.arguments, "string");
  const finalArguments = JSON.parse(finalCall.function.arguments);
  assert.equal(finalArguments.decision, "reply");
  assert.equal(finalArguments.memory_update.summary_patch, "");
  for (const signalName of ["valence", "warmth", "concern", "confidence"]) {
    assert.equal(typeof finalArguments.memory_update.signal[signalName], "number");
  }
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
  const createdRedeem = await request("/api/v1/admin/redeem-codes", { method: "POST", cookies: adminAccess.cookies, csrf: adminCsrf, body: { value_micros: 5000, max_uses: 2 } });
  assert.equal(createdRedeem.status, 201);
  const redeemed = await request("/api/v1/redeem", { method: "POST", cookies, csrf, body: { code: createdRedeem.data.code } });
  assert.equal(redeemed.status, 200);
  const modRedeemed = await request("/api/v1/mod/redeem", { method: "POST", headers: { authorization: `Bearer ${modToken}` }, body: { code: createdRedeem.data.code } });
  assert.equal(modRedeemed.status, 200);
  const batch = await request("/api/v1/admin/redeem-batches", { method: "POST", cookies: adminAccess.cookies, csrf: adminCsrf, body: { denomination_yuan: 5 } });
  assert.equal(batch.status, 201, JSON.stringify(batch.data));
  assert.equal(batch.data.batch.denomination_yuan, 5);
  assert.equal(batch.data.batch.value_micros, 5000000);
  assert.equal(batch.data.codes.length, 100);
  assert.equal(new Set(batch.data.codes).size, 100);
  assert.equal(batch.data.codes_text.split("\n").length, 100);
  assert.ok(batch.data.codes.every((code) => /^VV5-[A-F0-9]{24}$/.test(code)));
  const recoveredBatchCodes = await request(`/api/v1/admin/redeem-batches/${batch.data.batch.id}/codes`, { cookies: adminAccess.cookies });
  assert.equal(recoveredBatchCodes.status, 200);
  assert.equal(recoveredBatchCodes.data.codes_text, batch.data.codes_text);
  assert.ok(!JSON.stringify((await request("/api/v1/admin/redeem-batches", { cookies: adminAccess.cookies })).data).includes(batch.data.codes[0]));
  const batchList = await request("/api/v1/admin/redeem-batches", { cookies: adminAccess.cookies });
  assert.equal(batchList.status, 200);
  assert.equal(batchList.data.items[0].id, batch.data.batch.id);
  assert.equal(batchList.data.items[0].remaining_count, 100);
  const batchRedeemed = await request("/api/v1/redeem", { method: "POST", cookies, csrf, body: { code: batch.data.codes[0] } });
  assert.equal(batchRedeemed.status, 200);
  assert.equal(batchRedeemed.data.redeemed_value_micros, 5000000);
  const duplicateBatchRedeem = await request("/api/v1/redeem", { method: "POST", cookies, csrf, body: { code: batch.data.codes[0] } });
  assert.equal(duplicateBatchRedeem.status, 409);
  const modBatchRedeemed = await request("/api/v1/mod/redeem", { method: "POST", headers: { authorization: `Bearer ${modToken}` }, body: { code: batch.data.codes[1] } });
  assert.equal(modBatchRedeemed.status, 200);
  const inviteGateOn = await request("/api/v1/admin/settings/registration", { method: "PATCH", cookies: adminAccess.cookies, csrf: adminCsrf, body: { invite_required: true } });
  assert.equal(inviteGateOn.status, 200);
  const cardCannotInvite = await request("/api/v1/mod/auth/register", { method: "POST", body: { email: "card-invite-test@example.com", password: "card-invite-password-123", invitation_code: batch.data.codes[2] } });
  assert.equal(cardCannotInvite.status, 400);
  const inviteGateOff = await request("/api/v1/admin/settings/registration", { method: "PATCH", cookies: adminAccess.cookies, csrf: adminCsrf, body: { invite_required: false } });
  assert.equal(inviteGateOff.status, 200);
  const disabledBatch = await request(`/api/v1/admin/redeem-batches/${batch.data.batch.id}/disable`, { method: "POST", cookies: adminAccess.cookies, csrf: adminCsrf });
  assert.equal(disabledBatch.status, 200);
  assert.equal(disabledBatch.data.disabled, true);
  const disabledBatchRedeem = await request("/api/v1/redeem", { method: "POST", cookies, csrf, body: { code: batch.data.codes[2] } });
  assert.equal(disabledBatchRedeem.status, 409);
  const listedKeys = await request("/api/v1/keys", { cookies });
  const revoked = await request(`/api/v1/keys/${listedKeys.data.items[0].id}`, { method: "DELETE", cookies, csrf });
  assert.equal(revoked.status, 204);
  const revokedModels = await request("/v1/models", { headers: { authorization: `Bearer ${key.data.key}` } });
  assert.equal(revokedModels.status, 401);
  const modLogout = await request("/api/v1/mod/auth/logout", { method: "POST", headers: { authorization: `Bearer ${modToken}` } });
  assert.equal(modLogout.status, 204);
  const loggedOutModels = await request("/v1/models", { headers: { authorization: `Bearer ${modToken}` } });
  assert.equal(loggedOutModels.status, 401);
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
