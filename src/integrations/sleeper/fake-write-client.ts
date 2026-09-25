import type { WritePlan } from "./write-actions";
import type { SleeperWriteClient } from "./write-gate";

/** An in-memory SleeperWriteClient for tests: records every plan it is asked to send, never touches the network. */
export class FakeSleeperWriteClient implements SleeperWriteClient {
  public readonly executed: WritePlan[] = [];

  async execute(plan: WritePlan): Promise<unknown> {
    this.executed.push(plan);
    return { fake: true, operation: plan.operation };
  }
}
