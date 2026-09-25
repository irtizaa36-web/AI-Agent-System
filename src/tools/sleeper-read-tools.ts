import type { Tool } from "./tool";
import type { SleeperReadClient } from "../integrations/sleeper/client";
import { formatMatchupPreview, formatWaiverReport, matchupPreview, resolveAccount, waiverRecommendations } from "../sleeper/monitoring";

/**
 * Read-only Sleeper Tools (ADR 0021). None needs credentials and none can
 * write: they only hold a SleeperReadClient. The owner's username is given at
 * runtime; each Tool resolves it to a user id itself rather than trusting an
 * id from the model.
 */

function requireString(input: unknown, field: string, toolName: string): string {
  const value = (input as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${toolName} requires "${field}" (string)`);
  return value.trim();
}

function optionalWeek(input: unknown, toolName: string): number | undefined {
  const week = (input as Record<string, unknown> | null)?.["week"];
  if (week === undefined) return undefined;
  if (typeof week !== "number" || !Number.isInteger(week) || week < 1 || week > 18) throw new Error(`${toolName}: "week" must be a whole number from 1 to 18`);
  return week;
}

export function createSleeperFindLeaguesTool(client: SleeperReadClient): Tool {
  return {
    name: "sleeper-find-leagues",
    description:
      "Resolves a Sleeper username to the user id and lists that user's NFL leagues for the season (league id, name, size, status), plus the current NFL week. Read-only.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string" }, season: { type: "string", description: "e.g. \"2026\"; defaults to the current season" } },
      required: ["username"],
    },
    async execute(input: unknown): Promise<string> {
      const username = requireString(input, "username", "sleeper-find-leagues");
      const season = (input as Record<string, unknown>)["season"];
      const account = await resolveAccount(client, username, typeof season === "string" ? season : undefined);
      return [
        `username:${account.user.username}`,
        `userId:${account.user.user_id}`,
        `season:${account.season}`,
        `currentWeek:${account.week}`,
        `leagues:${account.leagues.length}`,
        ...account.leagues.map((l) => `  leagueId:${l.league_id} | ${l.name} | ${l.total_rosters} teams | ${l.status}`),
      ].join("\n");
    },
  };
}

export function createSleeperMatchupPreviewTool(client: SleeperReadClient): Tool {
  return {
    name: "sleeper-matchup-preview",
    description:
      "Weekly matchup preview for the owner's team in one league: both lineups with Sleeper projections, injury and bye flags, empty slots, and suggested bench swaps (suggested only, never made). Read-only.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string" }, leagueId: { type: "string" }, week: { type: "integer", minimum: 1, maximum: 18 } },
      required: ["username", "leagueId"],
    },
    async execute(input: unknown): Promise<string> {
      const username = requireString(input, "username", "sleeper-matchup-preview");
      const leagueId = requireString(input, "leagueId", "sleeper-matchup-preview");
      const week = optionalWeek(input, "sleeper-matchup-preview");
      const user = await client.getUser(username);
      const preview = await matchupPreview(client, { leagueId, userId: user.user_id, ...(week !== undefined ? { week } : {}) });
      return formatMatchupPreview(preview);
    },
  };
}

export function createSleeperWaiverRecommendationsTool(client: SleeperReadClient): Tool {
  return {
    name: "sleeper-waiver-recommendations",
    description:
      "Ranks free agents worth claiming in one league (Sleeper-wide trending adds that are unrostered here, at startable positions, not ruled out), with projections, a heuristic FAAB bid, a drop candidate, and last week's winning bids. Read-only; claims nothing.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        leagueId: { type: "string" },
        week: { type: "integer", minimum: 1, maximum: 18 },
        limit: { type: "integer", minimum: 1, maximum: 15 },
      },
      required: ["username", "leagueId"],
    },
    async execute(input: unknown): Promise<string> {
      const username = requireString(input, "username", "sleeper-waiver-recommendations");
      const leagueId = requireString(input, "leagueId", "sleeper-waiver-recommendations");
      const week = optionalWeek(input, "sleeper-waiver-recommendations");
      const limit = (input as Record<string, unknown>)["limit"];
      const user = await client.getUser(username);
      const report = await waiverRecommendations(client, {
        leagueId,
        userId: user.user_id,
        ...(week !== undefined ? { week } : {}),
        ...(typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 15) } : {}),
      });
      return formatWaiverReport(report);
    },
  };
}
