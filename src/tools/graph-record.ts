import type { Tool } from "./tool";
import type { GraphStore } from "../store/graph-store";

interface RecordInput {
  readonly label: string;
  readonly type?: string;
  readonly source: string;
  readonly confidence?: number;
}

function parseInput(input: unknown): RecordInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("graph-record requires an object input");
  }
  const record = input as Record<string, unknown>;
  if (typeof record["label"] !== "string" || typeof record["source"] !== "string") {
    throw new Error('graph-record requires string "label" and "source" fields');
  }
  return {
    label: record["label"] as string,
    type: typeof record["type"] === "string" ? (record["type"] as string) : "company",
    source: record["source"] as string,
    confidence: typeof record["confidence"] === "number" ? (record["confidence"] as number) : 0.7,
  };
}

/**
 * Lets an Agent log an entity it just found (e.g. a company from a job
 * listing) into the shared GraphStore, so a future run can recall it
 * instead of re-researching it — deduped by canonical label + type, with
 * sources unioned and confidence taking the higher value (see
 * store/graph-store.ts). Read-only from the caller's perspective in the
 * sense that it never touches anything outside this project's own memory —
 * no approval needed, same as inkbox-save-draft.
 */
export function createGraphRecordTool(graphStore: GraphStore): Tool {
  return {
    name: "graph-record",
    description:
      "Records (or updates) an entity you just found — e.g. a company from a job listing — in shared research memory, so a future run recognizes it " +
      "instead of re-researching it from scratch. Input: " +
      '{"label": "Acme Corp", "type": "company", "source": "https://jobs.example.com/123", "confidence": 0.8}. ' +
      '"type" defaults to "company", "confidence" defaults to 0.7.',
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        type: { type: "string" },
        source: { type: "string" },
        confidence: { type: "number" },
      },
      required: ["label", "source"],
    },
    async execute(input: unknown): Promise<string> {
      const parsed = parseInput(input);
      const node = await graphStore.upsertNode({
        label: parsed.label,
        type: parsed.type as string,
        sources: [parsed.source],
        confidence: parsed.confidence as number,
      });
      return `Recorded "${node.label}" (type: ${node.type}); ${node.sources.length} source(s) on file, confidence ${node.confidence}.`;
    },
  };
}
