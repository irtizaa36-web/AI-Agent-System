import { daysUntil } from "./dates";
import { deadlineRows, effectiveDeadline, type DeadlineRow, type Nudge } from "./deadlines";
import { evaluate, OWNER_PROFILE, type Evaluation, type OwnerProfile } from "./eligibility";
import type { RankedCandidate, SweepResult } from "./research/pipeline";
import { priority } from "./scoring";
import type { ActionItem, Candidate, IsoDate, Settlement, TrackerDocument } from "./types";

/**
 * Plain-text rendering shared by the CLI and the agent's tools, so both show
 * the owner exactly the same facts. Every rendering ends a filing-related
 * section with the same reminder: he files each claim himself.
 */

export const OWNER_FILES_REMINDER = "Nothing has been filed, attested or submitted for you. Every claim is filed by you, personally, on the official settlement site.";

const URGENCY_LABEL: Readonly<Record<DeadlineRow["urgency"], string>> = {
  overdue: "OVERDUE",
  today: "DUE TODAY",
  critical: "CRITICAL",
  soon: "SOON",
  upcoming: "UPCOMING",
  later: "later",
  no_deadline: "no deadline",
};

function days(n: number | undefined): string {
  if (n === undefined) return "no sourced deadline";
  if (n < 0) return `${-n} day${n === -1 ? "" : "s"} ago`;
  if (n === 0) return "today";
  return `${n} day${n === 1 ? "" : "s"} left`;
}

function actionLine(a: ActionItem): string {
  return `      [${a.done ? "x" : " "}] ${a.id} (${a.kind.replace(/_/g, " ")}) ${a.description}${a.done ? ` — done ${a.doneOn}${a.note ? `: ${a.note}` : ""}` : ""}`;
}

function conflictNote(s: Pick<Settlement, "deadline" | "deadlineConflicts">): string | undefined {
  const others = s.deadlineConflicts.filter((c) => c.date !== s.deadline?.date);
  if (others.length === 0) return undefined;
  return `    ! Sources disagree on the deadline: ${[s.deadline, ...others].filter(Boolean).map((f) => `${f!.date} (${f!.source.label})`).join(" vs ")}. Acting on the earliest; confirm on the official site.`;
}

export function formatDeadlines(settlements: readonly Settlement[], today: IsoDate, opts: { includeClosed?: boolean } = {}): string {
  const rows = deadlineRows(settlements, today, opts);
  if (rows.length === 0) return `No open settlements (as of ${today}).`;
  const lines = [`Deadlines as of ${today} (earliest source wins when they disagree):`];
  for (const r of rows) {
    const open = r.openActions.length;
    lines.push(
      `  ${URGENCY_LABEL[r.urgency].padEnd(11)} ${(r.deadline ?? "----------").padEnd(10)}  ${days(r.daysLeft).padEnd(14)}  ${r.settlement.name} (${r.settlement.id}) — ${r.settlement.status}, ${r.settlement.eligibility.verdict}${open ? `, ${open} to-do` : ""}${r.conflicting ? ", deadline conflict" : ""}`,
    );
  }
  return lines.join("\n");
}

export function formatNudges(nudges: readonly Nudge[], today: IsoDate): string {
  if (nudges.length === 0) return `No new deadline nudges today (${today}). Nudges fire once each at 14, 7, 3 and 1 days left.`;
  const lines = [`${nudges.length} deadline nudge${nudges.length === 1 ? "" : "s"} (${today}):`];
  for (const n of nudges) {
    lines.push(`- ${n.settlement.name}: ${days(n.daysLeft)} (deadline ${n.deadline}, ${n.threshold}-day mark)`);
    if (n.openActions.length === 0) lines.push("    No open to-dos recorded — check the claim form for anything only you can supply.");
    for (const a of n.openActions) lines.push(`    you: ${a.description}`);
  }
  lines.push("", OWNER_FILES_REMINDER);
  return lines.join("\n");
}

export function formatEvaluation(ev: Evaluation, indent = "    "): string {
  const lines = [`${indent}eligibility check: ${ev.verdict} — ${ev.summary}`];
  for (const c of ev.checks) lines.push(`${indent}  ${c.result === "met" ? "✓" : c.result === "not_met" ? "✗" : "? you need to confirm:"} ${c.criterion.description}${c.result === "unknown" ? "" : ` (${c.note})`}`);
  return lines.join("\n");
}

export function formatSettlement(s: Settlement, today: IsoDate, profile: OwnerProfile = OWNER_PROFILE, detail = false): string {
  const deadline = effectiveDeadline(s);
  const left = deadline ? daysUntil(deadline, today) : undefined;
  const ev = evaluate(s.criteria, profile);
  const score = priority({ verdict: s.eligibility.verdict === "unverified" ? ev.verdict : s.eligibility.verdict, evaluation: ev, today, ...(s.payout ? { payoutText: s.payout.text } : {}), ...(deadline ? { deadline } : {}) });
  const lines = [`${s.name} (${s.id}) — ${s.status.replace(/_/g, " ")}${deadline ? `, deadline ${deadline}, ${days(left)}` : ""}${s.status === "researching" || s.status === "ready_to_file" ? `, priority ${score.score}` : ""}`];
  lines.push(`    verdict: ${s.eligibility.verdict} — ${s.eligibility.reason} (${s.eligibility.decidedOn})`);
  lines.push(`    payout: ${s.payout ? `${s.payout.text} [${s.payout.source.label}${s.payout.source.url ? ` ${s.payout.source.url}` : ""}]` : "unknown — no source states one"}`);
  if (s.deadline) lines.push(`    deadline source: ${s.deadline.source.label}${s.deadline.source.url ? ` ${s.deadline.source.url}` : ""}`);
  const conflict = conflictNote(s);
  if (conflict) lines.push(conflict);
  if (s.status === "filed" || s.status === "paid") {
    lines.push(`    filed by you on ${s.filedOn ?? "(date not recorded)"}; confirmation: ${s.confirmation ?? `NOT RECORDED — run: settlements confirmation ${s.id} <number>`}`);
  }
  if (s.paid) lines.push(`    paid $${s.paid.amount.toFixed(2)} on ${s.paid.on}`);
  if (s.status === "dropped") lines.push(`    dropped: ${s.dropReason ?? "(no reason)"} — on the do-not-research list`);
  if (s.status === "researching" || s.status === "ready_to_file") {
    if (s.eligibility.verdict !== "eligible") lines.push(formatEvaluation(ev));
    if (left !== undefined && left < 0) lines.push("    ! The deadline has passed. If you didn't file, record it: settlements status <id> dropped --evidence \"missed deadline\".");
  }
  const actions = detail ? s.actions : s.actions.filter((a) => !a.done);
  if (actions.length > 0) {
    lines.push("    your to-dos:");
    for (const a of actions) lines.push(actionLine(a));
  }
  if (detail) {
    if (s.classDefinition) lines.push(`    class: ${s.classDefinition}`);
    lines.push("    history:");
    for (const h of s.history) lines.push(`      ${h.on} ${h.from ? `${h.from} → ` : ""}${h.to}: ${h.evidence}`);
  }
  return lines.join("\n");
}

export function formatReview(doc: TrackerDocument, today: IsoDate, profile: OwnerProfile = OWNER_PROFILE): string {
  const open = deadlineRows(doc.settlements, today).map((r) => r.settlement);
  const filed = doc.settlements.filter((s) => s.status === "filed" || s.status === "paid");
  const dropped = doc.settlements.filter((s) => s.status === "dropped");
  const lines = [`Settlement review — ${today}`, "", `OPEN (${open.length}), soonest deadline first:`];
  for (const s of open) lines.push(formatSettlement(s, today, profile));
  lines.push("", `FILED BY YOU (${filed.length}):`);
  for (const s of filed) lines.push(formatSettlement(s, today, profile));
  lines.push("", `DROPPED (${dropped.length}), permanently off the research list: ${dropped.map((s) => s.name).join(", ") || "none"}`);
  lines.push(`RESEARCH INBOX: ${doc.inbox.length} candidate${doc.inbox.length === 1 ? "" : "s"} awaiting your decision${doc.inbox.length ? " (settlements inbox)" : ""}`);
  lines.push("", OWNER_FILES_REMINDER);
  return lines.join("\n");
}

export function formatCandidate(rc: RankedCandidate, today: IsoDate): string {
  const c = rc.candidate;
  const deadline = effectiveDeadline(c);
  const lines = [`${c.id}  priority ${rc.priority.score}  ${c.name}`];
  lines.push(`    deadline: ${deadline ? `${deadline} (${days(daysUntil(deadline, today))})` : "not stated by the sources — check the official site"}`);
  if (c.deadlineConflicts.length > 0) lines.push(`    ! sources disagree: ${[c.deadline, ...c.deadlineConflicts].filter(Boolean).map((f) => `${f!.date} (${f!.source.label})`).join(" vs ")}`);
  lines.push(`    payout: ${c.payout ? `${c.payout.text} [${c.payout.source.label}]` : "not stated"}${rc.proofRequired ? "; proof required" : ""}`);
  if (c.eligibilityText) lines.push(`    class: ${c.eligibilityText}`);
  lines.push(formatEvaluation(rc.evaluation));
  lines.push(`    sources: ${c.sources.map((s) => s.url ?? s.label).join(" | ")}`);
  if (c.website) lines.push(`    official site: ${c.website}`);
  return lines.join("\n");
}

export function formatInbox(inbox: readonly Candidate[], today: IsoDate, profile: OwnerProfile = OWNER_PROFILE): string {
  if (inbox.length === 0) return "Research inbox is empty. Run: settlements research";
  return inbox
    .map((c) => {
      const ev = evaluate(c.criteria, profile);
      const deadline = effectiveDeadline(c);
      return `${c.id}  ${ev.verdict.padEnd(12)}  ${deadline ?? "no deadline"}  ${c.name}${c.payout ? `  (${c.payout.text})` : ""}`;
    })
    .concat(["", "Track one: settlements add <candidate-id>   ·   Rule one out for good: settlements dismiss <candidate-id> --reason \"...\""])
    .join("\n");
}

export function formatSweep(result: SweepResult, today: IsoDate, limit = 15): string {
  const lines = [`Research sweep — ${today}`];
  for (const r of result.reports) lines.push(`  source ${r.source}: ${r.ok ? `${r.listings} listings` : `UNAVAILABLE (${r.error})`}`);
  const likely = result.fresh.filter((f) => f.evaluation.verdict !== "not_eligible");
  const unlikely = result.fresh.filter((f) => f.evaluation.verdict === "not_eligible");
  lines.push("", `NEW (${likely.length}), highest priority first — all saved to the research inbox:`);
  for (const f of likely.slice(0, limit)) lines.push(formatCandidate(f, today));
  if (likely.length > limit) lines.push(`  …and ${likely.length - limit} more in the inbox (settlements inbox).`);
  if (unlikely.length > 0) {
    lines.push("", `NEW BUT LIKELY NOT ELIGIBLE (${unlikely.length}):`);
    for (const f of unlikely) lines.push(`  ${f.candidate.id}  ${f.candidate.name} — ${f.evaluation.summary}`);
  }
  lines.push("", `Already tracked (${result.tracked.length}): ${result.tracked.map((t) => t.name).join(", ") || "none"}`);
  for (const t of result.tracked.filter((t) => t.newDeadlineConflict)) {
    lines.push(`  ! ${t.name}: ${t.newDeadlineConflict!.source.label} lists deadline ${t.newDeadlineConflict!.date}; recorded as a conflict, your deadline unchanged.`);
  }
  lines.push(`Skipped — on the do-not-research list (${result.blocked.length}): ${result.blocked.map((b) => `${b.name} [${b.blockedBy}]`).join(", ") || "none"}`);
  lines.push(`Skipped — reported in an earlier sweep: ${result.alreadySeen}; deadline passed: ${result.expired}`);
  lines.push("", "Eligibility here is checked only against your profile; anything marked ? needs your own records. Nothing was added to your tracker.");
  return lines.join("\n");
}
