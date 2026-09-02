---
status: accepted
---

# Ports-and-adapters architecture, with Core free of I/O

We need the Orchestrator to be usable from a CLI now and an HTTP API later, and to run against Claude now and other model vendors (e.g. Fable) later, without a rewrite either time. We decided to put all domain logic (Task/Agent/Run/Session/the Run loop) in a Core module that never performs I/O itself and only depends on small interfaces — `ModelProvider` and `Tool` — supplied by the caller. Everything that varies (which vendor answers, which tools exist, how a request arrives, where Run history is stored) lives in adapters outside Core: `providers/`, `tools/`, `cli/`, `store/`. This is harder to reverse than a direct CLI-calls-Claude design and isn't the obvious first thing to build, but it's exactly the trade-off that lets a second Provider or a second entrypoint be added later as a new adapter, with zero changes to Core.
