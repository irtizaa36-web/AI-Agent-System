
# Capability Matrix

Every account, integration, and local service Big Boss (Polar) can or cannot reach, with how and when it was verified.
No credentials, tokens, or secrets are recorded here — verification method only.

Last reconciled: **2026-09-09** (Public.com rows, verified directly against the MCP connector). All other rows last reconciled 2026-09-07, Big Boss session (Polar).

## Verified — read access confirmed

| Capability | Method of verification | When |
|---|---|---|
| Gmail (`irtizaa36@gmail.com`) | Fetched inbox + targeted searches | 2026-09-07 |
| Google Calendar (3 calendars) | Listed events across all calendars | 2026-09-07 |
| Google Drive / Docs | Listed files, exported a Doc | 2026-09-07 |
| GitHub (`irtizaa36-web`) | Read repo tree, issues, PRs, file contents | 2026-09-07 |
| Slack — Polar Community workspace only | Listed channels | 2026-09-07 |
| Browser history | Searched directly | 2026-09-07 |
| Polar memory (`/home/polar`) | Read domain notes + workflow file | 2026-09-07 |
| **iMessage (read)** | Listed 5 most recent chats | 2026-09-07 |
| Coworker Dashboard (`localhost:4317`) | HTTP 200, live page content | 2026-09-07 16:30 CT |
| Inkbox mail webhook (`localhost:8787`) | HTTP 200 health check | 2026-09-07 16:30 CT |
| Public.com (browser) | Browser session logged in | 2026-09-07 |
| **Public.com MCP connector (read)** | `check_setup` authenticated; `get_portfolio` and `get_history` returned live data for the BROKERAGE account | 2026-09-09 |
| **Live trading on Public.com agents** | **Authorized.** Confirmed by the user 2026-09-09. The account had in fact been placing real trades since 2026-09-04 while this matrix still recorded it as unauthorized — corrected here so no session acts on the stale flag in either direction. See Project Registry §8. | 2026-09-09 |

## Requires authorization

| Capability | Status | What's needed |
|---|---|---|
| Outlook / Houston Methodist mail | Connector unusable | User will open an authenticated browser tab for direct read access instead of the connector. |
| Placing orders from the standalone monitoring system (§8a) | Not available by design | That system's client exposes only the read tools plus `preflight_order`; it has no method that could place an order. Drafting a trade is additionally gated behind a validated signal, of which there are currently none. A live order remains a separate, explicit human action. |
| Indeed connector (`mcp__Indeed__*`) | Referenced in coworker task `38fd59e8`, not callable in that session | Needs to be confirmed enabled for whichever session/account is meant to use it. |
| Twelve_Data / Zacks_Data connectors | Referenced in coworker task `1d60e4af`, never dispatched | Same — confirm connector availability before building on it. |

## Unavailable

| Capability | Why |
|---|---|
| Local files, phone (outside iMessage), desktop apps | No integration exists beyond iMessage (read-only, verified above). |
| `/home/project/` (job-search tracker, CVs, cover letters, MEMORY.md, HANDOFF.md) | Scoped to the `/daily-job-search` Polar workflow; not mounted in general sessions. |
| Claude.ai / ChatGPT direct integration | No connector; context transfer stays manual via GitHub. |
| Anthropic API key for the Moby AI engine | Deliberately unconfigured (per repo `.env.example`) — engine can't call a real model yet. |
| Enumerating other Polar conversations/running tasks/credit balance | No tool exposes this; visibility is limited to the current session. |

## Notes

- The coworker fleet's five personas (Coordinator/Sam, macmini/Max, Laptop2/Lucy, Jordan, Riley) and PinkyBaby are all **offline** as of last check — this is an activity status, not a capability gap; the underlying local services they'd use are up.
- No secrets, tokens, passwords, or PHI were found in any repository file read during this audit.
