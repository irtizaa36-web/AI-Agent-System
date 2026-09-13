# profile/ — her actual data, never committed

Everything in this folder except this README is gitignored. That is deliberate:
this is the one place in the repository that holds real personal data, and it
stays on the machine that runs the pipeline.

## What goes here

### `resume.md` (required for scoring)

Her base resume as Markdown. The pipeline reads it once per run and sends it to
Anthropic's API as the cached prefix of the scoring prompt — nowhere else, and
no other third party.

The base resume is a PDF, and Node has no built-in PDF reader. Rather than add
a parsing dependency for a file that gets converted exactly once, convert it by
hand and save the result here:

- Easiest: open the PDF, select all, paste into `profile/resume.md`, fix the
  headings. Five minutes, once.
- Or, with poppler installed: `pdftotext -layout resume.pdf profile/resume.md`

Formatting does not need to be pretty. The scorer reads it as text; what matters
is that every real role, employer, date and metric is present and accurate.

Without this file the pipeline still runs — it fetches, dedupes and filters, and
says plainly in the digest that nothing was scored and why.

### `accomplishments.json` (Phase 2)

Her existing structured accomplishment bank. Not read yet; Phase 2's resume
tailoring and cover letters draw from it, and from nothing else, so that every
tailored bullet traces back to something she actually did.

### `notes.md` (optional)

Anything about what she wants that is not a mechanical filter — the kind of team
she does well on, what she is trying to move away from, a company she would drop
everything for. It is appended to the scoring prompt as her own words.

Its contents are pasted **verbatim** into the scoring prompt, so treat it the
way you'd treat the resume: facts only, and nothing half-written left sitting in
it. `notes.template.md` exists for exactly that reason — draft there, then
rename to `notes.md` when it's real.

Mechanical constraints (titles, salary floor, excluded industries) do **not**
belong here — those go in `config/job-search/preferences.json`, where they run
as free code filters before any model call.

## Getting LinkedIn content in

LinkedIn cannot be fetched automatically, and this project does not try. A plain
request to a public profile URL returns **HTTP 999** (their anti-automation
status), and ADR 0013 rules out working around that — not because the block is
hard to defeat, but because defeating it is what risks restricting the real
account of someone who is job-hunting while employed.

Two manual routes, both sanctioned by LinkedIn:

- **Fast:** open her profile while logged in, copy the About section plus any
  role detail the one-page resume had to cut, paste into `notes.md`.
- **Complete:** Settings → Data Privacy → *Get a copy of your data* → request
  the archive. It arrives as a zip of CSVs (`Profile.csv`, `Positions.csv`,
  `Skills.csv`, `Recommendations_Received.csv`, …). This is LinkedIn's own
  export feature, no automation involved, and it is the better source for the
  Phase 2 accomplishment bank.

## Getting LinkedIn (and Indeed) job listings into the automated digest

This is a different thing from the section above — that one is about mining
her profile once for source material; this is about the pipeline's own
scheduled runs seeing LinkedIn/Indeed postings at all, on the pipeline's own
schedule, without anyone touching it. See ADR 0013 and ADR 0015 for the full
reasoning; here's what actually needs doing, in order.

1. **Sign up for Inkbox** (inkbox.ai or wherever their current signup is) and
   get an API key and a mailbox address (something like
   `yourname@inkboxmail.com`). This is a real third-party signup — nothing in
   this repo can do it for you.
2. **Put the two values in `.env`** (gitignored, never committed):
   ```
   INKBOX_API_KEY=...
   INKBOX_MAILBOX_ADDRESS=yourname@inkboxmail.com
   ```
   Nothing else from `.env.example`'s Inkbox block is needed for this —
   the pipeline only polls for mail once per scheduled run (see
   `scripts/com.mobyai.jobsearch.plist` for the actual cadence), so the
   webhook receiver/signing key (for real-time inbound push) can stay blank.
3. **Confirm it's live**: `orchestrator jobs sources` will check the
   `inkbox:alert-mail` source alongside the ATS boards once the two env vars
   above are set, and report it healthy or broken by name.
4. **Turn on LinkedIn's own Job Alerts** on her account for the searches that
   matter to her (title + location, same as any saved LinkedIn search) — a
   completely normal, sanctioned LinkedIn feature, not automation.
5. **Forward those alert emails to the Inkbox address.** LinkedIn sends
   alerts to whatever email is on her account, and doesn't let you redirect
   them elsewhere directly — so this is a filter/forwarding rule set up in
   *her real inbox* (Gmail: Settings → Filters and Blocked Addresses → new
   filter, from `jobalerts-noreply@linkedin.com` → Forward to →
   `yourname@inkboxmail.com`). Repeat for Indeed's own job-alert sender if
   she wants that coverage too.
6. **Check the first real batch by hand.** The email-parsing logic
   (`src/jobsearch/sources/alert-mail.ts`) was built from the publicly known
   general shape of a LinkedIn alert, not a captured real sample — it is
   honest about that in its own code comments. Once real alerts start
   arriving, look at what `orchestrator jobs run` actually extracted from
   the first one or two and compare against the source email. If titles,
   companies, or locations come out wrong or blank, that's the parser
   needing a real fixture to tune against — not a sign the whole approach
   is broken.

## What must never go here

API keys, passwords, or browser session state. Credentials live in `.env`;
saved browser sessions live where `orchestrator browser login` puts them.
