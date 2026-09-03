# AI Client Interoperability

## Purpose

This guide keeps GitHub, GitHub Copilot, and Claude Code productive on the
same Moby AI repository without treating a local account, browser session, or
connector registration as shared project state.

It complements the operational safety rules in
[`local-operations.md`](local-operations.md) and the durable handoff protocol
in [`team-handoff.md`](../agents/team-handoff.md).

## Current repository baseline

| Surface | Repository-backed configuration | Operating rule |
| --- | --- | --- |
| GitHub | Git history, pull requests, and Issue #1 | Use Issue #1 for durable cross-session coordination. |
| GitHub Copilot | [`.github/copilot-instructions.md`](../../.github/copilot-instructions.md) | Repository-wide safety, architecture, and validation guidance is automatically available where GitHub supports repository custom instructions. |
| Claude Code | [`CLAUDE.md`](../../CLAUDE.md) | Start from the project briefing and linked operating documents. |
| MCP/connectors | None committed | Connector registration, OAuth state, service health, and credentials remain user- or machine-local. |

The local client inventory may show registered connectors and their current
health, but it is not portable project configuration. Do not copy its entries,
endpoints, authorization state, or metadata into this repository. It does not
establish that another machine, client, or account has the same access.

## Shared workflow

1. Update the branch from `origin/main`, inspect `git status`, and read Issue
   #1 before making decisions.
2. Read `PROJECT-BRAIN.md`, `CONTEXT.md`, `CLAUDE.md`, and
   `docs/agents/team-handoff.md`; read `local-operations.md` before touching
   local operations.
3. Keep Core model- and I/O-agnostic. Put provider, external-service, and
   domain behavior behind the established adapter, Tool, and Pack seams.
4. Keep decisions, results, and handoffs in Git or Issue #1. Never make private
   chat history, a client-specific memory store, or a local connector state a
   prerequisite for the next team.
5. For TypeScript changes, use Node 22 or later and run `npm test`. Documentation
   changes need a focused review and `git diff --check`.

## Connector change policy

Adding a third-party MCP server, connector, plugin, OAuth grant, or external
service is not a repository-only change. Before proposing one:

1. Search the Agent Finder and use the official provider documentation to
   establish the actual capability and required permissions.
2. Record a short, source-linked recommendation in Git or Issue #1 that states
   the purpose, data boundary, permissions, reversible removal path, and exact
   operator action.
3. Wait for explicit human authorization before any installation,
   authentication, account linking, credential entry, or enablement.
4. Keep all secrets, local configuration, browser sessions, and personal data
   outside Git. Do not record connector health as a durable guarantee.

This policy does not prevent local use of an already-authorized connector; it
prevents silently turning machine-local access into an assumed project
dependency.

## Discovery record and roadmap

The Agent Finder query for free GitHub Copilot CLI/Claude Code interoperability
returned these potentially relevant skills. None was installed or enabled.
Scores are relevance only, not a trust or safety rating.

1. **CLI Mastery** — `application/ai-skill` —
   <https://github.com/github/awesome-copilot/blob/main/skills/cli-mastery/SKILL.md>
   (score: 70).
2. **Copilot CLI Quickstart** — `application/ai-skill` —
   <https://github.com/github/awesome-copilot/blob/main/skills/copilot-cli-quickstart/SKILL.md>
   (score: 70).
3. **Suggest Awesome GitHub Copilot Instructions** — `application/ai-skill` —
   <https://github.com/github/awesome-copilot/blob/main/skills/suggest-awesome-github-copilot-instructions/SKILL.md>
   (score: 70).

Maintain the concise shared instructions as the project evolves, and add
path-specific guidance only after a repeated, documented need. Evaluate a new
connector only through the policy above; do not create a generic integration
layer before an actual Moby AI use case requires it.

## Sources

- [GitHub: Adding repository custom instructions for GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)
- [GitHub: About customizing GitHub Copilot responses](https://docs.github.com/en/copilot/concepts/prompting/response-customization)
- [Anthropic: How Claude remembers your project](https://code.claude.com/docs/en/memory)
