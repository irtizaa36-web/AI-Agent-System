import type { Message } from "../core/session";
import type { ToolSpec } from "../tools/tool";
import type { GenerateRequest, GenerateResult, ModelProvider } from "./provider";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// A structured, multi-section response (e.g. career-advisor's fixed 7-section
// format) routinely needs several thousand tokens — 1024 was cutting real
// responses off mid-section, silently reported as "succeeded" until the
// advance() fix below started treating a max_tokens stop as a failure.
const DEFAULT_MAX_TOKENS = 8192;

interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}

interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

interface AnthropicToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AnthropicContentBlock[];
}

export interface AnthropicRequestBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly system?: string;
  readonly messages: readonly AnthropicMessage[];
  readonly tools?: readonly { name: string; description: string; input_schema: Record<string, unknown> }[];
}

/** Pure translation of our generic messages into Anthropic's wire format. Testable without a network call. */
export function buildRequestBody(request: GenerateRequest, maxTokens = DEFAULT_MAX_TOKENS): AnthropicRequestBody {
  const system = request.messages.find((m) => m.role === "system")?.content;
  const messages = request.messages.filter((m) => m.role !== "system").map(toAnthropicMessage);

  return {
    model: request.model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
    ...(request.tools.length > 0 ? { tools: request.tools.map(toAnthropicTool) } : {}),
  };
}

function toAnthropicMessage(message: Message): AnthropicMessage {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.toolCallId ?? "", content: message.content }],
    };
  }

  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    const blocks: AnthropicContentBlock[] = [];
    if (message.content) blocks.push({ type: "text", text: message.content });
    for (const call of message.toolCalls) {
      blocks.push({ type: "tool_use", id: call.id, name: call.toolName, input: call.input });
    }
    return { role: "assistant", content: blocks };
  }

  return { role: message.role === "assistant" ? "assistant" : "user", content: message.content };
}

function toAnthropicTool(tool: ToolSpec) {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

interface AnthropicResponseBody {
  readonly content: readonly AnthropicContentBlock[];
  readonly stop_reason: string;
}

/** Pure translation of Anthropic's response back into our generic result shape. */
export function parseResponseBody(body: AnthropicResponseBody): GenerateResult {
  const textBlocks = body.content.filter((b): b is AnthropicTextBlock => b.type === "text");
  const toolUseBlocks = body.content.filter((b): b is AnthropicToolUseBlock => b.type === "tool_use");

  return {
    content: textBlocks.map((b) => b.text).join(""),
    toolCalls: toolUseBlocks.map((b) => ({ id: b.id, toolName: b.name, input: b.input })),
    stopReason: body.stop_reason === "tool_use" ? "tool_use" : body.stop_reason === "max_tokens" ? "max_tokens" : "end_turn",
  };
}

export interface AnthropicProviderOptions {
  readonly apiKey?: string;
  readonly maxTokens?: number;
}

/**
 * The default Model Provider: Anthropic's Claude models, via the Messages
 * API. Reads ANTHROPIC_API_KEY lazily, at call time, so constructing this
 * provider (and building a Registry that includes it) never requires a key
 * — only actually running an Agent through it does.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions = {}): ModelProvider {
  return {
    name: "claude",
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) {
        throw new Error(
          'ANTHROPIC_API_KEY is not set. Set it to use the "claude" provider, or run with an agent ' +
            'configured to use the fake provider instead (e.g. "--agent demo").',
        );
      }

      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(buildRequestBody(request, options.maxTokens)),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Anthropic API request failed (${response.status}): ${body}`);
      }

      const json = (await response.json()) as AnthropicResponseBody;
      return parseResponseBody(json);
    },
  };
}
