# Vivant Valley Backend Architecture (phase 1)

This directory is an independent backend design package. It does not modify
the Stardew Valley Mod repository. Phase 1 specifies the production contract;
runtime code is intentionally deferred until the contract is reviewed.

## Goals and boundaries

The service is a hosted, metered gateway for Vivant Valley players. It owns
accounts, device credentials, quotas, model routing, billing records and
privacy controls. LiteLLM is an internal adapter only: it is never reachable
from a browser or a Mod and its master key is never returned to a client.

Phase 1 must provide:

- account registration/login and a web console;
- a role-protected administrator web console (not API-only) with user,
  balance, redeem-code, model-pricing, registration-gate and usage views;
- optional invitation-code registration gate;
- per-device `vv_live_...` keys (hash + display prefix only in the database);
- OpenAI-compatible `/v1/chat/completions` and `/v1/models`;
- administrator user controls, manual credit/top-up, redeem codes, upstream
  provider credentials and a persisted Demo/real-upstream runtime switch;
- atomic balance reservation, usage settlement and refund on failure;
- per-key/user RPM, concurrent request, body-size, token and timeout limits;
- request idempotency and auditable cost records;
- Docker Compose topology with PostgreSQL, Redis, LiteLLM and Caddy.

The first release does not implement server-side prompt compaction. The future
`/api/v1/game/turn` contract is reserved so the Mod can send structured game
state and a `conversation_id` instead of repeatedly uploading a large prompt.

## Logical topology

```text
Browser (HTTPS)
  |-- /auth, /console, /admin --------------------> Web/API service
Stardew Mod (HTTPS, Bearer vv_live_...)
  |-- /v1/chat/completions, /v1/models ------------> Web/API service
                                                        |
                                      +-----------------+------------------+
                                      |                                    |
                                  PostgreSQL                            Redis
                          accounts, keys, ledger,              rate windows, concurrency,
                          requests, audit, sessions             idempotency locks/cache
                                      |
                                  LiteLLM (private Docker network)
                                      |
                          DeepSeek/OpenAI/other providers
Caddy (public edge, TLS, request size/timeouts, security headers)
```

The web package exposes two role-aware surfaces behind the same HTTPS origin:
the user console and `/admin`. The admin route is rendered only for users with
the `admin` role; every mutation uses the session CSRF token and creates an
`admin_audit_log` row. Admin pages never display plaintext device keys or
provider credentials. The first admin console includes user search/status,
credit top-up, redeem-code creation, model alias and price management,
registration-invite toggle, and aggregate cost/margin views.

The API service is stateless and can be scaled horizontally. A worker process
may be added later for email, reconciliation and usage export; it is not a
required phase-1 component.

## Request lifecycle and charging

1. Caddy terminates TLS, applies a coarse body limit and forwards a request.
2. API validates JSON, bearer key, model alias, limits and an optional
   `Idempotency-Key`. The key is looked up by a constant-time hash comparison;
   only an HMAC/SHA-256 digest and a non-secret prefix are stored.
3. Redis performs a token-bucket RPM check and a distributed semaphore check.
   PostgreSQL performs the monetary reservation in one transaction. Amounts
   are integer minor units (for example, `credit_micros`), never floating point.
4. The API creates a `request` row with a unique `(user_id, idempotency_key)`
   when supplied, then sends a normalized request to internal LiteLLM using a
   server-side credential. The external `model` is an allow-listed alias such
   as `vv-dialogue` or `vv-fast`; the real provider model is selected by the
   routing table.
5. On a successful response, usage is read from the provider response when
   available. The reservation is settled to actual input/output/cached token
   cost and the difference is credited/debited in the same ledger transaction.
   If usage is unavailable, the request is marked `usage_pending` and a
   reconciliation job uses provider metrics; a conservative configured cost
   ceiling is charged until reconciled.
6. On timeout, provider error, validation failure after reservation, or client
   cancellation before completion, the reservation is released/refunded and
   the request is marked failed. Redis concurrency is always released in a
   `finally` path.
7. The response is returned with a stable `x-request-id`. Logs contain
   metadata and timing, not full message content by default.

Reservation must be idempotent. A retry carrying the same idempotency key
returns the original completed response or the original in-progress status;
it never reserves twice. A stale in-progress lease is recoverable by a
reconciliation job.

## Model routing and cost control

`model_aliases` maps a public alias to a provider/model pair and a price
version. The API rejects arbitrary upstream model names. A route can select a
cheap model for short/low-risk turns (`vv-fast`) and a higher quality model
for tool-heavy or long-context turns (`vv-dialogue`), subject to policy.

The following optimizations are deliberately server-owned and can be added
without changing the Mod endpoint:

- remove unused optional fields and cap recent messages;
- cache deterministic system/policy fragments and provider prompt-cache hits;
- route short turns to `vv-fast`;
- retry transient provider errors on a compatible route, without double
  charging the user;
- record provider cached-token counts separately from billable input tokens.

The meaningful token reduction requires `/api/v1/game/turn`, where the server
can select fields from a typed game context, maintain a summary, and avoid
re-sending the complete system prompt on every turn.

## Authentication and authorization

- Browser auth uses secure, HttpOnly, SameSite cookies containing a short-lived
  session token. Passwords use Argon2id (bcrypt is the fallback supported by
  the selected framework). CSRF tokens protect cookie-authenticated mutations.
- Mod API auth uses `Authorization: Bearer vv_live_...`. Device keys are
  displayed exactly once at creation. Revocation and expiry are checked on
  every request; suspended users and disabled keys receive `403`.
- Admin endpoints require a separate role (`admin`), MFA-ready session claims,
  and an audit row for every mutation. Admins cannot read plaintext device
  keys or upstream provider secrets.
- Registration can require a one-time invitation code. The gate is controlled
  by an environment/database setting and is visible to the console.

## Privacy, abuse controls and observability

- Do not persist complete prompts, responses or tool arguments by default.
  Store byte counts, token counts, hashes, model alias, status, latency and
  redacted error class. A short, explicit diagnostic sampling mode may be
  enabled by an administrator with a retention deadline.
- Validate maximum JSON depth/size, message count, content length, tool count,
  tool schema size and `max_tokens`. Reject unknown public model names.
- Enforce per-key and per-user RPM, daily spend and concurrent request limits;
  return `429` with `Retry-After` when exceeded.
- Password/key material and provider responses are redacted from logs.
- `ADMIN_PAGE_PASSWORD` is injected through the deployment environment; its
  password-only gate creates an administrator session, is rate limited, and
  protects both the `/admin` page and administrator APIs.
  Request IDs are random UUIDs and are safe to expose to users.
- Metrics: request count/status, latency, tokens, provider/model, reservation
  outcome, margin, 4xx/5xx and rate-limit counters. Traces carry IDs only.

## Deployment and recovery

The production Compose file should define `api`, `web` (or the API's static
console), `postgres`, `redis`, `litellm` and `caddy` on a private network;
only Caddy publishes ports 80/443. Secrets are injected through an ignored
`.env` or Docker secrets. PostgreSQL is backed up daily with an encrypted
off-host copy; Redis is treated as ephemeral. Schema migrations run as a
one-shot release job before the API is rolled out.

Rollback is an application image rollback plus a migration rollback only when
the migration is explicitly reversible. Ledger and request rows are append
only; never rewrite historical prices or balances. If a deployment fails,
disable traffic in Caddy, preserve PostgreSQL, inspect failed reservations,
then restart the previous API image and run reconciliation.

## Open decisions for review

1. Pick the API framework and frontend stack (the contract is framework
   neutral). The recommended implementation is a typed Node/TypeScript API
   with a separate web package, or an equivalent Go service.
2. Select the password/session library and email provider. Email verification
   is not required for the first local pilot but is required before payment.
3. Confirm supported currencies and the integer minor-unit scale (`micros` is
   suggested for sub-cent provider prices).
4. Confirm the initial provider routes and prices; keep them in the database,
   not in client configuration.
