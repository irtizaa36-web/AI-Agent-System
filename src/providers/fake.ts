import type { GenerateRequest, GenerateResult, ModelProvider } from "./provider";

/**
 * A deterministic Provider for tests and offline demos. Returns a scripted
 * queue of responses in order, one per call to generate(). Throws if asked
 * for more responses than were scripted, so tests can assert exact call
 * counts.
 */
export class FakeProvider implements ModelProvider {
  readonly name = "fake";
  private readonly script: GenerateResult[];
  private callCount = 0;

  constructor(script: readonly GenerateResult[]) {
    this.script = [...script];
  }

  get calls(): number {
    return this.callCount;
  }

  async generate(_request: GenerateRequest): Promise<GenerateResult> {
    this.callCount += 1;
    const next = this.script.shift();
    if (!next) {
      throw new Error(
        `FakeProvider received more generate() calls than it was scripted for (${this.callCount} calls made)`,
      );
    }
    return next;
  }
}

/**
 * A trivial single-turn Provider that echoes the last user message back.
 * Always resolves in one step, so it's safe to use without any scripting —
 * handy for the CLI's built-in "demo" agent, which needs to run end-to-end
 * without a real API key.
 */
export function createEchoProvider(): ModelProvider {
  return {
    name: "fake",
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const lastUserMessage = [...request.messages].reverse().find((m) => m.role === "user");
      const content = `Echo: ${lastUserMessage?.content ?? "(no user message)"}`;
      return { content, toolCalls: [], stopReason: "end_turn" };
    },
  };
}
