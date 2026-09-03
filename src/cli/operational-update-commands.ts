import { parseArgs } from "node:util";
import {
  createOperationalUpdate,
  OPERATIONAL_UPDATE_PROVENANCES,
  type OperationalUpdateProvenance,
} from "../dashboard/operational-update";
import type { CliDeps } from "./index";

function storeFor(deps: CliDeps) {
  if (!deps.operationalUpdateStore) throw new Error("Operational update store is not configured.");
  return deps.operationalUpdateStore;
}

async function addCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const usage = 'Usage: orchestrator operational-update add "<summary>" --by <author> --provenance human|agent|external_operator [--details "<details>"]';
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { by: { type: "string" }, provenance: { type: "string" }, details: { type: "string" } },
    allowPositionals: true,
  });
  const summary = positionals[0];
  if (!summary || !values.by || !values.provenance || !OPERATIONAL_UPDATE_PROVENANCES.includes(values.provenance as OperationalUpdateProvenance)) {
    deps.stderr(usage);
    return 1;
  }
  const update = createOperationalUpdate(summary, values.by, values.provenance as OperationalUpdateProvenance, values.details);
  await storeFor(deps).save(update);
  deps.stdout(`Logged operational update ${update.id} from ${update.by}.`);
  return 0;
}

async function listCommand(deps: CliDeps): Promise<number> {
  const updates = await storeFor(deps).list();
  if (updates.length === 0) {
    deps.stdout("No operational updates logged yet.");
    return 0;
  }
  for (const update of [...updates].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    deps.stdout(`${update.id}  [${update.provenance}]  ${update.createdAt}  ${update.by}: ${update.summary}`);
    if (update.details) deps.stdout(`  ${update.details}`);
  }
  return 0;
}

export async function runOperationalUpdateCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = args;
  try {
    if (subcommand === "add") return await addCommand(rest, deps);
    if (subcommand === "list") return await listCommand(deps);
  } catch (error) {
    deps.stderr((error as Error).message);
    return 1;
  }
  deps.stderr(
    [
      'Usage: orchestrator operational-update add "<summary>" --by <author> --provenance human|agent|external_operator [--details "<details>"]',
      "                  operational-update list",
    ].join("\n"),
  );
  return 1;
}
