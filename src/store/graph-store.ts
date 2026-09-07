import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isNotFoundError } from "./run-store";

/** A researched entity: a company, person, filing, etc. One primary `type` per graph, per the graph-workflow pattern's SCHEMA.md convention. */
export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly sources: readonly string[];
  readonly confidence: number;
  readonly updatedAt: string;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly evidence: string;
  readonly confidence: number;
}

/**
 * Canonicalizes labels before every lookup or merge, so "Block Inc" and
 * "Square" resolve to one node instead of splitting into two — the
 * graph-workflow pattern's aliases.csv, in code. Matching is
 * case/whitespace-insensitive on top of the alias table itself.
 */
export class AliasResolver {
  private readonly aliases: ReadonlyMap<string, string>;

  constructor(aliases: ReadonlyMap<string, string> = new Map()) {
    this.aliases = new Map([...aliases.entries()].map(([alias, canonical]) => [normalize(alias), canonical]));
  }

  canonicalize(label: string): string {
    return this.aliases.get(normalize(label)) ?? label;
  }
}

function normalize(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Remembers what's already been researched, deduped by alias+type, so a
 * repeat run can skip (or only delta-check) work it already paid for
 * instead of re-researching from scratch — the economics the
 * graph-workflow pattern calls out explicitly in its routing table.
 */
export interface GraphStore {
  /** Inserts a new node, or merges into an existing one with the same canonical label + type: sources are unioned and confidence takes the higher value. Never creates a duplicate for an already-known entity. */
  upsertNode(input: { label: string; type: string; sources: readonly string[]; confidence: number }): Promise<GraphNode>;
  addEdge(edge: GraphEdge): Promise<void>;
  findNode(label: string, type: string): Promise<GraphNode | undefined>;
  listNodes(): Promise<readonly GraphNode[]>;
  listEdges(): Promise<readonly GraphEdge[]>;
}

class BaseGraphStore {
  protected readonly resolver: AliasResolver;
  protected nodes: GraphNode[] = [];
  protected edges: GraphEdge[] = [];

  constructor(aliases?: ReadonlyMap<string, string>) {
    this.resolver = new AliasResolver(aliases);
  }

  protected keyFor(label: string, type: string): string {
    return `${type}::${normalize(this.resolver.canonicalize(label))}`;
  }

  /** Merges `input` into `existing` (union sources, keep the higher confidence), or starts a fresh node if there's nothing to merge into. Caller is responsible for setting `type` on the result. */
  protected mergeNode(
    existing: GraphNode | undefined,
    label: string,
    input: { sources: readonly string[]; confidence: number },
  ): Omit<GraphNode, "type"> {
    const canonicalLabel = this.resolver.canonicalize(label);
    if (!existing) {
      return {
        id: randomUUID(),
        label: canonicalLabel,
        sources: [...new Set(input.sources)],
        confidence: input.confidence,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      ...existing,
      label: canonicalLabel,
      sources: [...new Set([...existing.sources, ...input.sources])],
      confidence: Math.max(existing.confidence, input.confidence),
      updatedAt: new Date().toISOString(),
    };
  }
}

/** In-memory adapter — no I/O, useful for tests and short-lived CLI invocations. */
export class InMemoryGraphStore extends BaseGraphStore implements GraphStore {
  async upsertNode(input: { label: string; type: string; sources: readonly string[]; confidence: number }): Promise<GraphNode> {
    const key = this.keyFor(input.label, input.type);
    const existing = this.nodes.find((n) => this.keyFor(n.label, n.type) === key);
    const merged = { ...this.mergeNode(existing, input.label, input), type: input.type };

    this.nodes = existing ? this.nodes.map((n) => (n.id === existing.id ? merged : n)) : [...this.nodes, merged];
    return merged;
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    this.edges = [...this.edges, edge];
  }

  async findNode(label: string, type: string): Promise<GraphNode | undefined> {
    const key = this.keyFor(label, type);
    return this.nodes.find((n) => this.keyFor(n.label, n.type) === key);
  }

  async listNodes(): Promise<readonly GraphNode[]> {
    return this.nodes;
  }

  async listEdges(): Promise<readonly GraphEdge[]> {
    return this.edges;
  }
}

interface GraphFileShape {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

/** Persists nodes and edges as one JSON file, written atomically (temp file + rename), same convention as JsonFileRunStore. */
export class JsonFileGraphStore extends BaseGraphStore implements GraphStore {
  constructor(private readonly path: string, aliases?: ReadonlyMap<string, string>) {
    super(aliases);
  }

  private async read(): Promise<GraphFileShape> {
    try {
      const raw = await readFile(this.path, "utf-8");
      return JSON.parse(raw) as GraphFileShape;
    } catch (error) {
      if (isNotFoundError(error)) return { nodes: [], edges: [] };
      throw error;
    }
  }

  private async write(data: GraphFileShape): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), "utf-8");
    await rename(temporary, this.path);
  }

  async upsertNode(input: { label: string; type: string; sources: readonly string[]; confidence: number }): Promise<GraphNode> {
    const data = await this.read();
    const key = this.keyFor(input.label, input.type);
    const existing = data.nodes.find((n) => this.keyFor(n.label, n.type) === key);
    const merged = { ...this.mergeNode(existing, input.label, input), type: input.type };

    const nodes = existing ? data.nodes.map((n) => (n.id === existing.id ? merged : n)) : [...data.nodes, merged];
    await this.write({ ...data, nodes });
    return merged;
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    const data = await this.read();
    await this.write({ ...data, edges: [...data.edges, edge] });
  }

  async findNode(label: string, type: string): Promise<GraphNode | undefined> {
    const data = await this.read();
    const key = this.keyFor(label, type);
    return data.nodes.find((n) => this.keyFor(n.label, n.type) === key);
  }

  async listNodes(): Promise<readonly GraphNode[]> {
    return (await this.read()).nodes;
  }

  async listEdges(): Promise<readonly GraphEdge[]> {
    return (await this.read()).edges;
  }
}
