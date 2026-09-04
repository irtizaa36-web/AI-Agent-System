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

# launchd's minimal environment doesn't include Homebrew's bin dir, so
# "npm"/"node" alone resolve to nothing under launchd (though they work
# fine in an interactive shell) - use absolute paths, same as
# com.aiagentsystem.inkbox-webhook.plist already does for node.
export PATH="/opt/homebrew/bin:$PATH"

/opt/homebrew/bin/npm run build

exec /opt/homebrew/bin/node dist/cli/index.js dashboard --port 4317
