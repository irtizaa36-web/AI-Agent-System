---
status: accepted
---

# Domain-specific content lives in Packs, not Core

This orchestrator is meant to be the reusable engine underneath several future, unrelated products (a clinical-reasoning assistant, a research-opportunity agent, a medical-career advisor), not a single application. We decided Agents are contributed by **Packs** — self-contained bundles that each `register()` their Agent definitions (and, later, their own Tools) into the Registry — rather than by editing one shared list of agents in the engine itself. `config/load.ts` now only wires up engine-level Providers/Tools and loops over an `ENABLED_PACKS` list; `src/packs/core-demo/` holds today's placeholder `default`/`demo` agents as the first (non-domain) example of the pattern. This is hard to reverse once real domain content accumulates across three products, and a new contributor could reasonably assume domain logic belongs directly in `core/` without this being written down. We chose to nest Packs under `src/packs/` rather than a top-level `packs/` directory for now, purely to avoid touching `tsconfig.json`'s `rootDir`/`outDir` and the CLI's build paths for no functional benefit; moving them to the repo root is a cheap, mechanical change to make later if/when Packs need independent versioning or publishing.
