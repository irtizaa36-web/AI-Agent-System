# AI-Agent-System

A model-agnostic, CLI-first orchestrator for running AI agents against tasks.

## Language

**Orchestrator**:
The top-level process that receives a Task, decides how to execute it, and coordinates one or more Agent Runs to produce a Result.
_Avoid_: engine, runner

**Agent**:
A configured persona: a role/instructions, a Model, a set of Tools, and a policy for using them. A definition, not a running thing.
_Avoid_: bot, assistant

**Task**:
A unit of work submitted to the Orchestrator: intent, inputs, and success criteria. A spec, not an execution.
_Avoid_: job, request

**Run**:
One execution of a Task by an Agent. Has a lifecycle (queued → running → succeeded/failed) and produces a Result. A Task may have several Runs (retries).
_Avoid_: execution, invocation

**Step**:
One model turn within a Run: a prompt sent, a response received, and any Tool Calls in between.
_Avoid_: turn, cycle

**Session**:
The accumulated message history for a Run, carried across Steps and handed to the Model each time.
_Avoid_: context, conversation

**Model**:
A specific LLM identified by a Provider and a model id (e.g. Anthropic + `claude-sonnet-5`). What generates text/tool calls for a Step.
_Avoid_: LLM, engine

**Provider**:
An adapter that speaks one vendor's API (Anthropic, and later others) and exposes it through the Orchestrator's generic Model interface. The seam that makes the Orchestrator model-agnostic.
_Avoid_: client, connector

**Tool**:
A capability exposed to a Model during a Run so it can act on the world (read a file, run a command, call an API). Distinct from Provider: Providers talk to Models, Tools let Models act.
_Avoid_: function, action

**Registry**:
Where Agents, Providers, and Tools are registered by name so the Orchestrator can look them up when building a Run.
_Avoid_: catalog, container

**Pack**:
A self-contained bundle of Agent definitions (and, later, domain-specific Tools) for one product or domain — e.g. a future clinical-reasoning or research-agent product — loaded into the Registry independently of the engine. The seam between this reusable orchestrator and any domain-specific content built on top of it.
_Avoid_: plugin, module, extension

**Result**:
The final output of a Run: status (succeeded/failed), output payload, and any error.
_Avoid_: output, response

**Workflow**:
A defined sequence or graph of Tasks handed to one or more Agents to reach a larger goal, with dependencies between them. Named for future use; not yet built.
_Avoid_: pipeline, plan
