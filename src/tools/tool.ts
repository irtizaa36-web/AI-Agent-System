/**
 * The description of a Tool that gets sent to a Model so it knows the
 * capability exists and how to call it. Pure data — no execution.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * A capability an Agent can invoke during a Run. Distinct from a Provider:
 * a Provider talks to a Model, a Tool lets a Model act on the world.
 * Implementations live here (in tools/), not in core/, because executing a
 * tool is inherently I/O (reading a file, calling an API, ...).
 */
export interface Tool extends ToolSpec {
  execute(input: unknown): Promise<string> | string;
}
