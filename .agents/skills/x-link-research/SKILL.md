# X-Link Research Skill

Shared by Muse and Claude Code. Trigger: the user pastes an X/Twitter link with no other instruction — always run the full brief. No confirmation needed.

## Extraction

1. Open the link in the logged-in X session (the managed browser profile is signed in as @WoozyBets). Never attempt no-login workarounds first; the logged-in session is the primary route.
2. Pull the full thread: the original post chain top to bottom.
3. Expand scope: top replies (by engagement) and quote-tweets of the original post.
4. Cap at 50 posts total. If the thread is longer, take the original chain first, then highest-engagement replies/quotes until the cap.
5. Capture per post: author handle, timestamp, full text, image descriptions (describe what each image shows), video summaries (summarize spoken/visual content).

## Research brief (delivered in chat)

1. **Key points** — tight bullets of what the thread actually says. No commentary, no filler.
2. **Verification** — check the thread's key factual claims against web sources. Mark each claim: confirmed / disputed / unverified.
3. **Context** — what the thread leaves out; who the authors are if relevant (follower counts, affiliations when public).
4. **Sources** — every external claim gets a linked source. No bare assertions.

## Failure handling

- If the link is unreadable (deleted post, suspended account, login wall even when signed in): retry once after at least 30 minutes. If still unreadable, report it plainly and stop — one line, no essay.
- Never fabricate thread content. If only part of a thread loads, say which part is missing.

## Rules

- No emojis in any posted output.
- Short answers by default; the brief itself is the deliverable, keep it tight.
- Never use the Voice number or any verification flow for X — X blocks VoIP numbers outright.
- Nothing posts to X without the user's explicit tap.
