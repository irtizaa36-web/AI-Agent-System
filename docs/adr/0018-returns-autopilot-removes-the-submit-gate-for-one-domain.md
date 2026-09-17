---
status: accepted
---

# Returns autopilot: removing the submit gate, for one domain, behind a switch

ADR 0011 built real form-writing capability and kept exactly one thing between a model's decision and a live click on someone else's website: `browser-submit-form`'s `requiresApproval: true`, enforced centrally by the Orchestrator (`src/core/orchestrator.ts`). That ADR said plainly that the gate "is what actually prevents it from running unattended."

This ADR removes that gate for retailer returns, on the owner's explicit instruction (2026-09-17), asked and answered as a direct choice between staging-and-stopping, sending merchant emails autonomously, and full autonomy including web portals. He chose the third with the tradeoff stated.

**Why this is a defensible place to draw a different line than the job search does.** The job-search stewards stage and stop unconditionally, and that rule is not weakening. The reason it exists there does not transfer here: a job application carries a real name, a real NPI, and a real medical license, and a wrong value submitted under a professional credential is a misrepresentation, not a typo. A return request carries an order number and a reason code, against the owner's own purchase, on his own account, recovering his own money. Those are genuinely different risk objects. Treating them identically would be a failure of judgment in the other direction — the never-submit rule is load-bearing where credentials and third parties' trust are at stake, not a universal law about clicking buttons.

**Configured is still not enabled.** The gate flips only when `RETURNS_AUTOPILOT_ENABLED` is exactly the string `"true"`. Absent, empty, `"1"`, `"yes"`, or `"TRUE"` all leave it closed, and there are tests for each. This is the same shape as `DIGEST_SMS_ENABLED` (ADR 0016) and for the same reason: merging a capability must never be the thing that switches it on, and the machine that holds the credentials should be the machine that makes the decision. Nothing about this ADR changes behavior on any checkout of this repo until someone sets that variable on a specific host.

**What the switch does not do.** It removes a mechanical gate. It does not make the underlying judgment safe, and it cannot, because `browser-submit-form` is generic — it fills selectors and clicks a control, and has no idea whether the page is a return form or a checkout. The stops that actually matter are therefore not in the Tool and cannot be:

- **CAPTCHA** — stop. ADR 0011 already notes Playwright can't solve these; attempting to is both futile and a bad-faith signal to the site.
- **Identity verification** — stop. Uploading an ID is categorically different from selecting a reason code.
- **Anything that moves money in a direction other than back to the owner** — stop. Changing a refund destination, entering card or bank details, accepting store credit in place of a refund, or paying a restocking fee are all decisions with money at stake and a human on the hook. The coworker protocol's standing "never handle money" rule is not overridden by this ADR.
- **A site whose terms clearly prohibit automated interaction with its support flows** — stop and say so. ADR 0011 flagged this generally and singled out Facebook Marketplace as an account-suspension risk rather than a technical one; that judgment stands and is not narrowed by turning this switch on.

These live in `.claude/agents/customer-service-steward.md`. That placement is a real weakness and worth naming: they are prompt-level instructions, not structural guarantees, which is strictly weaker than what ADR 0011's gate provided. A model that misreads a checkout page for a return page will not be stopped by a comment in a markdown file. The mitigation is scope — the switch is off by default, the agent is told to work from an order it has already identified in the owner's own mail rather than navigating freely, and the first real run against any retailer should be watched rather than trusted, exactly as ADR 0011 said of form-filling generally.

**Prerequisite that is not satisfied today.** None of this runs anywhere right now: `.orchestrator/browser-sessions/` does not exist on this checkout, and an authenticated session per retailer is required before a single form can be reached. Creating one needs a real visible browser and a human login, which means the Mac Mini, not a cloud session. That work is queued separately. Until it exists, turning the variable on changes nothing observable.

**Alternatives rejected.** Per-retailer allowlisting in the Tool was considered and dropped as false comfort: it would encode a list of domains in code that says nothing about whether the specific page being submitted is a return or a purchase, which is the actual risk. A second confirmation channel (text the owner, wait for "yes") was considered and is a genuinely reasonable middle path, but it is the option he was offered as "let it send emails autonomously" and declined in favor of full autonomy; it remains the obvious fallback if the first real runs go badly.
