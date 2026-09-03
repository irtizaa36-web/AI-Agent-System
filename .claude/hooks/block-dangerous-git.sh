#!/bin/bash

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# NOTE: the upstream mattpocock/skills version of this script also blocks
# plain "git push". That's dropped here on purpose - this repo's
# coworker/README.md protocol has every persona (macmini, Laptop2, Sam,
# Riley, Jordan) push its own completed task results as a normal, expected,
# already-sanctioned part of every check-in cycle. Blocking it wholesale
# would silently break that automation for everyone. Force-push and the
# other genuinely destructive/hard-to-reverse operations are still blocked.
DANGEROUS_PATTERNS=(
  "git push[^\"]*--force"
  "git push[^\"]*-f\b"
  "git reset --hard"
  "git clean -fd"
  "git clean -f"
  "git branch -D"
  "git checkout \."
  "git restore \."
  "push --force"
  "reset --hard"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: '$COMMAND' matches dangerous pattern '$pattern'. The user has prevented you from doing this." >&2
    exit 2
  fi
done

exit 0
