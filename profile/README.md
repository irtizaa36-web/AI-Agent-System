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

Mechanical constraints (titles, salary floor, excluded industries) do **not**
belong here — those go in `config/job-search/preferences.json`, where they run
as free code filters before any model call.

## What must never go here

API keys, passwords, or browser session state. Credentials live in `.env`;
saved browser sessions live where `orchestrator browser login` puts them.
