# Settlements agent: setup and use

This guide covers the class-action settlement tracker (ADR 0022). It needs no credentials. **It never files, attests or submits a claim.** You file every claim yourself, on the official settlement site, and then tell the tracker what you did.

## First run

The first command creates `.orchestrator/settlements/tracker.json` (gitignored, stays on your machine), seeded with your pipeline as of 2026-09-25. Then record your CVS confirmation number once. It's kept out of the public repository on purpose:

```bash
npm run cli -- settlements confirmation cvs-digital-privacy <your confirmation number>
```

## Every day or so

```bash
npm run cli -- settlements alerts       # nudges at 14/7/3/1 days left; each one fires once
npm run cli -- settlements deadlines    # every open claim, soonest first
npm run cli -- settlements review       # verdicts, evidence you'd need, your to-dos
npm run cli -- settlements review usa-clinics-tcpa   # one claim in full, with its history
```

`alerts --dry-run` shows the nudges without marking them sent. If you skip a few days, you get one nudge for the tightest mark crossed, not a backlog.

## Finding new settlements

```bash
npm run cli -- settlements research     # sweeps Top Class Actions and ClassAction.org
npm run cli -- settlements inbox        # candidates waiting on you
npm run cli -- settlements add <candidate-id>                        # start tracking it
npm run cli -- settlements dismiss <candidate-id> --reason "why"     # never show it again
```

Research skips everything you track and everything on the do-not-research list (every dropped settlement is on it automatically: `settlements do-not-research`). A candidate is reported once. Its eligibility is checked only against your profile, so anything marked `?` needs your own records.

To track one you found yourself, the deadline needs a source:

```bash
npm run cli -- settlements add --name "Acme data breach" --deadline 2026-12-15 --source https://acmesettlement.com --payout "Up to $100"
```

## Recording what you did

Every change needs evidence, in your words:

```bash
npm run cli -- settlements verdict vsl3-probiotic eligible --evidence "Found 2018 orders for 4 bottles"
npm run cli -- settlements status vsl3-probiotic ready_to_file --evidence "Receipts gathered"
npm run cli -- settlements status vsl3-probiotic filed --evidence "Filed on vsl3lawsuit.com" --filed-on 2026-10-01 --confirmation ABC123
npm run cli -- settlements status vsl3-probiotic paid --evidence "Check arrived" --amount 80 --paid-on 2027-03-01
npm run cli -- settlements status inotiv dropped --evidence "No Inotiv notice anywhere"     # permanent
npm run cli -- settlements action vsl3-probiotic done a1 --note "4 units"
npm run cli -- settlements action finwise add --kind verification_code "Enter the emailed code"
```

Action kinds: `attestation`, `verification_code`, `product_count`, `notice_search`, `documentation`, `other`.

Check a class definition against your profile any time:

```bash
npm run cli -- settlements evaluate --title "Acme TCPA" --text "received prerecorded calls from Acme between 2021 and 2025"
```

## Through the agent

`npm run cli -- run --agent settlements-agent --task "What's due and what do I need to do?"` (needs `ANTHROPIC_API_KEY`). The agent can read, evaluate and research. It can't change anything in your tracker; it tells you the command to run.

Set `SETTLEMENTS_TIMEZONE` if you aren't on US Central time.
