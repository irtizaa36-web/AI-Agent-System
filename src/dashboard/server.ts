import { createServer, type Server, type ServerResponse } from "node:http";
import type { CoworkerTaskStore } from "../coworker/store";
import type { AgentStatusStore } from "./agent-status-store";
import type { RecommendationStore } from "./recommendation-store";
import { buildDashboardSnapshot } from "./snapshot";
import { DASHBOARD_HTML } from "./page";

export interface DashboardServerDeps {
  readonly coworkerStore: CoworkerTaskStore;
  readonly agentStatusStore: AgentStatusStore;
  readonly recommendationStore: RecommendationStore;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * A read-only local dashboard: one HTML page plus one JSON endpoint it
 * polls. No auth, no remote access — bind to localhost only (the CLI
 * command does this), per "don't worry about remote access yet".
 */
export function createDashboardServer(deps: DashboardServerDeps): Server {
  return createServer((req, res) => {
    void (async () => {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }

      if (req.url === "/") {
        sendHtml(res, DASHBOARD_HTML);
        return;
      }

      if (req.url === "/api/snapshot") {
        const [tasks, agentStatuses, recommendations] = await Promise.all([
          deps.coworkerStore.list(),
          deps.agentStatusStore.list(),
          deps.recommendationStore.list(),
        ]);
        sendJson(res, 200, buildDashboardSnapshot(tasks, agentStatuses, recommendations));
        return;
      }

      sendJson(res, 404, { error: "not found" });
    })().catch((error: unknown) => {
      sendJson(res, 500, { error: (error as Error).message });
    });
  });
}
