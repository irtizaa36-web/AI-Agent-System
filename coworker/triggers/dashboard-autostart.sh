#!/bin/bash
# Keeps the coworker dashboard running in the background on this machine,
# so it's always reachable at http://localhost:4317 without anyone having
# to remember to start it - the point of turning it into a pinned desktop
# window (see coworker/README.md / docs/operations/local-operations.md).
# Registered via launchd (KeepAlive) as com.aiagentsystem.dashboard - the
# actual .plist is local-machine-only, not committed, same convention as
# com.aiagentsystem.inkbox-webhook and com.aiagentsystem.macmini-checkin.

set -euo pipefail
cd "/Users/irtizaahmed/AI-Agent-System"

npm run build

exec node dist/cli/index.js dashboard --port 4317
