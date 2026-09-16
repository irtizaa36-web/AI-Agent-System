# Shared job-search strategy

One playbook, two searches. Shivani (marketing/ops roles, ATS boards) and Irtiza (clinical-expertise gig platforms — Mercor, Turing, Handshake AI, AJE, BeMo and similar) run through the same pipeline and the same rules; only their data is separate (ADR 0017).

This file exists for the reason the Polar-side `MASTER_TRACKER.md`/`MEMORY.md` pattern exists, and that reason is worth stating plainly: **the expensive part of a job search is re-deciding the same judgment calls every session.** Writing them down once means a run doesn't have to re-reason "is a 'prefers 20+ hrs/week' line a hard gate or a soft preference," and a cheaper model can execute correctly against a rule that a more expensive one already thought through.

## The line that does not move

**Nothing in this system ever submits an application, sends a message, or accepts anything.** Not when a form is fully staged. Not when every field is already on file. Not when it would obviously be fine. The last click is always a human's.

This is not a limitation waiting to be lifted — it is the point. Mass auto-applying violates most sites' terms, and on the platforms in play here (Handshake AI's ID verification, Mercor's auth-redirect submits, anything touching an NPI or a real credential) an automated submission that gets a detail wrong is a misrepresentation under a real person's name and license. The system's job is to get the human to a reviewed, one-click-from-done state — never past it.

Concretely, in this codebase: `ApplicationRecord.status` has a `submitted_by_human` value that no code path sets, the browser tooling goes *list fields → preview-fill → stop* (ADR 0011), and every outbound capability is gated (ADR 0016).

## Application judgment calls, decided once

These are the recurring "is this a real gate?" questions. Decide once here; don't re-litigate per run.

| Situation | Rule |
| --- | --- |
| A stated preference ("prefers X", "ideally Y") | Soft. Apply, and name the gap honestly in the materials rather than hiding it. |
| A stated requirement ("must have", "required") the person genuinely lacks | Hard. Don't apply; log why so the pattern is visible later. |
| Hours/availability floor ("20+ hrs/week") | Soft preference unless the posting ties it to eligibility. Flag it for the human. |
| A score/assessment gate already failed | Hard. Don't re-apply through a side door. |
| ID verification, license upload, NPI entry, payout/banking setup | **Stop.** Stage everything else, hand it to the human. Never key a credential number or complete an identity step automatically. |
| CAPTCHA / reCAPTCHA | **Stop.** Staging the form right up to it is the correct end state, not a failure. |
| A field whose honest answer isn't on file | Stop and ask. Never invent a date, number, license, or employer to clear a required field. |

## Verify the submit actually happened — assume nothing

A hard-won lesson from the Polar side worth carrying over verbatim: **these sites fail quietly.** Dropdowns silently revert to their prior value. Upload failures surface nowhere near the submit button. A submit can route through an auth redirect that looks like an error but succeeded, or spin blank for 20 seconds and have done nothing.

So: never report an application as submitted on the basis of having clicked the button. Confirm against something the site itself changed — a confirmation screen, a status change in the account's own application list, a confirmation email. If confirmation can't be found, say "unconfirmed," not "submitted." An honest unknown is recoverable; a false "done" means a role silently never applied to.

## Follow-ups

- Draft, queue, and let the human send. Same rule as everything else.
- Time follow-ups off a real event (application date, interview date, a named person's last reply), not a generic cadence.
- One nudge, then let it rest — repeat follow-ups on silence cost more goodwill than they recover.
- Reference the specific conversation or role, never a template that could have gone to anyone.
- If a named contact has gone quiet past the follow-up date, surface it as an action for the human rather than auto-sending a second message.

## Pipeline stages

Both searches track the same stages, whatever a given platform calls them: `queued → materials_ready → prefilled → submitted_by_human → responded → rejected / withdrawn`. Multi-step funnels (e.g. Application → Skills Assessment → Interview → References) are modelled as progress through `responded`, with the specific next-step recorded rather than collapsing them into one opaque "in progress."

What matters in a digest is **what is owed next and by whom** — a role sitting at "waiting on them" is very different from one sitting at "waiting on you," and only the second needs anyone's attention today.

## Cost discipline

Cheap deterministic code does as much as possible before any model call (title/location/salary/experience/recency filters). A small model batch-scores what survives. A large model only touches the shortlist, and only for judgment or language generation. Reserve the expensive path for genuinely judgment-heavy work; a status read doesn't need it.
