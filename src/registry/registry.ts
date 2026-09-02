import type { AgentDefinition } from "../core/agent";
import type { ModelProvider } from "../providers/provider";
import type { Tool } from "../tools/tool";

function lookup<T>(map: ReadonlyMap<string, T>, name: string, kind: string): T {
  const value = map.get(name);
  if (!value) {
    const available = [...map.keys()].join(", ") || "(none registered)";
    throw new Error(`Unknown ${kind} "${name}". Available: ${available}`);
  }
  return value;
}

/**
 * Where Agents, Providers, and Tools are registered by name so the
 * Orchestrator (via the CLI or, later, an API) can look them up when
 * building a Run.
 */
export class Registry {
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly providers = new Map<string, ModelProvider>();
  private readonly tools = new Map<string, Tool>();
  private readonly packs = new Set<string>();

  registerAgent(agent: AgentDefinition): void {
    this.agents.set(agent.name, agent);
  }

  getAgent(name: string): AgentDefinition {
    return lookup(this.agents, name, "agent");
  }

  listAgents(): readonly AgentDefinition[] {
    return [...this.agents.values()];
  }

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): ModelProvider {
    return lookup(this.providers, name, "provider");
  }

  listProviders(): readonly ModelProvider[] {
    return [...this.providers.values()];
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): Tool {
    return lookup(this.tools, name, "tool");
  }

  listTools(): readonly Tool[] {
    return [...this.tools.values()];
  }

  /** Records that a Pack has loaded, purely for reporting (e.g. the CLI's `status` command). */
  registerPack(name: string): void {
    this.packs.add(name);
  }

  listPacks(): readonly string[] {
    return [...this.packs];
  }

  /** Builds the Tool lookup map an Agent's Run needs, from its declared tool names. */
  toolMapFor(names: readonly string[]): ReadonlyMap<string, Tool> {
    return new Map(names.map((name) => [name, this.getTool(name)]));
  }
}
