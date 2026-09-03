import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ALL_COWORKER_PERSONAS,
  createCoworkerTask,
  withDispatched,
  withResult,
  withUpdate,
  type CoworkerAssignment,
  type CoworkerPersona,
} from "../coworker/task";
import type { CoworkerTaskStore } from "../coworker/store";
import type { AgentStatusStore } from "./agent-status-store";
import type { RecommendationStore } from "./recommendation-store";
import { createOperationalUpdate, OPERATIONAL_UPDATE_PROVENANCES, type OperationalUpdateProvenance } from "./operational-update";
import type { OperationalUpdateStore } from "./operational-update-store";
import { buildDashboardSnapshot } from "./snapshot";
import { DASHBOARD_HTML } from "./page";

export interface DashboardServerDeps {
  readonly coworkerStore: CoworkerTaskStore;
  readonly agentStatusStore: AgentStatusStore;
  readonly recommendationStore: RecommendationStore;
  readonly operationalUpdateStore: OperationalUpdateStore;
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

function isValidPersona(value: unknown): value is CoworkerPersona {
  return typeof value === "string" && (ALL_COWORKER_PERSONAS as readonly string[]).includes(value);
}

async function findTask(deps: DashboardServerDeps, taskId: string) {
  return (await deps.coworkerStore.list()).find((t) => t.id === taskId);
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

  const task = await findTask(deps, taskId);
  if (!task) {
    sendJson(res, 404, { error: `no task "${taskId}" found` });
    return;
  }

  const updated = withUpdate(task, by, note);
  await deps.coworkerStore.save(updated);
  sendJson(res, 200, updated);
}

/** Lets the dashboard itself mark a persona as picked up — the same transition `coworker dispatched` makes from the CLI. */
async function handleDispatch(req: IncomingMessage, res: ServerResponse, deps: DashboardServerDeps, taskId: string): Promise<void> {
  const body = await readJsonBody(req);
  const persona = body["persona"];
  if (!isValidPersona(persona)) {
    sendJson(res, 400, { error: `"persona" must be one of: ${ALL_COWORKER_PERSONAS.join(", ")}` });
    return;
  }

  const task = await findTask(deps, taskId);
  if (!task) {
    sendJson(res, 404, { error: `no task "${taskId}" found` });
    return;
  }

  try {
    const updated = withDispatched(task, persona);
    await deps.coworkerStore.save(updated);
    sendJson(res, 200, updated);
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
  }
}

/** Lets the dashboard itself record a persona's finished result — the same transition `coworker complete` makes from the CLI. */
async function handleComplete(req: IncomingMessage, res: ServerResponse, deps: DashboardServerDeps, taskId: string): Promise<void> {
  const body = await readJsonBody(req);
  const persona = body["persona"];
  const output = typeof body["output"] === "string" ? body["output"] : "";
  const failed = body["failed"] === true;
  if (!isValidPersona(persona)) {
    sendJson(res, 400, { error: `"persona" must be one of: ${ALL_COWORKER_PERSONAS.join(", ")}` });
    return;
  }

  const task = await findTask(deps, taskId);
  if (!task) {
    sendJson(res, 404, { error: `no task "${taskId}" found` });
    return;
  }

  try {
    const updated = withResult(task, persona, output, !failed);
    await deps.coworkerStore.save(updated);
    sendJson(res, 200, updated);
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
  }
}

/** Lets the dashboard itself record a concise operational handoff — a separate feed from per-task updates, for coordination context that isn't about one task. */
async function handleCreateOperationalUpdate(req: IncomingMessage, res: ServerResponse, deps: DashboardServerDeps): Promise<void> {
  const body = await readJsonBody(req);
  const summary = typeof body["summary"] === "string" ? body["summary"] : "";
  const by = typeof body["by"] === "string" ? body["by"] : "";
  const provenance = body["provenance"];
  const details = typeof body["details"] === "string" ? body["details"] : undefined;
  if (!summary.trim() || !by.trim() || typeof provenance !== "string" || !OPERATIONAL_UPDATE_PROVENANCES.includes(provenance as OperationalUpdateProvenance)) {
    sendJson(res, 400, { error: '"summary", "by", and a valid "provenance" are required' });
    return;
  }
  const update = createOperationalUpdate(summary, by, provenance as OperationalUpdateProvenance, details);
  await deps.operationalUpdateStore.save(update);
  sendJson(res, 201, update);
}

/**
 * The local dashboard: one HTML page, a JSON snapshot endpoint it polls,
 * and small write endpoints (add a task, add a progress note, dispatch a
 * persona, record a persona's result, post an operational update) so the
 * page itself is somewhere you can actually operate the coworker loop —
 * not just watch it. Dispatch and complete are the exact same domain
 * transitions `coworker dispatched`/`coworker complete` make from the CLI
 * (same task.ts functions), so a task moved from the dashboard is
 * indistinguishable from one moved by a persona's own check-in.
 * Operational updates are a separate, task-independent feed for
 * coordination context (see operational-update.ts). No auth, no remote
 * access — bind to localhost only (the CLI command does this); per "don't
 * worry about remote access yet", the write endpoints stay open to anyone
 * who can already reach localhost.
 */
export function createDashboardServer(deps: DashboardServerDeps): Server {
  return createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/") {
        sendHtml(res, DASHBOARD_HTML);
        return;
      }

      if (req.method === "GET" && req.url === "/api/snapshot") {
        const [tasks, agentStatuses, recommendations, operationalUpdates] = await Promise.all([
          deps.coworkerStore.list(),
          deps.agentStatusStore.list(),
          deps.recommendationStore.list(),
          deps.operationalUpdateStore.list(),
        ]);
        sendJson(res, 200, buildDashboardSnapshot(tasks, agentStatuses, recommendations, undefined, undefined, operationalUpdates));
        return;
      }

      if (req.method === "POST" && req.url === "/api/tasks") {
        await handleCreateTask(req, res, deps);
        return;
      }
      if (req.method === "POST" && req.url === "/api/operational-updates") {
        await handleCreateOperationalUpdate(req, res, deps);
        return;
      }

      const updateMatch = req.method === "POST" ? req.url?.match(/^\/api\/tasks\/([^/]+)\/updates$/) : undefined;
      if (updateMatch) {
        await handleAddUpdate(req, res, deps, decodeURIComponent(updateMatch[1]));
        return;
      }

      const dispatchMatch = req.method === "POST" ? req.url?.match(/^\/api\/tasks\/([^/]+)\/dispatch$/) : undefined;
      if (dispatchMatch) {
        await handleDispatch(req, res, deps, decodeURIComponent(dispatchMatch[1]));
        return;
      }

      const completeMatch = req.method === "POST" ? req.url?.match(/^\/api\/tasks\/([^/]+)\/complete$/) : undefined;
      if (completeMatch) {
        await handleComplete(req, res, deps, decodeURIComponent(completeMatch[1]));
        return;
      }

      sendJson(res, req.method === "GET" || req.method === "POST" ? 404 : 405, { error: "not found" });
    })().catch((error: unknown) => {
      sendJson(res, 400, { error: (error as Error).message });
    });
  });
}
