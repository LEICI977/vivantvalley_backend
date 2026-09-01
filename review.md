# Phase-1 contract review

## Confirmed decisions

- LiteLLM remains private behind the API; clients only see `vv-*` aliases.
- Device credentials use one-time plaintext `vv_live_...` delivery and
  HMAC/SHA-256 hashes plus a safe display prefix in PostgreSQL.
- Wallet and usage costs use integer `credit_micros`; reservation, settlement
  and release are idempotent PostgreSQL transactions.
- Browser sessions are Secure HttpOnly cookies with CSRF protection; Mod calls
  use bearer device keys. Admin mutations are audited.
- Non-streaming chat is the first acceptance target. The contract also defines
  SSE behavior because the current dialogue UI uses `stream:true`.
- Tool fields (`tool_calls`, `tool_call_id`, `function.name` and string
  `function.arguments`) are preserved exactly. The future typed game-turn
  endpoint has a versioned context and `conversation_id`.
- The first release includes a role-protected `/admin` web console, not only
  administrator JSON endpoints.

## Open questions before implementation

1. Which API/web framework and repository layout should be used?
2. What is the initial currency/minor-unit display policy and provider price
   table? Confirm input/output/cache prices and route names.
3. Should invitation codes be mandatory at launch, and how will users receive
   password reset/verification email?
4. Which concrete LiteLLM version/providers are approved, and what are the
   retry/fallback rules for each alias?
5. Is SSE enabled in the first production image, or should the Mod hosted
   profile temporarily force `stream:false`?
6. What retention period and opt-in process is acceptable for diagnostic
   prompt samples (default remains no raw prompt storage)?

## Acceptance evidence to collect during implementation

- OpenAPI lint passes and generated client can send all examples.
- Migration tests cover duplicate email/key/idempotency, concurrent balance
  reservations, settlement and provider-failure release.
- curl checklist in `README.md` passes for registration/login, key lifecycle,
  models, normal/tool chat, insufficient balance, rate limit, usage, redeem and
  revoke.
- A test verifies the Mod's exact `tool_call_id` round trip and that
  `function.arguments` remains a JSON string in the assistant message.
- Logs and database fixtures contain no plaintext device keys, provider keys or
  full chat content.
