---
name: x-link-research
description: Research brief for a pasted X/Twitter link. Pulls the full thread, top replies and quote-tweets, verifies the key claims against web sources, and cites every source. Use when the user pastes an X or Twitter link with no other instruction.
---

# X-Link Research Skill

Shared by Muse and Claude Code. Trigger: the user pastes an X/Twitter link with no other instruction — always run the full brief. No confirmation needed.

## Extraction

1. Open the link in the logged-in X session (the managed browser profile is signed in as @WoozyBets). Never attempt no-login workarounds first; the logged-in session is the primary route.
2. Pull the full thread: the original post chain top to bottom.
3. Expand scope: top replies (by engagement) and quote-tweets of the original post.
4. Cap at 50 posts total. If the thread is longer, take the original chain first, then highest-engagement replies/quotes until the cap.
5. Capture per post: author handle, timestamp, full text, image descriptions (describe what each image shows), video summaries (summarize spoken/visual content).

## Research brief (delivered in chat)

The single most important section is the first one — always lead with it.

1. **What this means for you** — the actionable core. What is useful to Toozy specifically (he runs an AI agent system: Marketplace agent, voice broker, scheduled build loops, survey/finance automations) and what can be implemented from this link: concrete next steps, tools to adopt, code to write, services to try. Be specific — name the repo, the workflow, the cost. If the link is not worth his time, say so bluntly in the first line (e.g. "Not worth your time — ...") with one line of why, so he doesn't waste more time on it. Never pad a useless link with filler to make it seem worthwhile.
2. **Key points** — tight bullets of what the thread actually says. No commentary, no filler.
3. **Verification** — check the thread's key factual claims against web sources. Mark each claim: confirmed / disputed / unverified.
4. **Context** — what the thread leaves out; who the authors are if relevant (follower counts, affiliations when public).
5. **Sources** — every external claim gets a linked source. No bare assertions.

## No-API research playbook (default — no X API key)

Do all of this through the logged-in browser session (@WoozyBets). No paid API, no unofficial scraping libraries (ban risk).

1. **Thread extraction** — open the link signed in; pull the full chain, top replies by engagement, quote-tweets (via X search `url:<id>` on Top + Latest tabs). Cap 50 posts.
2. **Author dossier** — open each key author's profile: bio, follower/following counts, join date, pinned post, recent posts. Note affiliations and credibility signals.
3. **Outbound links** — follow every substantive link in the thread (articles, docs, repos, products). Summarize what each one actually says; verify claims against them.
4. **Related threads** — use X advanced search operators (`from:`, `to:`, `since:`, `until:`, `min_faves:`, `min_retweets:`, exact phrases in quotes) to find other threads on the same topic. Compare claims across them.
5. **Topic search** — when the user asks about a topic rather than pasting a link, run the same pipeline starting from advanced search: top posts, key authors, consensus vs controversy.
6. **Rate limits** — X throttles aggressive browsing. Space out heavy reads; if a rate limit hits, wait and resume rather than hammering. Never rapid-fire refresh.

## Failure handling

- If the link is unreadable (deleted post, suspended account, login wall even when signed in): retry once after at least 30 minutes. If still unreadable, report it plainly and stop — one line, no essay.
- Never fabricate thread content. If only part of a thread loads, say which part is missing.

## Rules

- No emojis in any posted output.
- Short answers by default; the brief itself is the deliverable, keep it tight.
- Never use the Voice number or any verification flow for X — X blocks VoIP numbers outright.
- Nothing posts to X without the user's explicit tap.
