import { parseArgs } from "node:util";
import { createAgentStatus, SELF_REPORTED_AGENT_STATUSES, type SelfReportedAgentStatus } from "../dashboard/agent-status";
import type { CliDeps } from "./index";

function parseStatus(value: string | undefined, deps: CliDeps): SelfReportedAgentStatus | undefined {
  if (value && (SELF_REPORTED_AGENT_STATUSES as readonly string[]).includes(value)) {
    return value as SelfReportedAgentStatus;
  }
  deps.stderr(`--status must be one of: ${SELF_REPORTED_AGENT_STATUSES.join(", ")}`);
  return undefined;
}

/** `agent-status set <name> --status idle|working|stuck [--task "..."]`: an agent reports its own current status. */
async function setCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const usage = 'Usage: orchestrator agent-status set <name> --status idle|working|stuck [--task "<description>"]';
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { status: { type: "string" }, task: { type: "string" } },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (!name) {
    deps.stderr(usage);
    return 1;
  }
  const status = parseStatus(values.status, deps);
  if (!status) {
    deps.stderr(usage);
    return 1;
  }

  await deps.agentStatusStore.save(createAgentStatus(name, status, values.task));
  deps.stdout(`${name} is now ${status}${values.task ? ` (${values.task})` : ""}.`);
  return 0;
}

/** `agent-status list`: the raw self-reported statuses (the dashboard shows the derived, at-a-glance version). */
async function listCommand(_args: readonly string[], deps: CliDeps): Promise<number> {
  const statuses = await deps.agentStatusStore.list();
  if (statuses.length === 0) {
    deps.stdout("No agent has reported a status yet.");
    return 0;
  }
  for (const status of statuses) {
    deps.stdout(`${status.name}: ${status.status}${status.currentTask ? ` (${status.currentTask})` : ""} — updated ${status.updatedAt}`);
  }
  return 0;
}

export async function runAgentStatusCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "set":
      return setCommand(rest, deps);
    case "list":
      return listCommand(rest, deps);
    default:
      deps.stderr(
        [
          'Usage: orchestrator agent-status set <name> --status idle|working|stuck [--task "<description>"]',
          "                  agent-status list",
        ].join("\n"),
      );
      return 1;
  }
}
