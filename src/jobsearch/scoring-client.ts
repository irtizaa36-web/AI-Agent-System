import type { Usage } from "./cost";

/**
 * A minimal Messages API client for the scheduled path.
 *
 * The orchestrator's ModelProvider (src/providers/) is the right seam for an
 * agent Run, but it deliberately exposes no token usage and no prompt
 * caching — both of which this pipeline needs, because it must report what
 * each run cost and must cache the stable scoring prefix across batches.
 * Rather than widen that interface for one caller, this is its own small
 * port with its own fake, following the same ports-and-adapters shape
 * (ADR 0001) and the same no-dependencies rule (ADR 0002).
 */

export interface CompletionRequest {
  readonly model: string;
  /** Cached across calls — the rubric and the candidate profile, which never vary within a run. */
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly usage: Usage;
}

export interface ScoringClient {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

interface AnthropicResponse {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly stop_reason?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
}

export class AnthropicScoringClient implements ScoringClient {
  constructor(private readonly apiKey: string) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        // The stable prefix is cached, so the rubric and profile are paid for
        // once per run rather than once per batch.
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: request.user }],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Anthropic API ${response.status}: ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as AnthropicResponse;

    // A truncated response is a failed response. Treating a half-written JSON
    // array as a usable answer is how a pipeline silently loses postings.
    if (body.stop_reason === "max_tokens") {
      throw new Error("scoring response hit max_tokens — batch size is too large for the output budget");
    }

    const text = (body.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    return {
      text,
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
        cacheReadTokens: body.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: body.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/** Scripted stand-in so the whole pipeline runs, and is tested, with no API key and no spend. */
export class FakeScoringClient implements ScoringClient {
  public readonly requests: CompletionRequest[] = [];

  constructor(private readonly responses: readonly string[]) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const text = this.responses[this.requests.length - 1] ?? "[]";
    return { text, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}

/** The real client when a key is configured, otherwise nothing — never a half-configured client. */
export function createScoringClientFromEnv(): ScoringClient | undefined {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  return apiKey ? new AnthropicScoringClient(apiKey) : undefined;
}
