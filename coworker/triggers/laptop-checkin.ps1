# Recurring local check-in for the "Laptop" coworker persona.
# Runs a real Claude Code process on this machine (not a cloud sandbox) so
# tasks needing local-only state (saved logins, local files) still work.
# Registered via Windows Task Scheduler - see coworker/README.md for the protocol.

Set-Location "C:\Users\Irtiza Ahmed\Documents\AI-Agent-System"

$prompt = @'
In the AI-Agent-System repo, run this check-in for the "Laptop" coworker persona:

1. git pull
2. npm run build
3. node dist/cli/index.js coworker list --status pending --for Laptop
   (Windows note: never use "npm run cli --" for coworker add/complete here -
   it mangles multi-word text. Always call node dist/cli/index.js directly.)
4. If the list is empty, say so and stop - no need to touch git further.
5. For each task id listed, in order:
   a. node dist/cli/index.js coworker dispatched <id> --persona Laptop
   b. Do the actual work described in that task's "task" text, using
      whatever agents, skills, tools, and connectors are already available
      in this environment - including this repo's own `orchestrator run` /
      `orchestrator dispatch run` if one of its Packs fits better than doing
      it yourself directly.
   c. node dist/cli/index.js coworker complete <id> --persona Laptop --output "<a short, honest summary of what you actually did or found>"
      (add --failed if it did not work out, with the output explaining why)
6. If any files under coworker/tasks changed: git add coworker/tasks && git commit -m "Laptop: complete coworker task(s)" && git push
   (if push is rejected because the remote moved, run git pull --rebase once and push again)

Do this without asking for confirmation on each step. Never handle money or
payments. Stop short and clearly flag anything that seems illegal, or that a
reasonable person would want to weigh in on before it happens - use this
repo's own gated tools/approval flow (see coworker/README.md's safety note)
for anything consequential like actually sending an email or submitting a
form, rather than skipping the approval step.
'@

$prompt | claude -p
