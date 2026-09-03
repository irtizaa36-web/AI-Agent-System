import { parseArgs } from "node:util";
import {
  ALL_COWORKER_PERSONAS,
  coworkerTaskOverallStatus,
  createCoworkerTask,
  withDispatched,
  withResult,
  withUpdate,
  type CoworkerAssignment,
  type CoworkerPersona,
  type CoworkerTask,
} from "../coworker/task";
import type { CliDeps } from "./index";

function parsePersona(value: string | undefined, usage: string, deps: CliDeps): CoworkerPersona | undefined {
  if (value && (ALL_COWORKER_PERSONAS as readonly string[]).includes(value)) return value as CoworkerPersona;
  deps.stderr(`--persona must be one of: ${ALL_COWORKER_PERSONAS.join(", ")}\n${usage}`);
  return undefined;
}

function parseAssignment(value: string | undefined, usage: string, deps: CliDeps): CoworkerAssignment | undefined {
  const allowed = [...ALL_COWORKER_PERSONAS, "both"];
  if (value && allowed.includes(value)) return value as CoworkerAssignment;
  deps.stderr(`--to must be one of: ${allowed.join(", ")}\n${usage}`);
  return undefined;
}

async function findTask(deps: CliDeps, id: string): Promise<CoworkerTask | undefined> {
  const task = (await deps.coworkerStore.list()).find((t) => t.id === id);
  if (!task) {
    deps.stderr(`No coworker task "${id}" found.`);
    return undefined;
  }
  return task;
}

/** `coworker add "<task>" --to macmini|Laptop2|both`: writes down a new idea for a persona to pick up. */
async function addCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const usage = 'Usage: orchestrator coworker add "<task text>" --to macmini|Laptop2|both';
  const { values, positionals } = parseArgs({ args: [...args], options: { to: { type: "string" } }, allowPositionals: true });
  const taskText = positionals[0];
  if (!taskText) {
    deps.stderr(usage);
    return 1;
  }
  const assignedTo = parseAssignment(values.to, usage, deps);
  if (!assignedTo) return 1;

  const task = createCoworkerTask(taskText, assignedTo);
  await deps.coworkerStore.save(task);

  deps.stdout(`Added coworker task ${task.id} for ${assignedTo}: "${task.task}"`);
  return 0;
}

/** `coworker list [--status pending|in_progress|done] [--for macmini|Laptop2]`: the inspectable view of the shared list. */
async function listCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { status: { type: "string" }, for: { type: "string" } } });
  const tasks = await deps.coworkerStore.list();
  const filtered = tasks.filter((task) => {
    if (values.status && coworkerTaskOverallStatus(task) !== values.status) return false;
    if (values.for && !(task.assignedTo === values.for || task.assignedTo === "both")) return false;
    return true;
  });

  if (filtered.length === 0) {
    deps.stdout("No coworker tasks match.");
    return 0;
  }

  for (const task of filtered) {
    const overall = coworkerTaskOverallStatus(task);
    deps.stdout(`${task.id}  [${overall}]  assigned: ${task.assignedTo}  created: ${task.createdAt}`);
    deps.stdout(`  task: ${task.task}`);
    for (const [persona, result] of Object.entries(task.results)) {
      deps.stdout(`  - ${persona}: ${result?.status}${result?.output ? ` — ${result.output}` : ""}`);
    }
    const lastUpdate = task.updates?.[task.updates.length - 1];
    if (lastUpdate) deps.stdout(`  last update (${lastUpdate.by}, ${lastUpdate.at}): ${lastUpdate.note}`);
  }
  return 0;
}

/** `coworker dispatched <id> --persona macmini|Laptop2`: the watcher calls this right after actually sending the task via SendMessage. */
async function dispatchedCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const usage = "Usage: orchestrator coworker dispatched <id> --persona macmini|Laptop2";
  const { values, positionals } = parseArgs({ args: [...args], options: { persona: { type: "string" } }, allowPositionals: true });
  const id = positionals[0];
  const persona = parsePersona(values.persona, usage, deps);
  if (!id || !persona) {
    if (!id) deps.stderr(usage);
    return 1;
  }

  const task = await findTask(deps, id);
  if (!task) return 1;

  let updated;
  try {
    updated = withDispatched(task, persona);
  } catch (error) {
    deps.stderr((error as Error).message);
    return 1;
  }
  await deps.coworkerStore.save(updated);
  deps.stdout(`Task ${id} marked dispatched to ${persona}.`);
  return 0;
}

/** `coworker complete <id> --persona macmini|Laptop2 --output "<text>" [--failed]`: a persona calls this once it has actually done the work. */
async function completeCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const usage = 'Usage: orchestrator coworker complete <id> --persona macmini|Laptop2 --output "<text>" [--failed]';
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { persona: { type: "string" }, output: { type: "string" }, failed: { type: "boolean" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  const persona = parsePersona(values.persona, usage, deps);
  if (!id || !persona || values.output === undefined) {
    deps.stderr(usage);
    return 1;
  }

  const task = await findTask(deps, id);
  if (!task) return 1;

  let updated;
  try {
    updated = withResult(task, persona, values.output, !values.failed);
  } catch (error) {
    deps.stderr((error as Error).message);
    return 1;
  }
  await deps.coworkerStore.save(updated);
  deps.stdout(`Task ${id} marked ${values.failed ? "failed" : "succeeded"} for ${persona}.`);
  return 0;
}

/** `coworker update <id> --by <name> --note "<text>"`: a progress note, not a status change — anyone can leave one. */
async function updateCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const usage = 'Usage: orchestrator coworker update <id> --by <name> --note "<text>"';
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { by: { type: "string" }, note: { type: "string" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id || !values.by || !values.note) {
    deps.stderr(usage);
    return 1;
  }

  const task = await findTask(deps, id);
  if (!task) return 1;

  let updated;
  try {
    updated = withUpdate(task, values.by, values.note);
  } catch (error) {
    deps.stderr((error as Error).message);
    return 1;
  }
  await deps.coworkerStore.save(updated);
  deps.stdout(`Added an update to task ${id} from ${values.by}.`);
  return 0;
}

export async function runCoworkerCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "add":
      return addCommand(rest, deps);
    case "list":
      return listCommand(rest, deps);
    case "dispatched":
      return dispatchedCommand(rest, deps);
    case "complete":
      return completeCommand(rest, deps);
    case "update":
      return updateCommand(rest, deps);
    default:
      deps.stderr(
        [
          'Usage: orchestrator coworker add "<task text>" --to macmini|Laptop2|Riley|both',
          "                  coworker list [--status pending|in_progress|done] [--for macmini|Laptop2|Riley]",
          "                  coworker dispatched <id> --persona macmini|Laptop2|Riley",
          '                  coworker complete <id> --persona macmini|Laptop2|Riley --output "<text>" [--failed]',
          '                  coworker update <id> --by <name> --note "<text>"',
        ].join("\n"),
      );
      return 1;
  }
}
