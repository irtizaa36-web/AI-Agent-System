import type { Tool } from "./tool";
import type { SettlementsDeps } from "../settlements/deps";
import { evaluate, inferCriteria } from "../settlements/eligibility";
import { formatDeadlines, formatEvaluation, formatNudges, formatReview, formatSettlement, formatSweep } from "../settlements/format";
import { runResearchSweep } from "../settlements/research/pipeline";

/**
 * The settlements agent's Tools (ADR 0022). None of them can file, attest or
 * submit a claim, change a status, set a verdict, record a confirmation
 * number or add a settlement to the tracker — those are the owner's
 * decisions, made on the CLI with his evidence. The research sweep's only
 * write is to the research inbox, which he reviews.
 */

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

export function createSettlementsDeadlinesTool(deps: SettlementsDeps): Tool {
  return {
    name: "settlements-deadlines",
    description:
      "Lists the owner's open settlement claims soonest-deadline first with days left, status, eligibility verdict and open to-dos, plus any 14/7/3/1-day nudges due today (previewed, not marked sent). Read-only.",
    inputSchema: { type: "object", properties: {} },
    async execute(): Promise<string> {
      const tracker = await deps.openTracker();
      const today = tracker.todayDate();
      return `${formatDeadlines(tracker.list(), today)}\n\n${formatNudges(tracker.dueNudges(), today)}`;
    },
  };
}

export function createSettlementsReviewTool(deps: SettlementsDeps): Tool {
  return {
    name: "settlements-review",
    description:
      "Full review of the settlement tracker (or one settlement by id): verdicts and their evidence, the profile-based eligibility check, evidence still required, sourced payouts, deadline conflicts and the owner's to-dos. Read-only.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "A tracked settlement id; omit for everything" } } },
    async execute(input: unknown): Promise<string> {
      const tracker = await deps.openTracker();
      const id = record(input)["id"];
      if (typeof id === "string" && id.length > 0) return formatSettlement(tracker.get(id), tracker.todayDate(), deps.profile, true);
      return formatReview(tracker.snapshot(), tracker.todayDate(), deps.profile);
    },
  };
}

export function createSettlementsEvaluateTool(deps: SettlementsDeps): Tool {
  return {
    name: "settlements-evaluate",
    description:
      "Checks a settlement's class definition (quoted from its official site or notice) against the owner's profile and returns eligible / not_eligible / unverified with the evidence he would need. Read-only; records nothing.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The class definition, quoted" }, title: { type: "string" } },
      required: ["text"],
    },
    execute(input: unknown): string {
      const v = record(input);
      if (typeof v["text"] !== "string" || v["text"].trim() === "") throw new Error('settlements-evaluate requires { "text": string }');
      return formatEvaluation(evaluate(inferCriteria(typeof v["title"] === "string" ? v["title"] : "", v["text"]), deps.profile), "");
    },
  };
}

export function createSettlementsResearchTool(deps: SettlementsDeps): Tool {
  return {
    name: "settlements-research-sweep",
    description:
      "Sweeps public settlement lists (Top Class Actions, ClassAction.org) for new class-action settlements. Skips ones already tracked and everything on the owner's permanent do-not-research list, merges duplicates across sources, evaluates eligibility, ranks by priority, and saves new ones to the research inbox for the owner to decide on. Reads public pages only.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } } },
    async execute(input: unknown): Promise<string> {
      const limit = record(input)["limit"];
      const tracker = await deps.openTracker();
      const result = await runResearchSweep({ tracker, fetch: deps.fetch, sources: deps.sources, profile: deps.profile });
      return formatSweep(result, tracker.todayDate(), typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : 10);
    },
  };
}

export function createSettlementsTools(deps: SettlementsDeps): Tool[] {
  return [createSettlementsDeadlinesTool(deps), createSettlementsReviewTool(deps), createSettlementsEvaluateTool(deps), createSettlementsResearchTool(deps)];
}
