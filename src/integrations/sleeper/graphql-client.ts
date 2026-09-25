import type { WritePlan } from "./write-actions";
import type { SleeperWriteClient } from "./write-gate";

/**
 * The real Sleeper write client (ADR 0021): POSTs one operation to Sleeper's
 * private GraphQL endpoint, the one the Sleeper web app uses. It is
 * unofficial and undocumented; Sleeper can change or block it at any time,
 * and automating an account is at the owner's own risk.
 *
 * The only credential is the owner's own session token from SLEEPER_TOKEN.
 * Email/password login is deliberately not supported: the agent should never
 * hold the owner's password. Headers mirror the web app's
 * (joscaz/sleeper-mcp, src/sleeper/graphql.ts).
 *
 * This class is only ever called by `runSleeperWrite` with confirm:true.
 */
export const SLEEPER_GRAPHQL_URL = "https://sleeper.com/graphql";
const DEFAULT_TIMEOUT_MS = 30_000;

export class SleeperGraphqlError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, detail: string) {
    super(`Sleeper GraphQL error (HTTP ${statusCode}): ${detail}`);
    this.name = "SleeperGraphqlError";
    this.statusCode = statusCode;
  }
}

export interface RealSleeperWriteClientOptions {
  readonly token: string;
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class RealSleeperWriteClient implements SleeperWriteClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RealSleeperWriteClientOptions) {
    if (!options.token.trim()) throw new Error("RealSleeperWriteClient needs a non-empty token");
    this.url = options.url ?? SLEEPER_GRAPHQL_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(plan: WritePlan): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: "https://sleeper.com",
          referer: "https://sleeper.com/",
          "x-sleeper-graphql-op": plan.operation,
          authorization: this.options.token,
        },
        body: JSON.stringify({ operationName: plan.operation, variables: plan.variables, query: plan.query }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: { data?: Record<string, unknown> | null; errors?: { message?: string }[] } = {};
    try {
      payload = text ? (JSON.parse(text) as typeof payload) : {};
    } catch {
      throw new SleeperGraphqlError(response.status, "non-JSON response");
    }
    if (response.status === 401) {
      throw new SleeperGraphqlError(401, "Sleeper rejected the session token. It has probably expired: capture a fresh SLEEPER_TOKEN.");
    }
    if (payload.errors?.length) throw new SleeperGraphqlError(response.status, payload.errors.map((e) => e.message ?? "unknown").join("; "));
    if (!response.ok) throw new SleeperGraphqlError(response.status, response.statusText || "request failed");
    return payload.data?.[plan.operation] ?? null;
  }
}

/** The real write client when SLEEPER_TOKEN is set, otherwise undefined — never a fake, so nothing can pretend a write happened. */
export function createSleeperWriteClientFromEnv(): SleeperWriteClient | undefined {
  const token = process.env["SLEEPER_TOKEN"];
  return token && token.trim() ? new RealSleeperWriteClient({ token: token.trim() }) : undefined;
}
