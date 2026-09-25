import { playerName, type PlayerMap, type SleeperRoster } from "./client";

/**
 * The Sleeper write actions (ADR 0021) and the pure half of the write gate:
 * validate an action, turn it into the exact GraphQL operation that would be
 * sent, and describe it in plain English for a dry-run preview. Nothing in
 * this file does I/O. Sending happens only in graphql-client.ts, and only
 * through `runSleeperWrite` with `confirm: true`.
 *
 * Sleeper has no documented write API. The operation names, argument shapes
 * and selected fields below come from joscaz/sleeper-mcp (MIT, (c) 2026 Jose
 * Zertuche, src/sleeper/graphql.ts), which read them from the live schema of
 * https://sleeper.com/graphql by introspection. This project has not sent any
 * of them to Sleeper. They can change without notice.
 */

export const WRITE_KINDS = [
  "set_lineup",
  "update_ir",
  "update_taxi",
  "add_drop_player",
  "submit_waiver_claim",
  "cancel_waiver_claim",
  "propose_trade",
  "respond_to_trade",
] as const;
export type WriteKind = (typeof WRITE_KINDS)[number];

export type SleeperWriteAction =
  /** Replaces the full starters array, in league slot order; "0" leaves a slot empty. */
  | { readonly kind: "set_lineup"; readonly leagueId: string; readonly rosterId: number; readonly starters: readonly string[] }
  /** Replaces the full IR list. */
  | { readonly kind: "update_ir"; readonly leagueId: string; readonly rosterId: number; readonly reserve: readonly string[] }
  /** Replaces the full taxi squad. */
  | { readonly kind: "update_taxi"; readonly leagueId: string; readonly rosterId: number; readonly taxi: readonly string[] }
  /** Immediate free-agent add and/or drop (no waiver period). */
  | {
      readonly kind: "add_drop_player";
      readonly leagueId: string;
      readonly rosterId: number;
      readonly addPlayerIds: readonly string[];
      readonly dropPlayerIds: readonly string[];
    }
  /** A waiver claim, processed at the league's waiver run. `bid` is whole FAAB dollars. */
  | {
      readonly kind: "submit_waiver_claim";
      readonly leagueId: string;
      readonly rosterId: number;
      readonly addPlayerId: string;
      readonly dropPlayerId?: string;
      readonly bid?: number;
    }
  | { readonly kind: "cancel_waiver_claim"; readonly leagueId: string; readonly transactionId: string; readonly leg: number }
  | {
      readonly kind: "propose_trade";
      readonly leagueId: string;
      readonly rosterId: number;
      readonly partnerRosterId: number;
      readonly sendPlayerIds: readonly string[];
      readonly receivePlayerIds: readonly string[];
    }
  | {
      readonly kind: "respond_to_trade";
      readonly leagueId: string;
      readonly transactionId: string;
      readonly leg: number;
      readonly response: "accept" | "reject";
    };

/** Exactly what would be POSTed to Sleeper's GraphQL endpoint. */
export interface WritePlan {
  readonly operation: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

const ROSTER_FIELDS = "roster_id league_id owner_id players starters reserve taxi settings metadata";
const TRANSACTION_FIELDS =
  "transaction_id type status status_updated created creator leg league_id roster_ids consenter_ids adds drops draft_picks waiver_budget settings metadata";

type ParseResult = { ok: true; action: SleeperWriteAction } | { ok: false; error: string };

function isIdString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$|^[A-Z]{2,3}$/.test(value);
}

function idList(v: Record<string, unknown>, field: string, allowEmpty: boolean): readonly string[] | string {
  const value = v[field];
  if (!Array.isArray(value) || !value.every(isIdString)) return `"${field}" must be an array of Sleeper player ids (digits, or a team code for a defense)`;
  if (!allowEmpty && value.length === 0) return `"${field}" must not be empty`;
  return value as string[];
}

function positiveInt(v: Record<string, unknown>, field: string): number | string {
  const value = v[field];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : `"${field}" must be a positive whole number`;
}

/**
 * Validates an untrusted value (a Model's tool input, or a JSON file from the
 * CLI) into a SleeperWriteAction, or explains exactly what's wrong. Shared by
 * preview and execute so they can never disagree about what's valid.
 */
export function parseSleeperWriteAction(value: unknown): ParseResult {
  if (typeof value !== "object" || value === null) return { ok: false, error: "action must be an object" };
  const v = value as Record<string, unknown>;
  if (!WRITE_KINDS.includes(v["kind"] as WriteKind)) return { ok: false, error: `"kind" must be one of ${WRITE_KINDS.join(", ")}` };
  const kind = v["kind"] as WriteKind;
  const leagueId = v["leagueId"];
  if (typeof leagueId !== "string" || !/^\d+$/.test(leagueId)) return { ok: false, error: '"leagueId" must be a Sleeper league id (digits)' };

  const fail = (error: string): ParseResult => ({ ok: false, error });

  switch (kind) {
    case "set_lineup":
    case "update_ir":
    case "update_taxi": {
      const rosterId = positiveInt(v, "rosterId");
      if (typeof rosterId === "string") return fail(rosterId);
      const field = kind === "set_lineup" ? "starters" : kind === "update_ir" ? "reserve" : "taxi";
      const raw = v[field];
      // Starters may carry "0" for an empty slot.
      const ids = Array.isArray(raw) && raw.every((id) => id === "0" || isIdString(id)) ? (raw as string[]) : `"${field}" must be an array of Sleeper player ids`;
      if (typeof ids === "string") return fail(ids);
      if (kind === "set_lineup") {
        if (ids.length === 0) return fail('"starters" must not be empty');
        return { ok: true, action: { kind, leagueId, rosterId, starters: ids } };
      }
      return { ok: true, action: kind === "update_ir" ? { kind, leagueId, rosterId, reserve: ids } : { kind, leagueId, rosterId, taxi: ids } };
    }
    case "add_drop_player": {
      const rosterId = positiveInt(v, "rosterId");
      if (typeof rosterId === "string") return fail(rosterId);
      const addPlayerIds = idList(v, "addPlayerIds", true);
      if (typeof addPlayerIds === "string") return fail(addPlayerIds);
      const dropPlayerIds = idList(v, "dropPlayerIds", true);
      if (typeof dropPlayerIds === "string") return fail(dropPlayerIds);
      if (addPlayerIds.length === 0 && dropPlayerIds.length === 0) return fail("add_drop_player needs at least one add or one drop");
      return { ok: true, action: { kind, leagueId, rosterId, addPlayerIds, dropPlayerIds } };
    }
    case "submit_waiver_claim": {
      const rosterId = positiveInt(v, "rosterId");
      if (typeof rosterId === "string") return fail(rosterId);
      if (!isIdString(v["addPlayerId"])) return fail('"addPlayerId" must be a Sleeper player id');
      const dropPlayerId = v["dropPlayerId"];
      if (dropPlayerId !== undefined && !isIdString(dropPlayerId)) return fail('"dropPlayerId" must be a Sleeper player id when given');
      const bid = v["bid"];
      if (bid !== undefined && !(typeof bid === "number" && Number.isInteger(bid) && bid >= 0)) return fail('"bid" must be a whole number of FAAB dollars, 0 or more');
      return {
        ok: true,
        action: {
          kind,
          leagueId,
          rosterId,
          addPlayerId: v["addPlayerId"] as string,
          ...(dropPlayerId !== undefined ? { dropPlayerId: dropPlayerId as string } : {}),
          ...(bid !== undefined ? { bid: bid as number } : {}),
        },
      };
    }
    case "cancel_waiver_claim":
    case "respond_to_trade": {
      const transactionId = v["transactionId"];
      if (typeof transactionId !== "string" || !/^\d+$/.test(transactionId)) return fail('"transactionId" must be a Sleeper transaction id (digits)');
      const leg = positiveInt(v, "leg");
      if (typeof leg === "string") return fail(leg);
      if (kind === "cancel_waiver_claim") return { ok: true, action: { kind, leagueId, transactionId, leg } };
      const response = v["response"];
      if (response !== "accept" && response !== "reject") return fail('"response" must be "accept" or "reject"');
      return { ok: true, action: { kind, leagueId, transactionId, leg, response } };
    }
    case "propose_trade": {
      const rosterId = positiveInt(v, "rosterId");
      if (typeof rosterId === "string") return fail(rosterId);
      const partnerRosterId = positiveInt(v, "partnerRosterId");
      if (typeof partnerRosterId === "string") return fail(partnerRosterId);
      if (partnerRosterId === rosterId) return fail('"partnerRosterId" must be a different roster from "rosterId"');
      const sendPlayerIds = idList(v, "sendPlayerIds", true);
      if (typeof sendPlayerIds === "string") return fail(sendPlayerIds);
      const receivePlayerIds = idList(v, "receivePlayerIds", true);
      if (typeof receivePlayerIds === "string") return fail(receivePlayerIds);
      if (sendPlayerIds.length === 0 && receivePlayerIds.length === 0) return fail("propose_trade needs at least one player to send or receive");
      return { ok: true, action: { kind, leagueId, rosterId, partnerRosterId, sendPlayerIds, receivePlayerIds } };
    }
  }
}

function split(map: ReadonlyArray<readonly [string, number]>): { k: string[] | null; v: number[] | null } {
  return map.length === 0 ? { k: null, v: null } : { k: map.map(([id]) => id), v: map.map(([, roster]) => roster) };
}

/** The exact GraphQL operation an action becomes. Pure. */
export function buildWritePlan(action: SleeperWriteAction): WritePlan {
  switch (action.kind) {
    case "set_lineup":
      return {
        operation: "roster_update_starters",
        query: `mutation roster_update_starters($league_id: Snowflake!, $roster_id: Int!, $starters: [String]) { roster_update_starters(league_id: $league_id, roster_id: $roster_id, starters: $starters) { ${ROSTER_FIELDS} } }`,
        variables: { league_id: action.leagueId, roster_id: action.rosterId, starters: [...action.starters] },
      };
    case "update_ir":
      return {
        operation: "roster_update_reserve",
        query: `mutation roster_update_reserve($league_id: Snowflake!, $roster_id: Int!, $reserve: [String]) { roster_update_reserve(league_id: $league_id, roster_id: $roster_id, reserve: $reserve) { ${ROSTER_FIELDS} } }`,
        variables: { league_id: action.leagueId, roster_id: action.rosterId, reserve: [...action.reserve] },
      };
    case "update_taxi":
      return {
        operation: "roster_update_taxi",
        query: `mutation roster_update_taxi($league_id: Snowflake!, $roster_id: Int!, $taxi: [String], $force: Boolean) { roster_update_taxi(league_id: $league_id, roster_id: $roster_id, taxi: $taxi, force: $force) { ${ROSTER_FIELDS} } }`,
        variables: { league_id: action.leagueId, roster_id: action.rosterId, taxi: [...action.taxi], force: false },
      };
    case "add_drop_player": {
      const adds = split(action.addPlayerIds.map((id) => [id, action.rosterId] as const));
      const drops = split(action.dropPlayerIds.map((id) => [id, action.rosterId] as const));
      return {
        operation: "league_create_transaction",
        query: `mutation league_create_transaction($league_id: Snowflake!, $type: String!, $k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int]) { league_create_transaction(league_id: $league_id, type: $type, k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops) { ${TRANSACTION_FIELDS} } }`,
        variables: { league_id: action.leagueId, type: "free_agent", k_adds: adds.k, v_adds: adds.v, k_drops: drops.k, v_drops: drops.v },
      };
    }
    case "submit_waiver_claim": {
      const adds = split([[action.addPlayerId, action.rosterId]]);
      const drops = split(action.dropPlayerId ? [[action.dropPlayerId, action.rosterId]] : []);
      const settings = action.bid !== undefined ? { k: ["waiver_bid"], v: [action.bid] } : { k: null, v: null };
      return {
        operation: "submit_waiver_claim",
        query: `mutation submit_waiver_claim($league_id: Snowflake!, $k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int], $k_settings: [String], $v_settings: [Int]) { submit_waiver_claim(league_id: $league_id, k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops, k_settings: $k_settings, v_settings: $v_settings) { ${TRANSACTION_FIELDS} } }`,
        variables: {
          league_id: action.leagueId,
          k_adds: adds.k,
          v_adds: adds.v,
          k_drops: drops.k,
          v_drops: drops.v,
          k_settings: settings.k,
          v_settings: settings.v,
        },
      };
    }
    case "cancel_waiver_claim":
      return {
        operation: "cancel_waiver_claim",
        query: `mutation cancel_waiver_claim($league_id: Snowflake!, $transaction_id: Snowflake!, $leg: Int!) { cancel_waiver_claim(league_id: $league_id, transaction_id: $transaction_id, leg: $leg) { ${TRANSACTION_FIELDS} } }`,
        variables: { league_id: action.leagueId, transaction_id: action.transactionId, leg: action.leg },
      };
    case "propose_trade": {
      // adds: player -> roster that receives them; drops: player -> roster that gives them up.
      const adds = split([
        ...action.receivePlayerIds.map((id) => [id, action.rosterId] as const),
        ...action.sendPlayerIds.map((id) => [id, action.partnerRosterId] as const),
      ]);
      const drops = split([
        ...action.sendPlayerIds.map((id) => [id, action.rosterId] as const),
        ...action.receivePlayerIds.map((id) => [id, action.partnerRosterId] as const),
      ]);
      return {
        operation: "propose_trade",
        query: `mutation propose_trade($league_id: Snowflake!, $k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int], $draft_picks: [String], $waiver_budget: [String], $reject_transaction_id: Snowflake, $reject_transaction_leg: Int) { propose_trade(league_id: $league_id, k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops, draft_picks: $draft_picks, waiver_budget: $waiver_budget, reject_transaction_id: $reject_transaction_id, reject_transaction_leg: $reject_transaction_leg) { ${TRANSACTION_FIELDS} } }`,
        variables: {
          league_id: action.leagueId,
          k_adds: adds.k,
          v_adds: adds.v,
          k_drops: drops.k,
          v_drops: drops.v,
          draft_picks: null,
          waiver_budget: null,
          reject_transaction_id: null,
          reject_transaction_leg: null,
        },
      };
    }
    case "respond_to_trade": {
      const operation = action.response === "accept" ? "accept_trade" : "reject_trade";
      return {
        operation,
        query: `mutation ${operation}($league_id: Snowflake!, $transaction_id: Snowflake!, $leg: Int!) { ${operation}(league_id: $league_id, transaction_id: $transaction_id, leg: $leg) { ${TRANSACTION_FIELDS} } }`,
        variables: { league_id: action.leagueId, transaction_id: action.transactionId, leg: action.leg },
      };
    }
  }
}

function names(ids: readonly string[], players: PlayerMap | undefined): string {
  if (ids.length === 0) return "(none)";
  return ids.map((id) => (id === "0" ? "(empty slot)" : `${playerName(players?.[id], id)} [${id}]`)).join(", ");
}

/** One plain-English sentence per effect, for the dry-run preview a human reviews. */
export function describeWrite(action: SleeperWriteAction, players?: PlayerMap): readonly string[] {
  switch (action.kind) {
    case "set_lineup":
      return [`Set roster ${action.rosterId}'s starters, in slot order, to: ${names(action.starters, players)}.`];
    case "update_ir":
      return [`Set roster ${action.rosterId}'s IR list to: ${names(action.reserve, players)}.`];
    case "update_taxi":
      return [`Set roster ${action.rosterId}'s taxi squad to: ${names(action.taxi, players)}.`];
    case "add_drop_player":
      return [
        `Immediately add to roster ${action.rosterId}: ${names(action.addPlayerIds, players)}.`,
        `Immediately drop from roster ${action.rosterId}: ${names(action.dropPlayerIds, players)}.`,
      ];
    case "submit_waiver_claim":
      return [
        `Put in a waiver claim for roster ${action.rosterId} on ${names([action.addPlayerId], players)}.`,
        `Drop if it succeeds: ${action.dropPlayerId ? names([action.dropPlayerId], players) : "(nobody)"}.`,
        `FAAB bid: ${action.bid !== undefined ? `$${action.bid}` : "(none — non-FAAB league or $0)"}.`,
      ];
    case "cancel_waiver_claim":
      return [`Cancel pending waiver claim ${action.transactionId} (week ${action.leg}).`];
    case "propose_trade":
      return [
        `Offer roster ${action.partnerRosterId} a trade from roster ${action.rosterId}.`,
        `You send: ${names(action.sendPlayerIds, players)}.`,
        `You receive: ${names(action.receivePlayerIds, players)}.`,
      ];
    case "respond_to_trade":
      return [`${action.response === "accept" ? "Accept" : "Reject"} trade ${action.transactionId} (week ${action.leg}).`];
  }
}

/**
 * Checks an action against the league's live rosters and returns every
 * problem found (empty means it looks consistent). It catches the mistakes a
 * model is most likely to make: a player who isn't on the roster being
 * changed, adding someone already rostered, or a trade that names the wrong
 * side's players. It cannot check league rules (lock times, waiver status,
 * roster limits); Sleeper enforces those when the write is sent.
 */
export function checkAgainstRosters(action: SleeperWriteAction, rosters: readonly SleeperRoster[]): readonly string[] {
  const problems: string[] = [];
  const rosterById = new Map(rosters.map((r) => [r.roster_id, r]));
  const onRoster = (rosterId: number, id: string): boolean => (rosterById.get(rosterId)?.players ?? []).includes(id);
  const rostered = new Set(rosters.flatMap((r) => r.players ?? []));
  const requireRoster = (rosterId: number): boolean => {
    if (rosterById.has(rosterId)) return true;
    problems.push(`roster ${rosterId} does not exist in league ${action.leagueId}`);
    return false;
  };

  switch (action.kind) {
    case "set_lineup":
    case "update_ir":
    case "update_taxi": {
      if (!requireRoster(action.rosterId)) break;
      const ids = action.kind === "set_lineup" ? action.starters : action.kind === "update_ir" ? action.reserve : action.taxi;
      for (const id of ids) if (id !== "0" && !onRoster(action.rosterId, id)) problems.push(`player ${id} is not on roster ${action.rosterId}`);
      const seen = new Set<string>();
      for (const id of ids) {
        if (id !== "0" && seen.has(id)) problems.push(`player ${id} is listed twice`);
        seen.add(id);
      }
      break;
    }
    case "add_drop_player":
      if (!requireRoster(action.rosterId)) break;
      for (const id of action.addPlayerIds) if (rostered.has(id)) problems.push(`player ${id} is already on a roster in this league`);
      for (const id of action.dropPlayerIds) if (!onRoster(action.rosterId, id)) problems.push(`player ${id} is not on roster ${action.rosterId}, so it can't be dropped`);
      break;
    case "submit_waiver_claim":
      if (!requireRoster(action.rosterId)) break;
      if (rostered.has(action.addPlayerId)) problems.push(`player ${action.addPlayerId} is already on a roster in this league`);
      if (action.dropPlayerId && !onRoster(action.rosterId, action.dropPlayerId)) {
        problems.push(`player ${action.dropPlayerId} is not on roster ${action.rosterId}, so it can't be dropped`);
      }
      break;
    case "propose_trade":
      if (!requireRoster(action.rosterId) || !requireRoster(action.partnerRosterId)) break;
      for (const id of action.sendPlayerIds) if (!onRoster(action.rosterId, id)) problems.push(`player ${id} is not on your roster ${action.rosterId}`);
      for (const id of action.receivePlayerIds) {
        if (!onRoster(action.partnerRosterId, id)) problems.push(`player ${id} is not on partner roster ${action.partnerRosterId}`);
      }
      break;
    case "cancel_waiver_claim":
    case "respond_to_trade":
      break;
  }
  return problems;
}
