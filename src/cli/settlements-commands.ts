import { parseArgs, type ParseArgsConfig } from "node:util";
import type { CliDeps } from "./index";
import { isIsoDate } from "../settlements/dates";
import { evaluate, inferCriteria } from "../settlements/eligibility";
import { formatDeadlines, formatEvaluation, formatInbox, formatNudges, formatReview, formatSettlement, formatSweep, OWNER_FILES_REMINDER } from "../settlements/format";
import { domainOf } from "../settlements/matching";
import { runResearchSweep } from "../settlements/research/pipeline";
import { TrackerError } from "../settlements/tracker";
import { ACTION_KINDS, SETTLEMENT_STATUSES, VERDICTS, type ActionKind, type SettlementStatus, type SourceRef, type Verdict } from "../settlements/types";
import type { SettlementsDeps } from "../settlements/deps";

/**
 * `orchestrator settlements ...` (ADR 0022). Reads, reminders and research
 * are safe. The commands that change the tracker record what the owner tells
 * them, with his evidence. There is no command that files, attests or submits
 * a claim, and there never will be: `status <id> filed` records a claim he
 * already filed himself.
 *
 * Each command declares its own usage line once; the help text and every
 * usage error come from that one declaration.
 */

class UsageError extends Error {}

interface Command {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  run(args: readonly string[], s: SettlementsDeps, deps: CliDeps): Promise<void>;
}

function parse<T extends ParseArgsConfig["options"]>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function sourceRef(value: string, retrievedOn: string): SourceRef {
  const domain = /^https?:\/\//i.test(value) ? domainOf(value) : undefined;
  return domain ? { label: domain, url: value, retrievedOn } : { label: value, retrievedOn };
}

function requireDate(value: string | undefined, flag: string): string {
  if (!value || !isIsoDate(value)) throw new UsageError(`${flag} must be a date like 2026-10-20`);
  return value;
}

const COMMANDS: readonly Command[] = [
  {
    name: "deadlines",
    usage: "settlements deadlines [--all]",
    summary: "Days left for every open claim, soonest first (--all includes filed/dropped)",
    async run(args, s, deps) {
      const { values } = parse(args, { all: { type: "boolean", default: false } });
      const tracker = await s.openTracker();
      deps.stdout(formatDeadlines(tracker.list(), tracker.todayDate(), { includeClosed: values.all === true }));
    },
  },
  {
    name: "alerts",
    usage: "settlements alerts [--dry-run]",
    summary: "Nudges due at 14/7/3/1 days left; each fires once (--dry-run doesn't mark them sent)",
    async run(args, s, deps) {
      const { values } = parse(args, { "dry-run": { type: "boolean", default: false } });
      const tracker = await s.openTracker();
      const nudges = tracker.dueNudges();
      deps.stdout(formatNudges(nudges, tracker.todayDate()));
      if (nudges.length > 0 && !values["dry-run"]) await tracker.markNudged(nudges);
    },
  },
  {
    name: "review",
    usage: "settlements review [<id>]",
    summary: "Everything tracked: verdicts, evidence you'd need, your to-dos (or one claim in detail)",
    async run(args, s, deps) {
      const { positionals } = parse(args, {});
      const tracker = await s.openTracker();
      if (positionals[0]) deps.stdout(formatSettlement(tracker.get(positionals[0]), tracker.todayDate(), s.profile, true));
      else deps.stdout(formatReview(tracker.snapshot(), tracker.todayDate(), s.profile));
    },
  },
  {
    name: "research",
    usage: "settlements research [--limit N]",
    summary: "Sweep public settlement lists for new ones; skips tracked and do-not-research",
    async run(args, s, deps) {
      const { values } = parse(args, { limit: { type: "string" } });
      const limit = values.limit === undefined ? 15 : Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit must be a positive whole number");
      const tracker = await s.openTracker();
      const result = await runResearchSweep({ tracker, fetch: s.fetch, sources: s.sources, profile: s.profile });
      deps.stdout(formatSweep(result, tracker.todayDate(), limit));
    },
  },
  {
    name: "inbox",
    usage: "settlements inbox",
    summary: "Research candidates waiting for your decision",
    async run(args, s, deps) {
      parse(args, {});
      const tracker = await s.openTracker();
      deps.stdout(formatInbox(tracker.inbox(), tracker.todayDate(), s.profile));
    },
  },
  {
    name: "add",
    usage: 'settlements add <candidate-id> [--deadline YYYY-MM-DD --source <url>]  |  settlements add --name "<name>" --deadline YYYY-MM-DD --source <url|label> [--payout "<as stated>"] [--website <url>] [--class "<class definition>"]',
    summary: "Start tracking a research candidate, or one you found yourself (deadline must be sourced)",
    async run(args, s, deps) {
      const { values, positionals } = parse(args, {
        name: { type: "string" },
        deadline: { type: "string" },
        source: { type: "string" },
        payout: { type: "string" },
        website: { type: "string" },
        class: { type: "string" },
      });
      const tracker = await s.openTracker();
      const today = tracker.todayDate();
      if (values.deadline !== undefined && !values.source) throw new UsageError("--deadline needs --source (where you read it)");
      const deadline = values.deadline !== undefined ? { date: requireDate(values.deadline, "--deadline"), source: sourceRef(values.source!, today) } : undefined;
      let added;
      if (positionals[0]) {
        added = await tracker.promote(positionals[0], deadline ? { deadline } : undefined);
      } else {
        if (!values.name || !deadline) throw new UsageError("--name, --deadline and --source are required when not adding a candidate");
        const domain = values.website ? domainOf(values.website) : undefined;
        added = await tracker.add({
          name: values.name,
          deadline,
          criteria: inferCriteria(values.name, values.class),
          ...(domain ? { domains: [domain] } : {}),
          ...(values.website ? { website: values.website } : {}),
          ...(values.payout ? { payout: { text: values.payout, source: deadline.source } } : {}),
          ...(values.class ? { classDefinition: values.class } : {}),
        });
      }
      deps.stdout(`Now tracking ${added.id}.`);
      deps.stdout(formatSettlement(added, today, s.profile));
    },
  },
  {
    name: "dismiss",
    usage: 'settlements dismiss <candidate-id> --reason "<why>"',
    summary: "Rule a research candidate out for good (adds it to the do-not-research list)",
    async run(args, s, deps) {
      const { values, positionals } = parse(args, { reason: { type: "string" } });
      if (!positionals[0] || !values.reason) throw new UsageError("a candidate id and --reason are required");
      const entry = await (await s.openTracker()).dismiss(positionals[0], values.reason);
      deps.stdout(`${entry.name} is on the do-not-research list: ${entry.reason}`);
    },
  },
  {
    name: "status",
    usage: `settlements status <id> <${SETTLEMENT_STATUSES.join("|")}> --evidence "<what you saw or did>" [--filed-on YYYY-MM-DD] [--confirmation <number>] [--amount N --paid-on YYYY-MM-DD]`,
    summary: "Record a status change you have evidence for (filed = you already filed it yourself)",
    async run(args, s, deps) {
      const { values, positionals } = parse(args, {
        evidence: { type: "string" },
        "filed-on": { type: "string" },
        confirmation: { type: "string" },
        amount: { type: "string" },
        "paid-on": { type: "string" },
      });
      const [id, to] = positionals;
      if (!id || !SETTLEMENT_STATUSES.includes(to as SettlementStatus)) throw new UsageError(`an id and one of ${SETTLEMENT_STATUSES.join(", ")} are required`);
      if (!values.evidence) throw new UsageError("--evidence is required: statuses change only on evidence");
      const updated = await (await s.openTracker()).transition(id, to as SettlementStatus, {
        evidence: values.evidence,
        ...(values["filed-on"] !== undefined ? { filedOn: values["filed-on"] } : {}),
        ...(values.confirmation !== undefined ? { confirmation: values.confirmation } : {}),
        ...(values.amount !== undefined ? { amount: Number(values.amount) } : {}),
        ...(values["paid-on"] !== undefined ? { paidOn: values["paid-on"] } : {}),
      });
      deps.stdout(`${updated.name} is now ${updated.status}.`);
      if (updated.status === "filed" && !updated.confirmation) deps.stdout(`No confirmation number recorded. When you have it: settlements confirmation ${updated.id} <number>`);
      if (updated.status === "dropped") deps.stdout("It is on the do-not-research list and won't come up in research again.");
    },
  },
  {
    name: "verdict",
    usage: `settlements verdict <id> <${VERDICTS.join("|")}> --evidence "<why>"`,
    summary: "Record your eligibility decision and the evidence behind it",
    async run(args, s, deps) {
      const { values, positionals } = parse(args, { evidence: { type: "string" } });
      const [id, verdict] = positionals;
      if (!id || !VERDICTS.includes(verdict as Verdict) || !values.evidence) throw new UsageError("an id, a verdict and --evidence are required");
      const updated = await (await s.openTracker()).setVerdict(id, verdict as Verdict, values.evidence);
      deps.stdout(`${updated.name}: ${updated.eligibility.verdict} — ${updated.eligibility.reason}`);
    },
  },
  {
    name: "confirmation",
    usage: "settlements confirmation <id> <number>",
    summary: "Record the confirmation number the claims administrator gave you",
    async run(args, s, deps) {
      const { positionals } = parse(args, {});
      if (!positionals[0] || !positionals[1]) throw new UsageError("an id and the confirmation number are required");
      const updated = await (await s.openTracker()).recordConfirmation(positionals[0], positionals[1]);
      deps.stdout(`Recorded confirmation ${updated.confirmation} for ${updated.name}.`);
    },
  },
  {
    name: "action",
    usage: `settlements action <id> add --kind <${ACTION_KINDS.join("|")}> "<what you need to do>"  |  settlements action <id> done <action-id> [--note "<text>"]`,
    summary: "Track what only you can do: attestations, verification codes, product counts, notice searches",
    async run(args, s, deps) {
      const { values, positionals } = parse(args, { kind: { type: "string" }, note: { type: "string" } });
      const [id, verb, ...rest] = positionals;
      const tracker = await s.openTracker();
      if (id && verb === "add" && rest.length > 0 && ACTION_KINDS.includes(values.kind as ActionKind)) {
        const action = await tracker.addAction(id, values.kind as ActionKind, rest.join(" "));
        deps.stdout(`Added ${action.id} to ${id}: ${action.description}`);
        return;
      }
      if (id && verb === "done" && rest[0]) {
        const action = await tracker.completeAction(id, rest[0], values.note);
        deps.stdout(`Done: ${action.description}`);
        return;
      }
      throw new UsageError("expected add --kind <kind> \"<text>\" or done <action-id>");
    },
  },
  {
    name: "evaluate",
    usage: 'settlements evaluate --text "<class definition>" [--title "<settlement name>"]',
    summary: "Check a class definition against your profile: eligible / not eligible / unverified",
    async run(args, s, deps) {
      const { values } = parse(args, { text: { type: "string" }, title: { type: "string" } });
      if (!values.text) throw new UsageError("--text is required");
      deps.stdout(formatEvaluation(evaluate(inferCriteria(values.title ?? "", values.text), s.profile), ""));
    },
  },
  {
    name: "do-not-research",
    usage: 'settlements do-not-research [add "<name>" --reason "<why>"]',
    summary: "The permanent list research never brings back up",
    async run(args, s, deps) {
      const { values, positionals } = parse(args, { reason: { type: "string" } });
      const tracker = await s.openTracker();
      if (positionals[0] === "add") {
        if (!positionals[1] || !values.reason) throw new UsageError('add needs a name and --reason');
        const entry = await tracker.addDoNotResearch({ name: positionals.slice(1).join(" "), reason: values.reason });
        deps.stdout(`Added ${entry.name}: ${entry.reason}`);
        return;
      }
      if (positionals.length > 0) throw new UsageError("unknown argument");
      for (const e of tracker.doNotResearch()) deps.stdout(`${e.addedOn}  ${e.name}${e.aliases.length ? ` (also: ${e.aliases.join(", ")})` : ""} — ${e.reason}`);
    },
  },
];

export function settlementsUsage(): string {
  return [
    "Usage (orchestrator settlements ...):",
    ...COMMANDS.map((c) => `  ${c.usage}\n      ${c.summary}`),
    "",
    OWNER_FILES_REMINDER,
  ].join("\n");
}

export async function runSettlementsCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const settlements = deps.settlements;
  if (!settlements) {
    deps.stderr("Settlements are not configured for this CLI invocation.");
    return 1;
  }
  const [name, ...rest] = args;
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    deps.stderr(settlementsUsage());
    return 1;
  }
  try {
    await command.run(rest, settlements, deps);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\nUsage: orchestrator ${command.usage}`);
      return 1;
    }
    if (error instanceof TrackerError) {
      deps.stderr(error.message);
      return 1;
    }
    deps.stderr(`settlements ${command.name} failed: ${(error as Error).message}`);
    return 1;
  }
}
