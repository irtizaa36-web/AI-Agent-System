import { parseArgs } from "node:util";
import { createRecommendation, withImplemented } from "../dashboard/recommendation";
import type { CliDeps } from "./index";

/** `recommend add "<summary>" --scope dashboard|system|<project>`: log something noticed, before or instead of acting on it. */
async function addCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const usage = 'Usage: orchestrator recommend add "<summary>" --scope dashboard|system|<project-name>';
  const { values, positionals } = parseArgs({ args: [...args], options: { scope: { type: "string" } }, allowPositionals: true });
  const summary = positionals[0];
  if (!summary || !values.scope) {
    deps.stderr(usage);
    return 1;
  }

  const recommendation = createRecommendation(values.scope, summary);
  await deps.recommendationStore.save(recommendation);
  deps.stdout(`Logged recommendation ${recommendation.id} (${values.scope}): "${summary}"`);
  return 0;
}

/** `recommend implemented <id> [--details "..."]`: record that a logged recommendation was actually acted on. */
async function implementedCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const usage = 'Usage: orchestrator recommend implemented <id> [--details "<what changed>"]';
  const { values, positionals } = parseArgs({ args: [...args], options: { details: { type: "string" } }, allowPositionals: true });
  const id = positionals[0];
  if (!id) {
    deps.stderr(usage);
    return 1;
  }

  const recommendation = (await deps.recommendationStore.list()).find((r) => r.id === id);
  if (!recommendation) {
    deps.stderr(`No recommendation "${id}" found.`);
    return 1;
  }

  await deps.recommendationStore.save(withImplemented(recommendation, values.details));
  deps.stdout(`Recommendation ${id} marked implemented.`);
  return 0;
}

async function listCommand(_args: readonly string[], deps: CliDeps): Promise<number> {
  const recommendations = await deps.recommendationStore.list();
  if (recommendations.length === 0) {
    deps.stdout("No recommendations logged yet.");
    return 0;
  }
  for (const r of recommendations) {
    deps.stdout(`${r.id}  [${r.implemented ? "implemented" : "pending"}]  (${r.scope})  ${r.summary}`);
    if (r.details) deps.stdout(`  ${r.details}`);
  }
  return 0;
}

export async function runRecommendCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "add":
      return addCommand(rest, deps);
    case "implemented":
      return implementedCommand(rest, deps);
    case "list":
      return listCommand(rest, deps);
    default:
      deps.stderr(
        [
          'Usage: orchestrator recommend add "<summary>" --scope dashboard|system|<project-name>',
          '                  recommend implemented <id> [--details "<what changed>"]',
          "                  recommend list",
        ].join("\n"),
      );
      return 1;
  }
}
