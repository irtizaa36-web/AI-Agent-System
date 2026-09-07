import type { Tool } from "./tool";
import type { ModelProvider } from "../providers/provider";

/**
 * Anthropic's cheapest current model. Used only for condensing oversized
 * tool output — never for anything the user or an approval gate treats as
 * a real answer.
 */
export const DEFAULT_CHEAP_MODEL = "claude-3-5-haiku-20241022";

/**
 * Hard cutoff, checked in code. Spotify's own writeup on this pattern is
 * explicit about why: "written rules are a suggestion, a block is not" —
 * an instruction telling the expensive model to summarize large output
 * itself is routinely ignored, so the decision has to happen before the
 * expensive model ever sees the raw content, not after.
 */
export const DEFAULT_MAX_CHARS = 6000;

const SUMMARY_SYSTEM_PROMPT =
  "You are condensing a tool result for another AI agent, not for a human reader. " +
  "Preserve every concrete fact, number, name, date, decision-relevant detail, and error message. " +
  "Cut narrative filler, repeated boilerplate, and anything not load-bearing. " +
  "Return only the condensed result, with no preamble or commentary.";

export interface SummarizationOptions {
  /** The cheap model's Provider. Reuses whichever Provider the caller already has (e.g. the same Anthropic provider, called with a cheaper model id per-request). */
  readonly provider: ModelProvider;
  /** Results at or below this many characters pass through untouched. */
  readonly maxChars?: number;
  readonly cheapModel?: string;
}

/**
 * Wraps a read-only Tool so oversized results are condensed by a cheap
 * model before the expensive agent's turn ever includes them — Spotify's
 * "two cheap assistants" pattern (one opens files and hands back a short
 * summary; the expensive model never sees the raw content).
 *
 * Only wrap Tools whose result is read-only, informational content (file
 * contents, page text). Never wrap a Tool whose return value the calling
 * Agent or an approval gate depends on being exact.
 */
export function withSummarization(tool: Tool, options: SummarizationOptions): Tool {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const cheapModel = options.cheapModel ?? DEFAULT_CHEAP_MODEL;

  return {
    ...tool,
    async execute(input: unknown): Promise<string> {
      const raw = String(await tool.execute(input));
      if (raw.length <= maxChars) {
        return raw;
      }

      const result = await options.provider.generate({
        model: cheapModel,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: raw },
        ],
        tools: [],
      });

      const originalLines = raw.split("\n").length;
      return (
        `[Condensed by ${cheapModel} — original was ${raw.length} chars / ${originalLines} lines, ` +
        `over the ${maxChars}-char threshold]\n${result.content.trim()}`
      );
    },
  };
}
