import type { Tool } from "./tool";
import type { SleeperReadClient } from "../integrations/sleeper/client";
import { WRITE_KINDS, parseSleeperWriteAction } from "../integrations/sleeper/write-actions";
import { NOT_CONFIGURED, formatPreview, runSleeperWrite, type SleeperWriteClient } from "../integrations/sleeper/write-gate";

/**
 * The Sleeper write Tools (ADR 0021), a safe/consequential pair like the
 * Polymarket ones (ADR 0019):
 *
 * - sleeper-preview-write: the dry run. Always safe; it never holds the write
 *   client at all.
 * - sleeper-execute-write: `requiresApproval` is unconditionally true, so the
 *   Orchestrator always pauses for the owner's exact-match approval. On top of
 *   that the input must carry `"confirm": true` — the Tool form of the CLI's
 *   --confirm flag — or it only previews. It re-checks the action against the
 *   league's live rosters at execution time and refuses on any problem.
 */

export const SLEEPER_WRITE_ACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "One Sleeper write. Fields by kind — set_lineup: rosterId, starters[] (slot order, \"0\" = empty); update_ir: rosterId, reserve[]; update_taxi: rosterId, taxi[]; " +
    "add_drop_player: rosterId, addPlayerIds[], dropPlayerIds[]; submit_waiver_claim: rosterId, addPlayerId, dropPlayerId?, bid?; " +
    "cancel_waiver_claim: transactionId, leg; propose_trade: rosterId, partnerRosterId, sendPlayerIds[], receivePlayerIds[]; " +
    "respond_to_trade: transactionId, leg, response (accept|reject). All kinds need leagueId.",
  properties: { kind: { type: "string", enum: [...WRITE_KINDS] }, leagueId: { type: "string" } },
  required: ["kind", "leagueId"],
};

async function leagueContext(readClient: SleeperReadClient, leagueId: string) {
  const [rosters, players] = await Promise.all([readClient.getRosters(leagueId), readClient.getPlayers()]);
  return { rosters, players };
}

export function createSleeperPreviewWriteTool(readClient: SleeperReadClient): Tool {
  return {
    name: "sleeper-preview-write",
    description:
      "Dry run of a Sleeper write (lineup, IR, taxi, add/drop, waiver claim, trade): validates it, checks it against the league's live rosters, and shows the exact change and GraphQL operation. Safe — never writes.",
    inputSchema: { type: "object", properties: { action: SLEEPER_WRITE_ACTION_SCHEMA }, required: ["action"] },
    async execute(input: unknown): Promise<string> {
      const parsed = parseSleeperWriteAction((input as Record<string, unknown> | null)?.["action"]);
      if (!parsed.ok) throw new Error(`sleeper-preview-write: ${parsed.error}`);
      const outcome = await runSleeperWrite(parsed.action, { confirm: false, ...(await leagueContext(readClient, parsed.action.leagueId)) });
      return formatPreview(outcome.preview);
    },
  };
}

export function createSleeperExecuteWriteTool(readClient: SleeperReadClient, writeClient: SleeperWriteClient | undefined): Tool {
  return {
    name: "sleeper-execute-write",
    description:
      "Sends a Sleeper write to the owner's league through Sleeper's unofficial GraphQL API. Consequential: only runs after the owner's exact-match approval, and only with \"confirm\": true. Call sleeper-preview-write with the same action first.",
    inputSchema: {
      type: "object",
      properties: { action: SLEEPER_WRITE_ACTION_SCHEMA, confirm: { type: "boolean", enum: [true] } },
      required: ["action", "confirm"],
    },
    requiresApproval: true,
    async execute(input: unknown): Promise<string> {
      const v = (input ?? {}) as Record<string, unknown>;
      const parsed = parseSleeperWriteAction(v["action"]);
      if (!parsed.ok) throw new Error(`sleeper-execute-write: ${parsed.error}`);
      if (v["confirm"] !== true) {
        const outcome = await runSleeperWrite(parsed.action, { confirm: false, ...(await leagueContext(readClient, parsed.action.leagueId)) });
        return `${formatPreview(outcome.preview)}\nnote:not sent — "confirm": true is required to write`;
      }
      if (!writeClient) throw new Error(NOT_CONFIGURED);
      const outcome = await runSleeperWrite(parsed.action, { confirm: true, client: writeClient, ...(await leagueContext(readClient, parsed.action.leagueId)) });
      return [
        "written:true",
        `kind:${parsed.action.kind}`,
        `leagueId:${parsed.action.leagueId}`,
        ...outcome.preview.effects.map((line) => `effect:${line}`),
        `sleeperResponse:${JSON.stringify(outcome.dryRun ? null : outcome.result)}`,
      ].join("\n");
    },
  };
}
