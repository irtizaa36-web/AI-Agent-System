#!/bin/bash
# Recurring local check-in for the "macmini" coworker persona.
# Runs a real Claude Code process on this physical machine (not a cloud
# sandbox), independent of any single long-lived session - so it keeps
# working even if the hourly session-bound RemoteTrigger's session dies
# again (that's exactly what happened to the previous macmini identity on
# 2026-09-03: its environment was deleted and nothing noticed for hours).
# Registered via launchd - see coworker/README.md for the protocol.

set -euo pipefail
cd "/Users/irtizaahmed/AI-Agent-System"

PROMPT='In the AI-Agent-System repo, run this check-in for the "macmini" coworker persona:

1. git pull
2. npm run build
3. Read issue #1 (https://github.com/irtizaa36-web/AI-Agent-System/issues/1)
   via `gh issue view 1 --repo irtizaa36-web/AI-Agent-System --comments` and
   act on anything addressed to "macmini" or "Max" there before moving on.
4. node dist/cli/index.js coworker list --status pending --for macmini
5. If the list is empty:
   node dist/cli/index.js agent-status set macmini --status idle
   and stop - no need to touch git further.
6. For each task id listed, in order:
   a. node dist/cli/index.js coworker dispatched <id> --persona macmini
   b. node dist/cli/index.js agent-status set macmini --status working --task "<id or short description>"
   c. Do the actual work described in that tasks "task" text, using
      whatever agents, skills, tools, and connectors are already available
      in this environment - including this repos own `node dist/cli/index.js run --agent <name> --task "..."` /
      `node dist/cli/index.js dispatch run --task "..."` if one of its Packs fits better than doing
      it yourself directly. If genuinely stuck:
      node dist/cli/index.js agent-status set macmini --status stuck --task "..."
      before moving on, rather than leaving the last status looking like
      you are still quietly working.
   d. node dist/cli/index.js coworker complete <id> --persona macmini --output "<a short, honest summary of what you actually did or found>"
      (add --failed if it did not work out, with the output explaining why)
7. If any files under coworker/tasks or coworker/agents changed:
   git add coworker/tasks coworker/agents && git commit -m "macmini: complete coworker task(s)" && git push
   (if push is rejected because the remote moved, run git pull --rebase once and push again)

Do this without asking for confirmation on each step. Never handle money or
payments. Stop short and clearly flag anything that seems illegal, or that a
reasonable person would want to weigh in on before it happens - use this
repos own gated tools/approval flow (see coworker/README.md safety note)
for anything consequential like actually sending an email or submitting a
form, rather than skipping the approval step.'

echo "$PROMPT" | /Users/irtizaahmed/.local/bin/claude -p
