import type { RunSummary } from "./digest";
import { salaryUnknown } from "./filter";
import type { JobRecord } from "./records";

/**
 * Turns a run's summary into an email — subject and plain-text body. Pure
 * formatting, same split as digest-sms.ts: the actual sending, and the
 * gating around whether to send at all, live in the CLI.
 *
 * Unlike the SMS/iMessage version, there's no length cap here — the whole
 * point of moving to email (per Irtiza's Sep 14 ask, "so she can apply
 * quicker") is that every shortlisted role gets its own paragraph with the
 * rationale and gaps that made the scorer flag it, plus the apply link on
 * its own line so it's unambiguously clickable rather than buried in
 * markdown brackets. Drafts sent through InkboxClient are plain text only
 * (see DraftEmail in client.ts) — no markdown syntax here, since `**bold**`
 * and `[text](url)` would show up as literal characters in a plain-text
 * client, not render.
 */

export function formatDigestEmailSubject(summary: RunSummary): string {
  const date = summary.startedAt.slice(0, 10);
  const n = summary.shortlisted.length;
  return n === 0 ? `Job digest ${date}: nothing new today` : `Job digest ${date}: ${n} role${n === 1 ? "" : "s"} worth a look`;
}

function payLine(record: JobRecord): string {
  if (salaryUnknown(record)) return "Pay not stated";
  const currency = record.salaryCurrency ?? "";
  return record.salaryMin === record.salaryMax
    ? `${record.salaryMin?.toLocaleString()} ${currency}`.trim()
    : `${record.salaryMin?.toLocaleString()}-${record.salaryMax?.toLocaleString()} ${currency}`.trim();
}

export function formatDigestEmailBody(summary: RunSummary): string {
  const date = summary.startedAt.slice(0, 10);
  const lines: string[] = [];

  if (summary.shortlisted.length === 0) {
    lines.push(
      `No new roles cleared the bar today (${date}).`,
      "",
      `${summary.newCount} new posting${summary.newCount === 1 ? "" : "s"} reviewed, ${summary.shortlisted.length + summary.alsoSeen.length} scored.`,
    );
  } else {
    lines.push(`${summary.shortlisted.length} role${summary.shortlisted.length === 1 ? "" : "s"} worth a look — ${date}`, "");

    summary.shortlisted.forEach((record, index) => {
      lines.push(
        `${index + 1}. ${record.title} — ${record.company}`,
        `   Score ${record.score ?? "?"}/100 · confidence ${record.confidence ?? "unknown"} · ${record.locationClass} · ${payLine(record)}`,
        "",
        `   ${record.rationale || "No rationale returned."}`,
      );
      if (record.gaps.length > 0) {
        lines.push("", `   Gaps: ${record.gaps.join("; ")}`);
      }
      lines.push("", `   Apply: ${record.applyUrl}`, "");
    });

    if (summary.alsoSeen.length > 0) {
      lines.push(`Also seen, below the cutoff: ${summary.alsoSeen.length} more role${summary.alsoSeen.length === 1 ? "" : "s"} — see the dashboard for details.`, "");
    }
  }

  lines.push("---", "Discovery and scoring only. Nothing was applied to, nobody was contacted, and no message was sent.");

  return lines.join("\n");
}
