import { parseArgs } from "node:util";
import { join } from "node:path";
import { createTask } from "../core/task";
import { runToCompletion } from "../core/orchestrator";
import { loadDefaultConfig } from "../config/load";
import { JsonFileRunStore } from "../store/run-store";
import type { Registry } from "../registry/registry";
import type { RunStore } from "../store/run-store";

export interface CliDeps {
  readonly registry: Registry;
  readonly store: RunStore;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

function printUsage(stdout: (line: string) => void): void {
  stdout(
    [
      "Usage:",
      '  orchestrator run --task "<instructions>" [--agent <name>]   Run a task through an agent',
      "  orchestrator list-agents                                    List configured agents",
      "  orchestrator help                                           Show this message",
      "",
      'Try it with no API key: orchestrator run --task "say hello" --agent demo',
    ].join("\n"),
  );
}

async function runTaskCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  let taskText: string | undefined;
  let agentName: string | undefined;
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { task: { type: "string" }, agent: { type: "string" } },
      allowPositionals: true,
    });
    taskText = parsed.values.task ?? parsed.positionals[0];
    agentName = parsed.values.agent;
  } catch (error) {
    deps.stderr(`Invalid arguments: ${(error as Error).message}`);
    return 1;
  }

  if (!taskText) {
    deps.stderr('Usage: orchestrator run --task "<instructions>" [--agent <name>]');
    return 1;
  }

  let agent;
  try {
    agent = deps.registry.getAgent(agentName ?? "default");
  } catch (error) {
    deps.stderr((error as Error).message);
    return 1;
  }

  const provider = deps.registry.getProvider(agent.providerName);
  const tools = deps.registry.toolMapFor(agent.toolNames);
  const task = createTask(taskText);

  deps.stdout(`Running task "${task.instructions}" with agent "${agent.name}" (provider: ${agent.providerName})...`);

  try {
    const run = await runToCompletion(task, agent, { provider, tools });
    await deps.store.save(run);

    if (run.status === "succeeded") {
      deps.stdout(`\nResult (run ${run.id}, ${run.steps.length} step(s)):\n${run.result?.output ?? ""}`);
      return 0;
    }

    deps.stderr(`\nRun ${run.id} failed: ${run.result?.error ?? "unknown error"}`);
    return 1;
  } catch (error) {
    deps.stderr(`\nRun failed: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * The CLI's actual logic, kept separate from process.argv/process.exit so it
 * can be tested directly with injected dependencies. `main` below is the
 * only part of this file that touches the real process.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help") {
    printUsage(deps.stdout);
    return 0;
  }

  if (command === "list-agents") {
    for (const agent of deps.registry.listAgents()) {
      deps.stdout(`${agent.name}\t(provider: ${agent.providerName}, model: ${agent.model})`);
    }
    return 0;
  }

  if (command === "run") {
    return runTaskCommand(rest, deps);
  }

  deps.stderr(`Unknown command "${command}". Run "orchestrator help" for usage.`);
  return 1;
}

async function main(): Promise<void> {
  const registry = loadDefaultConfig();
  const store = new JsonFileRunStore(join(process.cwd(), ".orchestrator", "runs"));

  const exitCode = await runCli(process.argv.slice(2), {
    registry,
    store,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });

  process.exit(exitCode);
}

if (require.main === module) {
  void main();
}
