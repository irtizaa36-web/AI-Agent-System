---
status: accepted
---

# Google Voice: a matched verification-code broker and approval-gated SMS replies

Toozy's agent (Alfred) now has two contact identities: an AgentMail address and a Google Voice number, both used instead of Toozy's real email and mobile. Voice texts and voicemail transcripts arrive in Toozy's Gmail from Google Voice under a "Voice" label, and the agent reads them there. This ADR records how the two identities are used, and adds two pieces that run on that channel: a broker that decides whether an incoming verification code may be used, and a drafter that writes approval-gated replies to routine Marketplace texts. Toozy approved the scope on 2026-09-26.

The real number, the linked mobile and the AgentMail address are **not in this repository** and must never be added. They belong in the owner's private notes or in git-ignored configuration. Everything in `src/voice/` and its tests uses fictional 555-01xx numbers.

## Standing policy for the two identities

- **Email first, the Voice number second, the real mobile for exceptions.** When a service offers verification by email, use AgentMail: it has an API and webhooks, and delivery is reliable. Short-code texts often never reach Google Voice.
- **The real mobile only:** banks, payment apps (PayPal, Venmo, Cash App, Zelle), trading and betting exchanges (Polymarket, Kalshi, Coinbase), and X, which blocks VoIP numbers outright. The broker enforces this list (`REAL_MOBILE_ONLY` in `src/voice/services.ts`). It refuses to open a verification for these services, so their codes always become alerts.
- **The Voice number:** Marketplace buyers and sellers, tint shops, survey panels, gig profiles, and the @WoozyBets public contact. Never the real mobile.
- **Recovery never runs through the Voice number.** The Google account that owns the number, the primary email, the password manager and the Apple ID recover through the real mobile, or a passkey or hardware key. Otherwise losing Gmail loses the Voice number, which loses the recovery path.
- **Gmail is now the key to every code.** The Google account that receives the forwarded texts should be protected by a passkey or hardware key, not SMS.
- **Codes don't sit around.** Gmail filters should split the Voice label into `Voice/Code`, `Voice/Voicemail` and `Voice/Text`. Codes should skip the inbox and be deleted after about a day.
- **Medical boundary.** Residency, credentialing, licensing and NPI contacts stay on the real contacts. If anyone texts patient information to the Voice number, the agent doesn't summarize or store it. It tells Toozy a message needs attention and nothing more (same spirit as ADR 0010).
- **Keep-alive.** Google reclaims idle Voice numbers after about 90 days. Keep the monthly manual text. A reply sent by email may count as activity, but that hasn't been verified, so don't rely on it.
- **Survey panels:** the agent triages invites (payout per minute, whether Toozy qualifies, expiry). It never answers surveys. Some panels reject VoIP numbers too.
- **Live calls** are Toozy's. The agent handles texts, codes and voicemail transcripts only.

## The verification-code broker (`src/voice/verification.ts`)

The agent may use an incoming code only when all three of these hold:

1. **The agent started it.** It ran `voice start-verification <service> --purpose "<which of Toozy's requests>"` right before asking the service to send a code. A code nobody asked for is exactly what an account-takeover attempt or the 6-digit-code relay scam looks like.
2. **It's fresh.** The verification is less than 10 minutes old (`VERIFICATION_WINDOW_MS`). At 10:00 it no longer matches.
3. **The message names that service.** At least one of the service's aliases must appear as a whole word, and no other service with an open verification may be named alongside it. A message that names no service, names a different one, or names two that are pending doesn't match.

Each verification is used for at most one code. A second code for the same service needs a new `start-verification`. Re-ingesting the same Gmail message does nothing.

Any other code is an alert with one of these reasons: `no-pending-verification`, `pending-expired`, `service-not-named`, `service-mismatch` or `ambiguous-service`. The code isn't used. Toozy sees the alert through `voice alerts`, which the agent relays to him.

A message counts as a code text only when it uses verification wording ("code", "verification", "passcode", "sign in" and similar) and contains a 4–8 digit code. Two different candidate codes are treated as ambiguous rather than guessed at.

**Code values never reach a file.** They are held in `SecretCode`, which prints as `[redacted]` through `toString`, JSON and `inspect`. The one `reveal()` call is the `voice ingest` line that hands the code to the flow that asked for it. Alert text is stored with every code-shaped token replaced by `[code]`. The state store re-redacts alert text on every save, as a backstop. A pending verification records which message satisfied it, never the code. Redaction deliberately over-matches: a 7-digit local phone number or a year in an alert also becomes `[code]`, which is the safe direction to be wrong in.

## The approval-gated SMS reply drafter (`src/voice/drafter.ts`)

For each inbound text that the broker didn't handle, in this order:

1. **Verification-shaped texts are never drafted against.**
2. **The scam classifier runs** (`src/voice/scam.ts`). It is rule-based and leans towards flagging. It checks for:
   - `verification-code-request`: "send me the code I texted", "verify you're real"
   - `overpayment-scheme`: cashier's checks, money orders, Zelle "business upgrade" or pending-payment stories, "I overpaid, send back the difference"
   - `paypal-email-phishing`: "what's your email for PayPal"
   - `qr-code`
   - `shipping-only-local`: shipping, a courier, or "I'm out of town" on a listing that is local pickup only

   Any flag means an alert and no draft.
3. **The text must be about a known listing.** Toozy records listings with `voice listing-add`. With one open listing, a text is assumed to be about it. With several, the thread has to be linked with `voice link`.
4. **Only routine questions get a draft:** availability, price and pickup (`src/voice/intent.ts`). Offers and haggling, questions about the item itself, holds, delivery requests, long messages and anything else go to Toozy with no draft, because a wrong answer there is a promise Toozy didn't make.
5. **The reply comes from fixed templates** (`composeReply`). No model call is made, and nothing from the buyer's message is echoed back. The pickup location is the listing's public meeting spot, never a home address. Sold or pending listings get a short no, never a yes.

**Every outbound SMS needs Toozy's approval of the exact text.** This is the exact-match shape of `inkbox approve-send` (ADR 0004). `voice approve <id> --revision <n> --body '<text>'` succeeds only when the revision and the body match character for character. The drafter prints that command ready to copy, shell-quoted so dollar signs and apostrophes survive. Editing a draft makes a new revision that needs its own approval.

`voice send` checks, at send time:
- the separate send switch,
- that the draft's current text still hashes to what was approved,
- that the listing's status hasn't changed since the draft was written.

A transport failure leaves the draft approved and is not retried.

**How a reply actually leaves.** Replying by email to a forwarded Voice text sends an SMS from the Voice number. This repository holds no Gmail credentials, so the real transport (`OutboxVoiceReplyTransport`) writes the approved reply to `.orchestrator/voice/outbox/<draft>.json` and marks the draft `released`. The agent's Gmail connector sends it as a reply in the named thread, to the named address. `voice mark-sent <id> --gmail-message-id <id>` then records it as `sent`.

**Known weaknesses:**
- The agent must transmit only what appears in the outbox. That rule lives in the agent's instructions, not in code, so it is weaker than a structural gate. The same trade-off is named in ADR 0018.
- The approval command can't prove Toozy typed it. The protection is that it requires the exact text Toozy was shown, so an agent can't approve by paraphrase.

A later version could move the approval tap into a phone-friendly surface, such as the dashboard or a reply to an alert text.

## Switches: configured is not enabled

Each of these is on only when its variable is exactly `"true"`. `TRUE`, `1`, `yes` and values with spaces all leave it off, and tests cover each case. Nothing changes on any checkout until someone sets them on a specific host.

| Variable | Turns on |
| --- | --- |
| `VOICE_CODE_BROKER_ENABLED` | `start-verification`, and matching or alerting on codes in `ingest` |
| `VOICE_REPLY_DRAFTER_ENABLED` | Scam classification and drafting in `ingest` |
| `VOICE_REPLY_SEND_ENABLED` | `voice send` releasing an approved draft |

Drafting and sending are separate on purpose: drafts can be reviewed for a while before anything is allowed to go out.

## Storage and data

All state is one JSON document at `.orchestrator/voice/state.json`: open verifications, alerts, listings, thread links, drafts, and handled message ids. The file is git-ignored, created with mode 0600, and written atomically. Like the settlements tracker (ADR 0022), a state file that exists but can't be parsed is an error, never a silent reset: resetting would reopen used verifications and drop alerts. The outbox sits next to it.

The agent passes Gmail messages to `voice ingest --file` as JSON: `{id, threadId, from, replyTo?, subject, body, receivedAt}`. The parser (`src/voice/voice-email.ts`) accepts only mail from `voice-noreply@google.com` or `*@txt.voice.google.com` with a subject of "New text message from …" or "New voicemail from …". Anything else is ignored, so a format change fails closed. Like the LinkedIn alert parser (ADR 0013), this reads emails Google writes for people, not a documented format. It hasn't yet been checked against a real forwarded Voice email.

## Not built

- Reading Gmail from this repository. The agent's Gmail connector does the reading and the final send.
- Any outbound text other than an approved reply.
- A model-written reply.
- Automatic delivery of alerts to Toozy's phone. The agent relays `voice alerts`; Inkbox SMS (ADR 0016) could do this later, after the 10DLC opt-in.
- Anything on Facebook itself. Marketplace automation is still ruled out (ADR 0011).
- The Gmail filters and Google-account hardening above. Toozy does those in Google's settings.
