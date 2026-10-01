---
status: accepted
---

# Anonymous LinkedIn guest endpoints: a narrow exception to ADR 0013

ADR 0013 (accepted, and standing intact except for this carve-out) decided that this project builds no automation against linkedin.com, in any form, and gets LinkedIn coverage from forwarded Job Alert emails instead. It also said that if a real need ever justified touching linkedin.com, that would need "its own explicit decision" and not a quiet extension of an existing pattern.

**This is that explicit decision.** On 2026-09-30 the owner (Dr. Toozy, GitHub `irtizaa36-web`) explicitly authorized a guest-only exception, after being told in plain terms that ADR 0013 did not already permit it and that LinkedIn's terms restrict automated access and it has pursued scrapers. Alert emails give Shivani only what LinkedIn chooses to send. They carry no applicant count, no full description and no reliable posting age, and those are the signals her "would she apply to this herself?" bar depends on. The risk that ADR 0013 identified is unchanged. The owner has accepted it for this one bounded case.

## What is authorized

One source, `src/jobsearch/sources/linkedin-guest.ts`, reading LinkedIn's public **jobs-guest** endpoints:

- `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` (search-result cards)
- `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<id>` (one job's detail page)

These are the pages LinkedIn serves to any logged-out visitor. It is attached to Shivani's profile only (ADR 0017).

## Guarantees (enforced in code and tests, not just stated here)

1. **Anonymous jobs-guest endpoints only.** No authenticated endpoint, no login, no account credentials, no cookies, no session, no token, and no environment variable of any kind anywhere in the code or config. The source has no configuration surface that could hold a credential. A response that redirects to a login or authwall page is treated as "blocked" and ends the source's run. It is never worked around.
2. **Zero exposure to her real LinkedIn account.** No automation ever touches it. The source cannot sign in, and it sends no `Cookie` header and no `Authorization` header. It never follows or fills in a sign-in or apply flow.
3. **Low frequency only.** The source runs once a day, inside the existing 8:30 AM weekday pipeline run (ADR 0014). It has no schedule, timer or loop of its own. Each run has hard caps on requests (search pages and detail pages), so its volume stays around a few dozen requests per day.
4. **Polite backoff.** Requests are sequential, with human-scale random gaps between them. There is no retry loop at all. HTTP 429/403/401/999, an authwall or login redirect, or a CAPTCHA page ends the source's run immediately. Whatever was gathered before that point is kept. The stop is reported on stderr, and as a degraded source in the digest when nothing was gathered. It is never retried into a rate limit. It identifies itself with the project's honest `User-Agent` (ADR 0002's politeness rules), not a spoofed browser.

## What does not change

- Every existing filter, the dedupe stage, the scoring pass and the digest are reused as-is. This source only produces `RawPosting`s. No new filter semantics exist.
- The apply URL is only ever a URL that appears on the page LinkedIn served. It is never constructed or guessed. No code path applies to anything: submitting an application is always Shivani's own step.
- ADR 0013's alert-email source (ADR 0015) stays in place. The two are additive and are deduplicated by the pipeline's existing cross-source identity key.
- If LinkedIn changes these endpoints, blocks the source, or the owner withdraws the authorization, the fix is to remove the source. The pipeline degrades gracefully without it, as it does for any failed source.

## Superseded 2026-09-30

**The carve-out in this ADR is REVOKED** per the user's explicit instruction of 2026-09-30: no automated LinkedIn access of any kind, effective immediately. The guest source (`src/jobsearch/sources/linkedin-guest.ts`) and its test were deleted and it is no longer registered in the pipeline. ADR 0013's original position — LinkedIn coverage only via forwarded Job Alert emails, no automation against linkedin.com — applies in full. This document is retained for history only.

## Reinstated 2026-09-30 (later)

*(The revocation above is kept as written. The revert that restored the source also removed that note from the tree, so it is reproduced here from the history of PR #67.)*

**The revocation above is itself withdrawn, and the carve-out is back in force**, per the owner's explicit instruction. The guest source, its test, its registry entry and its `jobs-commands.ts` handling were restored by reverting the removal (merge commit `de7f590`, PR #67). Nothing about the authorization changed from the original decision: the guarantees above apply exactly as written, and they are restated here so this note stands on its own.

**Safety case, restated.**

- **Anonymous jobs-guest endpoints only.** The two URLs under "What is authorized" are the only ones the source can call.
- **No login, no credentials, no cookies.** There is no configuration surface that can hold a credential: no environment variable, no token, no session, no `Cookie` or `Authorization` header, and `credentials: "omit"` on every request. The source cannot sign in and never follows or fills in a sign-in or apply flow. A login or authwall response ends the run and is never worked around.
- **Zero exposure to any LinkedIn account.** No automation ever touches the owner's or Shivani's LinkedIn account. No browser-based or login-based access to LinkedIn is added or permitted by this reinstatement.
- **Politeness caps unchanged.** At most 8 search and 30 detail requests per run, sequential, 2.5–5 s random gaps, no retries, honest `User-Agent`, once a day inside the existing pipeline run, and an immediate stop on HTTP 401/403/429/999, an authwall/login redirect, or a CAPTCHA page.

**New: persistent circuit breaker.** The stop-on-block rule used to last for one run; the next day's run tried again. That is no longer enough once LinkedIn has refused us.

- If a run hits a throttle or access block (HTTP 429 or 999, an authwall or redirect to login, a CAPTCHA page, or HTTP 401/403), the source writes a flag file, `.orchestrator/jobs/<profile>/linkedin-guest.disabled`, with the time and the cause. The file sits in the profile's data directory, which is not committed.
- While that file exists, the source makes **no requests at all**. Each run only logs a warning that names the cause, the time it tripped, and the file to delete.
- Re-enabling is deliberate and manual: delete the file. Nothing in the code removes it, no timer or retry expires it, and there is no flag or configuration toggle that bypasses it. An unreadable or malformed flag file is treated as tripped (fail closed).
- Ordinary failures (HTTP 500, timeouts) and per-job 404/410 responses do not trip it. They keep the earlier behavior: end the run, keep what was gathered, try again next run.
- No feature flag was enabled by this reinstatement.
