import type { JobRecord } from "./records";
import { salaryUnknown } from "./filter";
import type { SourceHealth } from "./health";
import { summarizeHealth } from "./health";

/**
 * Stage 10: the digest. Pure templating — no model writes this, because
 * nothing here requires judgment that stage 8 has not already made.
 *
 * What it refuses to do matters as much as what it does: a posting with no
 * stated salary says "not stated" rather than showing a plausible number, and
 * the gaps the scorer found are printed next to the roles she is most likely
 * to apply to, not hidden at the bottom.
 */

export interface RunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly fetchedCount: number;
  readonly newCount: number;
  readonly duplicateCount: number;
  readonly filteredCount: number;
  readonly scoredCount: number;
  readonly shortlisted: readonly JobRecord[];
  readonly alsoSeen: readonly JobRecord[];
  readonly health: readonly SourceHealth[];
  readonly failures: readonly string[];
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function money(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function salaryLine(record: JobRecord): string {
  if (salaryUnknown(record)) return "Pay not stated";
  const currency = record.salaryCurrency ?? "";
  if (record.salaryMin === record.salaryMax) return `${record.salaryMin?.toLocaleString()} ${currency}`.trim();
  return `${record.salaryMin?.toLocaleString()}–${record.salaryMax?.toLocaleString()} ${currency}`.trim();
}

function roleBlock(record: JobRecord, index: number): string {
  const lines = [
    `### ${index}. ${record.title} — ${record.company}`,
    "",
    `**Score ${record.score ?? "?"}/100** · confidence ${record.confidence ?? "unknown"} · ${record.locationClass} · ${salaryLine(record)}`,
    "",
    record.rationale || "_No rationale returned._",
  ];

  if (record.gaps.length > 0) {
    lines.push("", `**Gaps:** ${record.gaps.join("; ")}`);
  }

  lines.push("", `[Apply](${record.applyUrl})`);
  if (record.sources.length > 1) {
    lines.push(`Also posted: ${record.sources.slice(1).map((source) => `[${source.sourceId}](${source.url})`).join(", ")}`);
  }

  return lines.join("\n");
}

export function renderDigest(summary: RunSummary): string {
  const date = summary.startedAt.slice(0, 10);
  const lines: string[] = [
    `# Job digest — ${date}`,
    "",
    `${summary.shortlisted.length} role${summary.shortlisted.length === 1 ? "" : "s"} worth a look · ` +
      `${summary.newCount} new of ${summary.fetchedCount} fetched · ` +
      `${summary.filteredCount} filtered out · ` +
      `run cost ${money(summary.costUsd)}`,
    "",
  ];

  if (summary.shortlisted.length === 0) {
    lines.push("No new roles cleared the score cutoff this run.", "");
  } else {
    lines.push("## Worth a look", "");
    summary.shortlisted.forEach((record, index) => {
      lines.push(roleBlock(record, index + 1), "");
    });
  }

  if (summary.alsoSeen.length > 0) {
    lines.push("## Also seen (below cutoff)", "");
    for (const record of summary.alsoSeen) {
      lines.push(`- **${record.score ?? "?"}** · [${record.title} — ${record.company}](${record.applyUrl})`);
    }
    lines.push("");
  }

  lines.push("## Run", "");
  lines.push(`- Sources: ${summarizeHealth(summary.health)}`);
  lines.push(`- Tokens: ${summary.inputTokens.toLocaleString()} in, ${summary.outputTokens.toLocaleString()} out`);
  lines.push(`- Cost: ${money(summary.costUsd)}`);

  const broken = summary.health.filter((entry) => entry.state === "degraded");
  if (broken.length > 0) {
    lines.push("", "### Sources needing attention", "");
    for (const entry of broken) {
      lines.push(`- \`${entry.sourceId}\` — ${entry.error ?? "unknown error"}`);
    }
  }

  if (summary.failures.length > 0) {
    lines.push("", "### Postings not scored this run", "");
    lines.push("_These keep their place in the queue and are retried on the next run._", "");
    for (const failure of summary.failures) {
      lines.push(`- ${failure}`);
    }
  }

  lines.push(
    "",
    "---",
    "",
    "_Discovery and scoring only. Nothing was applied to, nobody was contacted, and no message was sent._",
  );

  return lines.join("\n");
}

/** The same run, as data, for the dashboard to render. */
export function digestPayload(summary: RunSummary): Record<string, unknown> {
  return {
    runId: summary.runId,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    counts: {
      fetched: summary.fetchedCount,
      new: summary.newCount,
      duplicates: summary.duplicateCount,
      filtered: summary.filteredCount,
      scored: summary.scoredCount,
      shortlisted: summary.shortlisted.length,
    },
    costUsd: summary.costUsd,
    shortlisted: summary.shortlisted.map((record) => ({
      id: record.id,
      title: record.title,
      company: record.company,
      locationClass: record.locationClass,
      salaryStated: !salaryUnknown(record),
      salaryMin: record.salaryMin,
      salaryMax: record.salaryMax,
      score: record.score,
      confidence: record.confidence,
      rationale: record.rationale,
      gaps: record.gaps,
      applyUrl: record.applyUrl,
    })),
    health: summary.health,
    failures: summary.failures,
  };
}
