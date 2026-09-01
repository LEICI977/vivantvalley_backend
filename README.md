# Vivant Valley Hosted Backend Demo

这是一个独立、可运行的后端 Demo，同时提供用户网页、管理员网页和
Vivant Valley Mod 的 OpenAI 兼容接口。它不修改
`/home/ubuntu/vivantvalley_no_langgraph` 中的 Mod。

Demo 使用本地 JSON 文件持久化，默认 `DEMO_MODE=true`，不需要第三方 API
Key 就能验收完整流程。首次启动时可用 `DEMO_MODE=false` 作为初始运行模式；
之后直接在管理员网页切换 Demo/真实上游。真实模式下请求会转发到 DeepSeek、
OpenAI 或其他兼容服务。生产版再切换到文档中规划的 PostgreSQL、Redis、
LiteLLM 和 Caddy 组合。

## Start

```sh
cp .env.example .env
npm start
```

Open `http://127.0.0.1:8787/register` to create a normal account. The demo
administrator is created on first start using `ADMIN_EMAIL` and
`ADMIN_PASSWORD` from `.env`. Opening `/admin` asks for the separate
`ADMIN_PAGE_PASSWORD`; a successful check creates the administrator session
directly. Use the user console at `/app` to create a device key. It is shown
only once.

For the current deployment, use the HTTPS domain as the public origin:

```text
https://www.vivantvalley.com.cn/register
https://www.vivantvalley.com.cn/app
https://www.vivantvalley.com.cn/admin
https://www.vivantvalley.com.cn/health
```

The Mod now defaults to the hosted-account flow: in the game, choose Vivant
Valley, register or log in with the player's account, and select a public model
alias such as `vv-dialogue` or `vv-fast`. The Mod receives an opaque
`vv_mod_...` session token; it never receives an upstream provider key and the
player does not create or copy a device Key. The token is stored only in the
Mod config and expires according to the server session policy; administrators
can revoke sessions server-side. The legacy web-console `vv_live_...` device Key API is
still accepted for compatibility with older Mod builds.

Hosted Mod endpoints are:

```text
POST /api/v1/mod/auth/register   { email, password }
POST /api/v1/mod/auth/login      { email, password }
POST /api/v1/mod/auth/logout     Bearer vv_mod_...
GET  /api/v1/mod/bootstrap       Bearer vv_mod_...
POST /api/v1/mod/redeem          Bearer vv_mod_...  { code }
```

Chat requests continue to use `https://www.vivantvalley.com.cn/v1` with the
session token as the Bearer value. Do not use the internal `127.0.0.1:8787`
address from another computer. The Node process remains on `127.0.0.1:8787`
behind Caddy; Caddy terminates HTTPS and proxies the public domain to it.

The user-facing flow is available at `/login`, `/register` and the authenticated
`/app` console. The console separates account overview and Mod connection
values, device Key lifecycle, request history with filters, and credit
redemption/ledger. It does not display provider credentials or internal
upstream details.

The apex domain `vivantvalley.com.cn` redirects over HTTP to the `www`
hostname. Its own HTTPS certificate is pending because the `.cn` DNSSEC chain
is intermittently returning a broken validation result; use the `www`
hostname until the apex certificate is issued. Both DNS A records must
continue pointing to `43.129.207.8`.

For this development VM, inbound `8787` is currently blocked by the cloud
firewall. A temporary Cloudflare Quick Tunnel is installed as
`vivantvalley-cloudflared.service` so the demo can be opened over HTTPS while
the firewall is being configured. Get the current URL with:

```sh
sudo journalctl -u vivantvalley-cloudflared.service --no-pager | grep -o 'https://[^ ]*trycloudflare.com' | tail -1
```

The Quick Tunnel URL is temporary and can change after a restart. It is for
demo validation only; production should use a named tunnel or Caddy with a
domain, HTTPS, and an explicitly opened cloud firewall rule.

The administrator console provides user search and suspend/restore actions,
fixed-amount Demo top-ups, one-time redeem-code creation, model price editing,
usage/cost/margin totals, the invitation-only registration switch, and managed
upstream providers. Each managed provider has an HTTPS Base URL, an encrypted
server-side API key, an enable/disable switch, a connection check, and can be
selected by a public model alias. Provider secrets are never returned by an
API response or written to an audit row. All mutating browser requests require
the session CSRF token.

The `/admin` page and every `/api/v1/admin/*` management endpoint require the
administrator gate cookie. It is issued only after `ADMIN_PAGE_PASSWORD` is
verified, is `HttpOnly`/`Secure` on the public deployment, and is cleared on
logout. Five failed attempts from one address block new attempts for 15
minutes. Change the password in `.env` and restart the service; previously
issued gate cookies stop working because their signature includes the current
password. Use a random value of at least 16 characters.

Provider management endpoints are admin-only:

```text
GET    /api/v1/admin/providers
POST   /api/v1/admin/providers
PATCH  /api/v1/admin/providers/{id}
POST   /api/v1/admin/providers/{id}/test  # small real tool-call compatibility probe
DELETE /api/v1/admin/providers/{id}
```

Hosted requests default to non-thinking mode. The gateway removes client-side
thinking options and negotiates a compatible disabled form with each upstream
before falling back to a standard OpenAI request that omits vendor fields.

The administrator can switch runtime traffic between Demo and real upstreams
from the `/admin` page. The setting is persisted in the database, so no SSH or
`.env` edit is needed for routine switching:

```text
GET   /api/v1/admin/settings/runtime
PATCH /api/v1/admin/settings/runtime  { "demo_mode": false }
```

Keep Demo mode enabled while configuring or testing providers. Disable it only
after at least one enabled provider is configured and bound to a model alias.

The existing `UPSTREAM_BASE_URL`/`UPSTREAM_API_KEY` environment variables stay
available as the read-only "environment default" provider. New model aliases
can be bound to a managed provider from `/admin`; clients continue to send
only the alias such as `vv-dialogue`.

Run the end-to-end check with:

```sh
npm run smoke
```

The same demo can run in Docker:

```sh
cp .env.example .env
docker compose -f docker-compose.demo.yml up -d --build
```

For a public deployment set `COOKIE_SECURE=true`, change `BACKEND_PEPPER`, set
a strong admin password, put Caddy/Nginx in front with HTTPS, and never expose
the Node port directly.

## Demo boundaries

The demo JSON store is intentionally single-process and is not a replacement
for PostgreSQL/Redis. The default model prices are sample `credit_micros`
values and the admin margin view uses a demo provider-cost ratio. Before any
real users or money are involved, migrate the ledger to PostgreSQL, move rate
limits/idempotency/concurrency to Redis, configure real provider prices from
the provider invoices, and add a real payment/reconciliation workflow. The
demo never logs or stores provider keys, but its local `.env` still contains
the admin secret and must not be committed or copied to a public machine.

## Documents

- `architecture.md`: 组件拓扑、认证、计费流程、限流、隐私和部署边界。
- `schema.md`: PostgreSQL 表、索引、账本和额度原子预留伪 SQL。
- `openapi.yaml`: OpenAPI 3.1 接口契约。
- `compatibility.md`: 从当前 C# 客户端源码得到的精确请求、工具和 SSE 约束。
- `mod-compatibility.md`: 给 Mod/后端联调使用的兼容性摘要。
- `review.md`: 第一轮待确认事项和验收标准。

## Planned Compose services

生产 Compose 应至少包含以下服务，只有 Caddy 暴露公网端口：

| Service | Role | Network exposure |
| --- | --- | --- |
| `caddy` | HTTPS/TLS、body/time limit、security headers | ports 80/443 |
| `api` | 用户/管理员 API、`/v1` 兼容层、计费协调 | private; Caddy only |
| `web` | 用户控制台静态资源或 SSR | private; Caddy only |
| `postgres` | 账户、Key 哈希、钱包、用量和审计 | private volume |
| `redis` | RPM 窗口、并发信号量、幂等短锁 | private; ephemeral |
| `litellm` | 内部模型路由/供应商适配 | private; no host port |

LiteLLM master key、供应商 API Key、数据库密码和 session pepper 通过
`.env`/Docker secrets 注入，绝不放入浏览器或 Mod 配置。

## API quick acceptance (curl)

Replace `BASE` with the HTTPS origin and use a temporary test inbox. These
commands intentionally use placeholders only. The implementation should
return an `x-request-id` on every API call and an OpenAI-shaped error object.

```sh
BASE=https://api.example.invalid

# 1. Register (include invitation_code when the admin gate is enabled)
curl -i -c cookies.txt "$BASE/api/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"correct horse battery staple"}'

# 2. Login and retain the Secure session cookie
curl -i -c cookies.txt -b cookies.txt "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"correct horse battery staple"}'

# 3. Create a device key. Save .key once; it is never returned again.
curl -s -b cookies.txt -H 'X-CSRF-Token: <csrf_token>' \
  -H 'Content-Type: application/json' \
  -d '{"label":"test laptop"}' "$BASE/api/v1/keys"

KEY='vv_live_<plaintext-from-step-3>'

# 4. List aliases and make a normal non-streaming completion
curl -s "$BASE/v1/models" -H "Authorization: Bearer $KEY"
curl -i "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: turn-0001' \
  -d '{"model":"vv-dialogue","messages":[{"role":"system","content":"You are an NPC."},{"role":"user","content":"Hello"}],"stream":false,"max_tokens":128}'

# 5. Tool call round: function.arguments must be preserved as JSON text.
curl -s "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: tool-0001' \
  -d '{"model":"vv-dialogue","messages":[{"role":"user","content":"Travel with me"}],"tools":[{"type":"function","function":{"name":"move_to","description":"Start an agreed journey","parameters":{"type":"object","properties":{"destination_key":{"type":"string"}},"required":["destination_key"],"additionalProperties":false}}}],"tool_choice":"auto","stream":false}'

# 6. Idempotency: replaying turn-0001 returns the same body/request ID and
#    does not create another reservation or ledger effect.
curl -s "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: turn-0001' \
  -d '{"model":"vv-dialogue","messages":[{"role":"user","content":"Hello"}],"stream":false,"max_tokens":128}'

# 7. Console usage and redeem code
curl -s -b cookies.txt "$BASE/api/v1/usage"
curl -s -b cookies.txt -H 'X-CSRF-Token: <csrf_token>' \
  -H 'Content-Type: application/json' -d '{"code":"<one-time-code>"}' \
  "$BASE/api/v1/redeem"

# 8. Revoke the key; subsequent /v1 calls must return 401/403.
curl -i -X DELETE -b cookies.txt -H 'X-CSRF-Token: <csrf_token>' \
  "$BASE/api/v1/keys/<key-uuid>"
```

The following negative tests are mandatory before launch:

| Case | Expected status/code | Billing effect |
| --- | --- | --- |
| malformed JSON, unknown alias, oversized body | `400` (`validation_error`) or `413` | no reservation |
| missing/expired/revoked key | `401` (`invalid_device_key`) | no reservation |
| suspended user/disabled key | `403` (`account_suspended`) | no reservation |
| available balance below reservation ceiling | `402` (`insufficient_balance`) | no ledger mutation |
| duplicate idempotency key with different body | `409` (`idempotency_conflict`) | original request unchanged |
| RPM/concurrency exceeded | `429` + `Retry-After` | no additional reservation |
| provider timeout/5xx | `408`/`502` | full reservation released (or `usage_pending` only when provider usage must reconcile) |
| `stream:true` during an implementation that has not enabled SSE | `400` (`stream_not_supported`) | no reservation |

## Implementation order after contract approval

1. Generate migrations and seed only non-secret model aliases/prices.
2. Implement auth/session and key lifecycle with integration tests.
3. Implement Redis limiters and PostgreSQL reservation/settlement transaction.
4. Implement `/v1/models` and non-streaming `/v1/chat/completions` through
   private LiteLLM; add SSE once usage finalization is tested.
5. Add console/admin pages, Caddy and Compose deployment, backups and a
   reconciliation command.
