import type { RunSummary } from "./digest";
import { salaryUnknown } from "./filter";

/**
 * Turns a run's summary into a text message. Pure formatting — the actual
 * sending, and the gating around whether to send at all, live in
 * sms-client.ts and the CLI. No model involved: everything here already
 * exists on the `RunSummary` the run produced.
 *
 * Per Shivani's explicit ask, every role gets its own apply link in the
 * text itself — not a single link back to the dashboard. Capped by
 * `maxRoles` so the message stays a message rather than the full digest;
 * anything past the cap is left for the dashboard, and the text says so.
 */
export function formatDigestSms(summary: RunSummary, maxRoles: number): string {
  const date = summary.startedAt.slice(0, 10);
  const shown = summary.shortlisted.slice(0, maxRoles);
  const omitted = summary.shortlisted.length - shown.length;

  if (shown.length === 0) {
    return `Job digest ${date}: no new roles cleared the bar today. ${summary.newCount} new postings reviewed, ${summary.shortlisted.length + summary.alsoSeen.length} scored.`;
  }

  const lines: string[] = [`Job digest ${date} — ${summary.shortlisted.length} role${summary.shortlisted.length === 1 ? "" : "s"} worth a look:`];

  shown.forEach((record, index) => {
    const pay = salaryUnknown(record)
      ? ""
      : ` (${record.salaryMin === record.salaryMax ? record.salaryMin?.toLocaleString() : `${record.salaryMin?.toLocaleString()}-${record.salaryMax?.toLocaleString()}`})`;
    lines.push(`${index + 1}. ${record.title} @ ${record.company}${pay} [${record.score}] ${record.applyUrl}`);
  });

  if (omitted > 0) {
    lines.push(`+${omitted} more on the dashboard.`);
  }

  return lines.join("\n");
}
