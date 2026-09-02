---
status: accepted
---

# Consequential tools: split read/draft from send/execute, and defer approval-gating

As this orchestrator grows toward taking real-world action (sending email, submitting a return, browser automation), any Tool whose effects are hard to undo must be split into a safe read/draft operation (e.g. `draft-email`) and a distinct, separately-named send/execute operation (e.g. `send-email`) — never one tool that does both — so that a future approval gate can target the consequential half without blocking the safe half. We also decided to deliberately defer building that approval gate in Core (a `requiresApproval` marker on `ToolSpec`, a paused `RunStatus`, etc.) until a real consequential Tool exists to design it against. Building it now, with no consequential Tool to validate the shape against, would mean guessing at an abstraction instead of extracting one from an actual use case.
