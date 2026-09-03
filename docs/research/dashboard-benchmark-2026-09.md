# Moby AI Coworker Dashboard Benchmark

**Research date:** 2026-09-03  
**Scope:** Improvements must remain local-only and file-backed. They must not add external feeds, live-session discovery, personal-data display, autonomous actions, or consequential actions.

## Current baseline

The dashboard is a localhost-only, polled single page with a task Kanban board, agent self-reports, transient status and assignee filters, task creation, progress notes, a task history, and a recommendation feed. It already uses native accessible controls and text-plus-icon status labels.

## Improvement opportunities

| Rank | Opportunity | Public dashboard capability | Safe local direction |
| --- | --- | --- | --- |
| 1 | Explainable review queue | Devin surfaces blocked and needs-attention work; Linear exposes health and missed-update staleness. [Devin](https://docs.devin.ai/desktop/agent-command-center), [Linear](https://linear.app/docs/initiative-and-project-updates) | Derive local stuck, stale/offline, failed-result, overdue-update, and dependency-blocker reasons with evidence and timestamps. |
| 2 | Structured health check-ins | Linear project updates include health, challenges, and next steps. [Linear](https://linear.app/docs/initiative-and-project-updates) | Add optional health, blocker, next step, and next-check fields to manually posted updates. |
| 3 | Dependencies and blocker map | Jira timelines represent blocking dependencies. [Jira](https://support.atlassian.com/jira-software-cloud/docs/create-or-remove-dependencies-on-your-timeline/) | Add optional task IDs, cycle validation, blocked filters, and a local relationship view. |
| 4 | Typed planning metadata | GitHub Projects supports date, number, text, and single-select fields. [GitHub](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields) | Add optional priority, target date, effort, and tags. |
| 5 | Saved views and focus mode | GitHub Projects and Linear support durable filtered views. [GitHub](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/managing-your-views), [Linear](https://linear.app/docs/custom-views) | Provide built-in review, assignment, stale, due-soon, and recently-finished presets; persist custom settings locally. |
| 6 | Table and roadmap views | GitHub offers table, board, and roadmap layouts. [GitHub](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects) | Render the same local snapshot as a sortable table and a target-date-only timeline, keeping Kanban as default. |
| 7 | Capacity and WIP indicators | Linear Cycles exposes capacity based on completed-work velocity. [Linear](https://linear.app/docs/use-cycles) | Calculate advisory active work, recent completions, completion age, and optional soft WIP limits. |
| 8 | Task templates | GitHub project templates preserve configured planning structure. [GitHub](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects) | Offer local Research, Implementation, Review, and Maintenance templates with acceptance criteria and suggested update cadence. |
| 9 | Provenance-rich activity timeline | Linear records property and milestone changes alongside updates. [Linear](https://linear.app/docs/initiative-and-project-updates) | Record append-only local creation, metadata, dispatch, result, and check-in events with human, self-report, or derived provenance. |
| 10 | Since-last-review digest | Devin highlights finished and input-required work; Linear emphasizes update visibility. [Devin](https://docs.devin.ai/desktop/agent-command-center), [Linear](https://linear.app/docs/initiative-and-project-updates) | Keep a local review cursor and show changed tasks, state changes, stale agents, and updates without notifications or task mutation. |

## Delivery sequence

1. Read-only review queue.
2. Structured health and planning metadata, then templates.
3. Focus presets, saved views, and table/timeline views.
4. Dependencies and activity provenance.
5. Advisory capacity indicators.
6. Since-last-review digest.

All derived signals must be explainable and advisory. Every write remains an explicit local form submission.
