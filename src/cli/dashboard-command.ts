import { parseArgs } from "node:util";
import { createDashboardServer } from "../dashboard/server";
import type { CliDeps } from "./index";

export const DEFAULT_DASHBOARD_PORT = 4317;

/** `orchestrator dashboard [--port N]`: a local, read-only view of every agent and project — see coworker/README.md. */
export async function runDashboardCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { port: { type: "string" } } });
  const port = values.port ? Number(values.port) : DEFAULT_DASHBOARD_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    deps.stderr(`--port must be a positive integer (got "${values.port}").`);
    return 1;
  }

  const server = createDashboardServer({
    coworkerStore: deps.coworkerStore,
    agentStatusStore: deps.agentStatusStore,
    recommendationStore: deps.recommendationStore,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "localhost", () => resolve());
  });

  deps.stdout(`Dashboard is READY. Open http://localhost:${port} in a browser.`);
  deps.stdout("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}
