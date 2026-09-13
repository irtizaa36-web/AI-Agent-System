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

## What must never go here

API keys, passwords, or browser session state. Credentials live in `.env`;
saved browser sessions live where `orchestrator browser login` puts them.
