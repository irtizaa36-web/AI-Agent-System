---
status: accepted
---

# Real Inkbox client, webhook receiver, and one scoped dependency exception

The Inkbox mailbox integration moved from fake-only (FakeInkboxClient) to a real one: `real-client.ts` implements the `InkboxClient` port against Inkbox's actual Mail API, called with plain `fetch` — no `@inkbox/sdk` dependency for this part, keeping ADR 0002's zero-runtime-deps rule intact for everything except tunnel connectivity (below). Inkbox's Mail API has no server-side draft concept of its own (sending composes and delivers in one call); `draft-store.ts` keeps that concept on this project's side of the port, the same way FakeInkboxClient always did, just persisted to disk now so the draft/review/approve/send CLI flow survives across process restarts.

A webhook receiver (`webhook.ts`, `webhook-handler.ts`, `webhook-server.ts`) listens at a fixed path, `/inkbox/mail`, and verifies every request through four independent layers before acting on it: an optional bearer token (`INKBOX_WEBHOOK_AUTH_TOKEN`), Inkbox's own HMAC-SHA256 request signature, a timestamp-freshness window, and a request-id replay guard — reimplementing Inkbox's published signing scheme directly (see `github.com/VectorlyApp/inkbox`, `typescript/src/signing_keys.ts`) rather than depending on their SDK for it, since the algorithm is simple, published, and this keeps the receiver's trust boundary self-contained. `message-event-log.ts` and the new `JsonFileForwardingLog` persist message-lifecycle and forwarding outcomes to disk, one file per record, so a restart of the long-running receiver process never re-forwards or loses audit history.

The one exception to zero runtime dependencies: `tunnel.ts` uses `@inkbox/sdk` to open the actual tunnel connection that makes a public `*.inkboxwire.com` URL reach this local receiver. There is no documented raw-protocol alternative to that specific operation — Inkbox's own docs describe it as programmatic-only. Scoping the dependency to exactly this one file, rather than adopting the SDK project-wide, keeps the exception narrow and the rest of the Inkbox integration (the Mail API client, the webhook verification) exactly as dependency-free as ADR 0002 originally intended.

None of this has been exercised against a real Inkbox mailbox or a real signing key as of this writing — every test uses fakes (FakeInkboxClient, an in-memory signing key, a real but ephemeral `localhost` HTTP server) — real credentials are read only from environment variables at runtime and were never configured during development.
