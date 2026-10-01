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
