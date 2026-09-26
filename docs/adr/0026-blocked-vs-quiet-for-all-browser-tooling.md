---
status: accepted
---

# Blocked-vs-quiet hardening for all browser-dependent tooling, and no retry on submit

## Context

ADR 0025 fixed the X search sweep, which used to report a throttled session
as "no news" because it couldn't tell a blocked page from an empty one. Every
other Tool on the browser ports had the same blind spot: `read-web-page` and
`read-job-board-page` returned whatever text came back, so a blank or crashed
page reached the agent looking like a page with nothing on it, and the form
tools filled and clicked without checking whether the page had loaded.

## Decision

1. **One shared module.** `src/integrations/browser/page-health.ts` holds
   the pattern extracted from the sweep:
   - `PageStatus = "ok" | "empty" | "blocked" | "error"`.
   - `classifyPage`: blank text, error shells, HTTP ≥ 400, and redirects to a
     login or challenge page are `blocked`. A page is `empty` only when it
     rendered real chrome and itself says it has zero results. When in doubt
     the answer is `blocked`, never quiet.
   - `checkSessionHealth`, `CircuitBreaker` (trips after 3 consecutive
     failed results, state kept per domain), and `pace`/`Pacer` (defaulting
     to the sweep's 4 s).
   The sweep now uses this module. Its length-only classification is kept
   exactly by turning the new error-shell markers off for it, so its tests
   pass unchanged.
2. **More signal from the read port, still read-only.** `BrowserClient`
   gains an optional `getPage(url)` that returns the text plus the final URL
   and HTTP status. It is the same navigation as `getPageText`. No click,
   type, or submit operation was added.
3. **Read tools report status.** `read-web-page` and `read-job-board-page`
   start every result with `status:`. A failed load gets one paced retry,
   then is reported as a load failure in words that cannot be read as "no
   content." `read-job-board-page` also health-checks each board's base URL
   before its first read, keeps a per-board breaker for the life of the Tool
   (one run), and takes `urls` for multi-board runs. A skipped or tripped
   board is reported, and the other boards carry on.
4. **`orchestrator browser health <site> <url>`.** Runs one read-only load
   and prints the status. It exits non-zero unless the page loaded. There is
   no retry: it is a probe, not a sweep.
5. **Forms: check before filling, never retry a submit.**
   `HealthCheckedFormFillingClient` wraps the real form client in
   `loadDefaultConfig`:
   - Before a preview or a submit, the form page is loaded read-only through
     the new optional `FormFillingClient.checkPage` and classified. A blocked
     page aborts before anything is filled or clicked.
   - **A submit is attempted exactly once.** A blank, error-shell,
     redirected, or otherwise ambiguous page after the click, or a crash
     during it, is reported as `outcome: "unknown"`
     (`submitted:unknown`, `needsHumanVerification:true` in the Tool output)
     so a human checks whether it went through.
   - Three consecutive blocked or unknown results on a domain trip that
     domain's breaker. Further submissions there are refused for the rest of
     the run.

## Why submits are never retried

A read retry is harmless: reading a page twice changes nothing. A submit
retry is not. The click may have gone through even when the page after it
came back blank; a throttled site often accepts the request and then fails
to render the confirmation. Retrying would risk a duplicate return, refund
request, or order. The only honest report for an ambiguous result is "we
don't know," with a human checking the site or the confirmation email. The
same reasoning applies to a thrown error during the submit: the click cannot
be ruled out, so it is `unknown`, not a failure the caller can safely retry.

## What this doesn't change

- The approval gates. `browser-submit-form` still sets `requiresApproval`
  exactly as before (ADR 0004, ADR 0018); the wrapper only adds refusals.
- Credentials and sessions. Login is still the human-driven `browser login`
  flow.
- Nothing here was validated against a live account. All paths are covered
  by `FakeBrowserClient` and `FakeFormFillingClient` tests. The next
  scheduled real run is the validation, per ADR 0025's reasoning.

## Pieces of the brief that didn't fit

- `browser health` makes a single request, so it has no circuit breaker to
  trip. The breakers live in the multi-request paths: the job-board Tool, the
  form wrapper, and the sweep.
- `listFormFields` is not health-checked. It fills and clicks nothing, and
  an empty field list is already visible to the human reviewing it.
