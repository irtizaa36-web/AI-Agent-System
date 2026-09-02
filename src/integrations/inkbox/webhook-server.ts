import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  checkTimestampFreshness,
  extractWebhookHeaders,
  parseWebhookPayload,
  ReplayGuard,
  verifyBearerToken,
  verifySignature,
} from "./webhook";
import { handleInkboxWebhookEvent, type WebhookHandlerDeps, type WebhookHandlingResult } from "./webhook-handler";

// Generous for a JSON mail-event payload, small enough to bound abuse from an unauthenticated body read.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface RejectedRequestInfo {
  readonly reason: string;
  readonly statusCode: number;
}

export interface WebhookServerOptions {
  readonly path: string;
  readonly signingKey: string;
  readonly authToken?: string;
  readonly timestampToleranceSeconds?: number;
  readonly onEvent?: (result: WebhookHandlingResult) => void;
  readonly onRejected?: (info: RejectedRequestInfo) => void;
}

function readRawBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

/**
 * Builds (but does not start listening on) the Inkbox mail webhook receiver.
 * Verification order: bearer token, then Inkbox's own HMAC signature, then
 * timestamp freshness, then request-id replay dedup — cheapest and least
 * trusted checks first, so a request never reaches event handling until all
 * four have passed.
 */
export function createInkboxWebhookServer(deps: WebhookHandlerDeps, options: WebhookServerOptions): Server {
  const toleranceSeconds = options.timestampToleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
  const replayGuard = new ReplayGuard(toleranceSeconds);

  const healthPath = `${options.path}/health`;

  return createServer((req, res) => {
    void (async () => {
      // Unauthenticated on purpose: this is a local/manual readiness probe
      // (`orchestrator inkbox webhook-health`), not an Inkbox delivery, so it
      // is never signed. It confirms the receiver is up and reports whether
      // a bearer token is required — never the signing key or token itself.
      if (req.method === "GET" && req.url === healthPath) {
        sendJson(res, 200, { status: "ok", path: options.path, bearerTokenRequired: Boolean(options.authToken) });
        return;
      }

      if (req.method !== "POST" || req.url !== options.path) {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      let rawBody: Buffer;
      try {
        rawBody = await readRawBody(req, MAX_BODY_BYTES);
      } catch {
        sendJson(res, 413, { error: "payload too large" });
        return;
      }

      const headers = extractWebhookHeaders(req.headers as Record<string, string | readonly string[] | undefined>);

      const bearerCheck = verifyBearerToken(headers.authorization, options.authToken);
      if (!bearerCheck.ok) {
        options.onRejected?.({ reason: bearerCheck.reason ?? "unauthorized", statusCode: 401 });
        sendJson(res, 401, { error: bearerCheck.reason ?? "unauthorized" });
        return;
      }

      const signatureCheck = verifySignature(rawBody, headers, options.signingKey);
      if (!signatureCheck.ok) {
        options.onRejected?.({ reason: signatureCheck.reason ?? "invalid signature", statusCode: 401 });
        sendJson(res, 401, { error: signatureCheck.reason ?? "invalid signature" });
        return;
      }

      const freshnessCheck = checkTimestampFreshness(headers.timestamp, toleranceSeconds);
      if (!freshnessCheck.ok) {
        options.onRejected?.({ reason: freshnessCheck.reason ?? "stale timestamp", statusCode: 400 });
        sendJson(res, 400, { error: freshnessCheck.reason ?? "stale timestamp" });
        return;
      }

      // Both required by verifySignature having already succeeded above.
      const requestId = headers.requestId as string;
      if (!replayGuard.checkAndRecord(requestId)) {
        sendJson(res, 200, { ok: true, duplicate: true });
        return;
      }

      const parsed = parseWebhookPayload(rawBody.toString("utf-8"));
      if (!parsed.ok) {
        if (parsed.unknownEvent) {
          sendJson(res, 200, { ok: true, ignored: true });
          return;
        }
        options.onRejected?.({ reason: parsed.reason, statusCode: 400 });
        sendJson(res, 400, { error: parsed.reason });
        return;
      }

      try {
        const result = await handleInkboxWebhookEvent(parsed.event, deps);
        options.onEvent?.(result);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { error: (error as Error).message });
      }
    })();
  });
}

export interface StartedWebhookServer {
  readonly server: Server;
  readonly port: number;
}

/** Starts the receiver and resolves once it's actually bound and listening — never before. */
export function startInkboxWebhookServer(
  deps: WebhookHandlerDeps,
  options: WebhookServerOptions & { readonly port: number },
): Promise<StartedWebhookServer> {
  const server = createInkboxWebhookServer(deps, options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({ server, port });
    });
  });
}
