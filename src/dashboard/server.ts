import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ALL_COWORKER_PERSONAS, createCoworkerTask, withUpdate, type CoworkerAssignment } from "../coworker/task";
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

// A dashboard form submission is tiny; this just bounds abuse from a malformed/huge body.
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const parsed: unknown = raw.trim().length === 0 ? {} : JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("request body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function isValidAssignment(value: unknown): value is CoworkerAssignment {
  return typeof value === "string" && ((ALL_COWORKER_PERSONAS as readonly string[]).includes(value) || value === "both");
}

async function handleCreateTask(req: IncomingMessage, res: ServerResponse, deps: DashboardServerDeps): Promise<void> {
  const body = await readJsonBody(req);
  const task = typeof body["task"] === "string" ? body["task"] : "";
  const assignedTo = body["assignedTo"];
  if (task.trim().length === 0) {
    sendJson(res, 400, { error: '"task" must be a non-empty string' });
    return;
  }
  if (!isValidAssignment(assignedTo)) {
    sendJson(res, 400, { error: `"assignedTo" must be one of: ${[...ALL_COWORKER_PERSONAS, "both"].join(", ")}` });
    return;
  }

  const created = createCoworkerTask(task, assignedTo);
  await deps.coworkerStore.save(created);
  sendJson(res, 201, created);
}

async function handleAddUpdate(req: IncomingMessage, res: ServerResponse, deps: DashboardServerDeps, taskId: string): Promise<void> {
  const body = await readJsonBody(req);
  const by = typeof body["by"] === "string" ? body["by"] : "";
  const note = typeof body["note"] === "string" ? body["note"] : "";
  if (by.trim().length === 0 || note.trim().length === 0) {
    sendJson(res, 400, { error: '"by" and "note" must both be non-empty strings' });
    return;
  }

  const task = (await deps.coworkerStore.list()).find((t) => t.id === taskId);
  if (!task) {
    sendJson(res, 404, { error: `no task "${taskId}" found` });
    return;
  }

  const updated = withUpdate(task, by, note);
  await deps.coworkerStore.save(updated);
  sendJson(res, 200, updated);
}

/**
 * The local dashboard: one HTML page, a JSON snapshot endpoint it polls,
 * and two small write endpoints (add a task, add a progress note) so the
 * page itself can be the primary way to create and track work — not just a
 * read-only view. No auth, no remote access — bind to localhost only (the
 * CLI command does this); per "don't worry about remote access yet", the
 * write endpoints stay open to anyone who can already reach localhost.
 */
export function createDashboardServer(deps: DashboardServerDeps): Server {
  return createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/") {
        sendHtml(res, DASHBOARD_HTML);
        return;
      }

      if (req.method === "GET" && req.url === "/api/snapshot") {
        const [tasks, agentStatuses, recommendations] = await Promise.all([
          deps.coworkerStore.list(),
          deps.agentStatusStore.list(),
          deps.recommendationStore.list(),
        ]);
        sendJson(res, 200, buildDashboardSnapshot(tasks, agentStatuses, recommendations));
        return;
      }

      if (req.method === "POST" && req.url === "/api/tasks") {
        await handleCreateTask(req, res, deps);
        return;
      }

      const updateMatch = req.method === "POST" ? req.url?.match(/^\/api\/tasks\/([^/]+)\/updates$/) : undefined;
      if (updateMatch) {
        await handleAddUpdate(req, res, deps, decodeURIComponent(updateMatch[1]));
        return;
      }

      sendJson(res, req.method === "GET" || req.method === "POST" ? 404 : 405, { error: "not found" });
    })().catch((error: unknown) => {
      sendJson(res, 400, { error: (error as Error).message });
    });
  });
}
