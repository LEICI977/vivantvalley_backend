import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vivant-valley-provider-") );
const backendPort = 19091;
let upstreamCalls = [];
let upstream;
let child;

try {
  upstream = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      const body = JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      return res.end(body);
    }
    if (req.method === "POST" && req.url === "/bad/chat/completions") {
      res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      return res.end("<html><body>access denied</body></html>");
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404); return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    upstreamCalls.push({ authorization: req.headers.authorization, body: requestBody });
    const requestedTool = requestBody.tool_choice?.function?.name;
    const message = requestedTool
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_probe", type: "function", function: { name: requestedTool, arguments: JSON.stringify({ ok: true }) } }] }
      : { role: "assistant", content: "provider-ok" };
    const body = JSON.stringify({ id: "fake-completion", object: "chat.completion", model: "fake-model", choices: [{ index: 0, message, finish_reason: requestedTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, PORT: String(backendPort), HOST: "127.0.0.1", DATA_FILE: path.join(temp, "db.json"), DEMO_MODE: "false", UPSTREAM_API_KEY: "", ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "admin-password-123", ADMIN_PAGE_PASSWORD: "", BACKEND_PEPPER: "provider-smoke-pepper" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await waitForHealth(output);

  const user = await request("/api/v1/auth/register", { method: "POST", body: { email: "provider-player@example.com", password: "player-password-123" } });
  assert.equal(user.status, 201);
  const userCookies = user.cookies;
  const userCsrf = cookieValue(userCookies, "vv_csrf");
  const key = await request("/api/v1/keys", { method: "POST", cookies: userCookies, csrf: userCsrf, body: { label: "provider smoke" } });
  assert.equal(key.status, 201);
  const admin = await request("/api/v1/auth/login", { method: "POST", body: { email: "admin@example.com", password: "admin-password-123" } });
  assert.equal(admin.status, 200);
  const adminCsrf = cookieValue(admin.cookies, "vv_csrf");
  const topup = await request(`/api/v1/admin/users/${user.data.user.id}/credits`, { method: "POST", cookies: admin.cookies, csrf: adminCsrf, body: { amount_micros: 100000, reason: "provider smoke" } });
  assert.equal(topup.status, 200);
  const provider = await request("/api/v1/admin/providers", { method: "POST", cookies: admin.cookies, csrf: adminCsrf, body: { name: "Local fake upstream", base_url: `http://127.0.0.1:${upstreamPort}/v1`, default_model: "fake-model", api_key: "fake-provider-secret" } });
  assert.equal(provider.status, 201);
  const providerProbe = await request(`/api/v1/admin/providers/${provider.data.id}/test`, { method: "POST", cookies: admin.cookies, csrf: adminCsrf });
  assert.equal(providerProbe.status, 200, JSON.stringify(providerProbe.data));
  assert.equal(providerProbe.data.model, "fake-model");
  assert.equal(providerProbe.data.protocol, "chat_completions_tool_call");
  assert.equal(upstreamCalls[0].body.tool_choice.function.name, "vivant_valley_probe");
  const route = await request("/api/v1/admin/models/vv-dialogue", { method: "PATCH", cookies: admin.cookies, csrf: adminCsrf, body: { providerId: provider.data.id, providerModel: "fake-model" } });
  assert.equal(route.status, 200);
  const completion = await request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key.data.key}` }, body: { model: "vv-dialogue", messages: [{ role: "user", content: "hello" }], max_tokens: 64 } });
  assert.equal(completion.status, 200, JSON.stringify(completion.data));
  assert.equal(completion.data.choices[0].message.content, "provider-ok");
  assert.equal(upstreamCalls.length, 2);
  assert.equal(upstreamCalls[1].authorization, "Bearer fake-provider-secret");
  assert.equal(upstreamCalls[1].body.model, "fake-model");

  const badProvider = await request("/api/v1/admin/providers", { method: "POST", cookies: admin.cookies, csrf: adminCsrf, body: { name: "HTML error upstream", base_url: `http://127.0.0.1:${upstreamPort}/bad`, default_model: "fake-model", api_key: "fake-provider-secret" } });
  assert.equal(badProvider.status, 201);
  const badProbe = await request(`/api/v1/admin/providers/${badProvider.data.id}/test`, { method: "POST", cookies: admin.cookies, csrf: adminCsrf });
  assert.equal(badProbe.status, 502);
  assert.equal(badProbe.data.error.code, "provider_check_invalid_response");
  assert.match(badProbe.data.error.message, /HTTP 403/);
  assert.match(badProbe.data.error.message, /text\/html/);
  const badRoute = await request("/api/v1/admin/models/vv-fast", { method: "PATCH", cookies: admin.cookies, csrf: adminCsrf, body: { providerId: badProvider.data.id, providerModel: "fake-model" } });
  assert.equal(badRoute.status, 200);
  const badCompletion = await request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key.data.key}` }, body: { model: "vv-fast", messages: [{ role: "user", content: "hello" }], max_tokens: 64 } });
  assert.equal(badCompletion.status, 502);
  assert.equal(badCompletion.data.error.code, "invalid_upstream_response");
  assert.match(badCompletion.data.error.message, /HTTP 403/);
  assert.match(badCompletion.data.error.message, /text\/html/);
  console.log("managed provider routing smoke checks passed");
} catch (error) {
  console.error(error);
  throw error;
} finally {
  child?.kill("SIGTERM");
  upstream?.close();
  fs.rmSync(temp, { recursive: true, force: true });
}

function cookieValue(cookies, name) {
  return cookies.match(new RegExp(`(?:^|; )${name}=([^;]+)`))?.[1] || "";
}

async function waitForHealth(output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${backendPort}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`backend did not start: ${output}`);
}

async function request(route, options = {}) {
  const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) };
  if (options.cookies) headers.cookie = options.cookies;
  if (options.csrf) headers["x-csrf-token"] = options.csrf;
  const response = await fetch(`http://127.0.0.1:${backendPort}${route}`, { method: options.method || "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const cookies = response.headers.getSetCookie?.().map((value) => value.split(";", 1)[0]).join("; ") || options.cookies || "";
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null, cookies };
}
