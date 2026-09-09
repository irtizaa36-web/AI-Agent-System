# Portable Handoff Template

Use this template when moving work between Polar, Claude Code, Claude projects, Copilot, or another session. Save completed handoffs under `docs/handoffs/` or attach them to the relevant GitHub Issue.

```markdown
# Handoff: <short task name>

## Objective
What the next Agent must accomplish.

## Repository state
- Repository: <owner/repo>
- Branch: <branch>
- Base commit: <commit SHA>
- Working tree status: <clean or summary>
- Relevant files: <paths>
- Relevant issue or PR: <URL or none>

## Completed work
- <completed item>
- <completed item>

## Current state
Describe what is true now, including tested behavior and durable decisions.

## Evidence and sources
- <file path, URL, test output, or other evidence>

## Remaining work
1. <next action>
2. <next action>

## Constraints and safety
- Do not expose secrets or private data.
- Do not repeat side effects that already occurred.
- Do not publish, send, submit, pay, delete, or authenticate without explicit approval.
- Do not invent missing facts; record them under Open questions.

## Open questions
- <question or none>

## Suggested next prompt
<copy-ready prompt for the next Agent>
```

## Handoff rules

- Reference artifacts, files, commits, and issues instead of duplicating their full contents.
- Record exact commands and validation results when code changed.
- Redact credentials, access tokens, personal contact information, private browser state, and mailbox contents unless the operator explicitly needs a safe excerpt.
- A handoff is not complete until another Agent can identify the next action without private conversation history.
