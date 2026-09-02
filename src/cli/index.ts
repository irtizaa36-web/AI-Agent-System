import { parseArgs } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  /** Working directory `status` checks Git/build state against. Defaults to process.cwd() in `main`. */
  readonly cwd: string;
}

function printUsage(stdout: (line: string) => void): void {
  stdout(
    [
      "Usage:",
      '  orchestrator run --task "<instructions>" [--agent <name>]   Run a task through an agent',
      "  orchestrator list-agents                                    List configured agents",
      "  orchestrator status                                         Show a snapshot of the project",
      "  orchestrator help                                           Show this message",
      "",
      'Try it with no API key: orchestrator run --task "say hello" --agent demo',
    ].join("\n"),
  );
}

/** Pulls the pass/fail summary out of `node --test`'s own report. Pure — no I/O — so it's testable without a real test run. */
export function parseTestSummary(output: string): string | undefined {
  const total = output.match(/^ℹ tests (\d+)$/m)?.[1];
  const pass = output.match(/^ℹ pass (\d+)$/m)?.[1];
  const fail = output.match(/^ℹ fail (\d+)$/m)?.[1];
  if (!total || !pass || !fail) return undefined;
  return fail === "0" ? `${pass}/${total} passing` : `${pass}/${total} passing, ${fail} failing`;
}

/** Best-effort: actually runs the compiled test suite if it's been built, rather than guessing. */
export function getTestStatus(cwd: string): string {
  const distDir = join(cwd, "dist");
  if (!existsSync(distDir)) {
    return "not built yet (run `npm run build` or `npm test`)";
  }

  const result = spawnSync(process.execPath, ["--test", distDir], { cwd, encoding: "utf-8" });
  const summary = parseTestSummary(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return summary ?? "unable to determine (run `npm test` manually)";
}

/** Best-effort: reports whether the Git working tree has uncommitted changes. */
export function getGitStatus(cwd: string): string {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    return "unknown (not a Git repository, or git is unavailable)";
  }
  const changedFiles = result.stdout.split("\n").filter((line) => line.trim().length > 0);
  return changedFiles.length === 0 ? "clean" : `${changedFiles.length} file(s) with uncommitted changes`;
}

function statusCommand(deps: CliDeps): number {
  const agents = deps.registry.listAgents();
  const providers = deps.registry.listProviders();
  const tools = deps.registry.listTools();
  const packs = deps.registry.listPacks();

  deps.stdout("AI-Agent-System status");
  deps.stdout("-----------------------");
  deps.stdout(`Agents:    ${agents.length} (${agents.map((a) => a.name).join(", ") || "none"})`);
  deps.stdout(`Providers: ${providers.length} (${providers.map((p) => p.name).join(", ") || "none"})`);
  deps.stdout(`Tools:     ${tools.length} (${tools.map((t) => t.name).join(", ") || "none"})`);
  deps.stdout(`Packs:     ${packs.length} (${packs.join(", ") || "none"})`);
  deps.stdout(`Tests:     ${getTestStatus(deps.cwd)}`);
  deps.stdout(`Git:       ${getGitStatus(deps.cwd)}`);
  deps.stdout("");
  deps.stdout("Capabilities currently available:");
  for (const agent of agents) {
    deps.stdout(
      `  - Run "${agent.name}" (provider: ${agent.providerName}, tools: ${agent.toolNames.join(", ") || "none"})`,
    );
  }

  return 0;
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

  if (command === "status") {
    return statusCommand(deps);
  }

  deps.stderr(`Unknown command "${command}". Run "orchestrator help" for usage.`);
  return 1;
}

async function main(): Promise<void> {
  const registry = loadDefaultConfig();
  const cwd = process.cwd();
  const store = new JsonFileRunStore(join(cwd, ".orchestrator", "runs"));

  const exitCode = await runCli(process.argv.slice(2), {
    registry,
    store,
    cwd,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });

  process.exit(exitCode);
}

if (require.main === module) {
  void main();
}
