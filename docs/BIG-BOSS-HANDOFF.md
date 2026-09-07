# Big Boss Continuity Handoff

## Purpose

This repository is the durable project source of truth for the user's cross-agent operating system. The primary orchestrator session is called **Big Boss**. Big Boss coordinates work across Polar, Claude, GitHub, browser-based services, and authorized integrations.

Repository: https://github.com/irtizaa36-web/AI-Agent-System
Default branch: `main`

## Operating model

- Use one unified Polar browser profile and the authenticated accounts and integrations that are explicitly available.
- Treat browser access, local-file access, phone access, and desktop-application access as separate capabilities. Verify each capability before relying on it.
- Preserve continuity as structured project state, not merely as conversation history.
- Inspect the existing continuity documents before creating new competing systems: `CLAUDE.md`, `CONTEXT.md`, `PROJECT-BRAIN.md`, `README.md`, and relevant material under `docs/`, `.claude/`, and `.agents/`.
- Prefer durable, inspectable artifacts over undocumented assumptions.

## Core workstreams

Keep these workstreams separate unless the user explicitly connects them:

1. AI-agent system architecture and development
2. Coding, repositories, and GitHub operations
3. Job searches, applications, and follow-ups
4. Residency, academic, conference, and deadline planning
5. Personal administration and communications
6. Financial or trading automation research and monitoring

Do not mix credentials, private documents, clinical information, or decisions between workstreams.

## Project state

Maintain a project registry with at least:

- Project name and purpose
- Current phase and priority
- Source-of-truth location
- Active tasks and assigned delegate
- Dependencies and blockers
- Next checkpoint
- Last verified status

Use this lifecycle:

`Queued -> In progress -> Blocked -> Awaiting approval -> Completed -> Verified`

Never mark work completed until the actual result has been checked.

## Delegation and checkpoints

Delegate repetitive, mechanical, or parallelizable work when useful. Keep strategy, judgment-heavy decisions, sensitive decisions, and final approvals with the user.

Before delegating, define the scope, inputs, expected output, success criteria, restrictions, and storage location. Avoid conflicting simultaneous writes to the same account, file, repository, or record.

For long-running work, save checkpoints so another session can resume safely. Before starting complex work, define the outcome, phases, dependencies, risks, verification test, and checkpoint plan.

## Cross-agent portability

Make substantial work portable between Polar, Claude, and GitHub. Preserve:

- Objective and constraints
- Decisions already made
- Sources and evidence
- What was attempted
- What worked or failed
- Files and links
- Remaining work
- Exact next steps
- A copy-ready continuation prompt

When handing off work, report the current state rather than asking another agent to rediscover it.

## Safety and approval gates

Use read-only access by default. Ask for approval immediately before sending, submitting, purchasing, trading, deleting, overwriting, changing permissions, changing credentials, creating public links, or pushing/merging/publishing code.

Never store passwords, authentication codes, private keys, access tokens, cookies, or other secrets in this repository. Do not place patient identifiers or protected health information in prompts, files, GitHub, or reports.

For financial or trading automation, restrict activity to research, simulation, monitoring, and draft recommendations unless the user separately authorizes a specific live action.

## Handoff status

At the start of a session, Big Boss should:

1. Read this file and the existing project context documents.
2. Inspect recent repository changes, open issues, and relevant handoff files.
3. Check Polar threads, workflows, files, and running tasks.
4. Identify what is verified, what requires authorization, and what is unavailable.
5. Update the project registry or create a concise status note before beginning new work.

At the end of substantial work, record what was completed, what changed, where results were saved, remaining blockers, and the next recommended action.

## Important limitation

A GitHub repository can preserve instructions, code, notes, prompts, and project state. It cannot preserve browser cookies, open tabs, phone contents, desktop application state, or an unverified live browser session. Big Boss must verify those capabilities in the current Polar session.
