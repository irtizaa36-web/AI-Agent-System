import type { Tool } from "./tool";
import type { GraphStore } from "../store/graph-store";

interface RecallInput {
  readonly label: string;
  readonly type?: string;
}

function parseInput(input: unknown): RecallInput {
  if (typeof input !== "object" || input === null || typeof (input as Record<string, unknown>)["label"] !== "string") {
    throw new Error('graph-recall requires an object with a string "label" (and optionally "type")');
  }
  const record = input as Record<string, unknown>;
  return { label: record["label"] as string, type: typeof record["type"] === "string" ? (record["type"] as string) : "company" };
}

/**
 * Lets an Agent check, before spending a real research step, whether an
 * entity (a company from a job listing, say) has already been logged in a
 * prior run — the economics the graph-workflow pattern is built around:
 * skip or shortcut work that's already been paid for instead of redoing it.
 * Read-only, no approval needed.
 */
export function createGraphRecallTool(graphStore: GraphStore): Tool {
  return {
    name: "graph-recall",
    description:
      "Checks whether an entity (e.g. a company) has already been researched and logged in a previous run, by name and type (default type: \"company\"). " +
      "Returns its known sources and confidence if found, so you can skip re-describing something already covered, or note it's the same company under a different name. " +
      'Input: {"label": "Acme Corp", "type": "company"}.',
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" }, type: { type: "string" } },
      required: ["label"],
    },
    async execute(input: unknown): Promise<string> {
      const { label, type } = parseInput(input);
      const node = await graphStore.findNode(label, type as string);
      if (!node) return `No prior record of "${label}" (type: ${type}).`;
      return JSON.stringify({
        label: node.label,
        type: node.type,
        sources: node.sources,
        confidence: node.confidence,
        lastUpdated: node.updatedAt,
      });
    },
  };
}
