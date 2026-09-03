# Cross-Team Handoff

## Purpose

The Git repository is the durable source of truth for teams that work at different times. It carries the implementation, decisions, work state, and handoff information; no team depends on another team's private chat or local workspace.

**Team B** is the name for work performed through GitHub Pro/Copilot sessions. Team identity does not change the shared protocol: every team leaves the repository ready for the next one.

## Starting work

1. Read `PROJECT-BRAIN.md`, this document, and any documentation relevant to the task.
2. Update the local branch from its shared remote branch before making decisions based on its state.
3. Inspect `git status`, recent commits, and the relevant GitHub Issue or current work item before modifying files.

## Working

- Treat committed source and documentation as authoritative over chat summaries.
- Keep a task's code, tests, and directly related documentation in the same coherent commit.
- Record durable product or architectural decisions in `PROJECT-BRAIN.md`, `CONTEXT.md`, or a new ADR, whichever is the project's established home for that information.
- Use GitHub Issues for work that remains open beyond the current change; state the owner, current status, blockers, and next concrete action.

## Handing off

1. Complete or explicitly describe unfinished work in a committed handoff note: use the commit message for implementation status and a GitHub Issue or project document for work that remains.
2. Commit every intentional change, including its tests and durable context; leave the working tree clean.
3. Push the branch to `origin`. Open a pull request to `main` when the branch contains work another team should receive through the default branch.
4. In the final chat response, identify the branch, commit, unresolved work, and the one next action. The next team begins with the starting-work steps above.

## Handoff quality bar

Another team must be able to continue using only the repository and GitHub: no required fact, decision, changed-file rationale, or next step may exist solely in a private conversation.
