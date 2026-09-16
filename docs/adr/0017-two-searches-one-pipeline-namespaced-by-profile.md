---
status: accepted
---

# Two searches, one pipeline, namespaced by profile

There are now two job searches running here: Shivani's (marketing/program-management roles, discovered across ATS boards) and Irtiza's (paid clinical-expertise work on gig platforms — Mercor, Turing, Handshake AI, AJE, BeMo, scholr). They want the same engine and the same rules and none of the same data.

**One pipeline, not two forks.** Everything the searches genuinely share — normalization, dedupe, filtering, ranking, tiered scoring, cost logging, the digest, the never-submit boundary — is one code path exercised by both. A second copy of `src/jobsearch/` would be two places to fix the next Figma-style false positive and two places for the submission boundary to drift apart. The shared judgment calls live in prose at `docs/job-search/strategy.md` for the same reason: re-deciding "is a stated preference a hard gate?" every session is the expensive part, and a written rule lets a cheaper model execute what a more expensive one already reasoned through.

**Data is namespaced by profile key, and there is no default profile.** A profile is a lowercase slug (`^[a-z0-9][a-z0-9-]*$`) that names three sibling directories: `config/job-search/<profile>/`, `profile/<profile>/`, and `.orchestrator/jobs/<profile>/`. `src/jobsearch/config.ts` is the only place those paths are constructed, and every accessor takes the profile as its first argument, so there is no way to read preferences without having said whose.

The deliberate omission is a default. `jobs run` with no `--profile` refuses and lists the configured profiles rather than picking one. A default profile is exactly the bug worth designing out: the failure mode isn't a crash, it's a run that quietly scores one person's postings against the other's resume, or writes Irtiza's application state into Shivani's pipeline, and produces a plausible-looking digest either way. Refusing is cheap; silently mixing two people's job searches is not.

`assertValidProfile` rejects anything with a slash, a dot segment, whitespace, or uppercase before it reaches `join()`, so a profile key can never escape its namespace into another's directory — or anywhere else on disk. `config.test.ts` covers both properties directly: isolation between two profiles' preferences and resumes, and rejection of `../etc`, `a/b`, `./x` and friends.

**The scheduled run iterates profiles explicitly.** `npm run pipeline -- --all` (what launchd invokes, per ADR 0014's schedule) runs every configured profile in turn, each against its own config, its own delta state, and its own digest. Adding a third person is a directory and a preferences file, not a code change.

**Separate stewards, both reporting to Irtiza.** `.claude/agents/job-search-steward-shivani.md` and `.claude/agents/job-search-steward-irtiza.md` are two agents, each locked to one profile and forbidden from reading the other's data. This mirrors the data boundary at the agent layer: the reason not to have one steward handling both isn't workload, it's that a single context holding both people's resumes, salary expectations, and application state is precisely the thing the namespacing exists to prevent.

**What the two searches do *not* share is source adapters.** Greenhouse/Lever/Ashby (ADR 0012) and the forwarded-alert mail source (ADR 0015) are real ATS-shaped sources and apply to Shivani's search. Mercor, Turing, Handshake AI and the rest are not ATS boards and have no public posting API; forcing them into `watchlist.json`'s shape would produce a config that looks configured and fetches nothing. Irtiza's `watchlist.json` is therefore deliberately empty, with the reason recorded in the file itself. Any adapter for those platforms gets built and verified against live output before it is trusted, same as every existing source.

**The submission boundary is unchanged and is not per-profile.** Nothing in either search submits, sends, or accepts (ADR 0011, ADR 0012, ADR 0016). Irtiza's prior Polar-browser system did auto-submit on a schedule; when its tracked state is imported here, the state comes and the submit behavior does not. On this side the stakes are higher, not lower — these applications carry a real name, NPI, and medical license — so the line holds in exactly the same place: stage the form completely, stop before the last click.
