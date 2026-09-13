import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../store/run-store";

/**
 * The local review queue — the thing she actually opens.
 *
 * Deliberately its own small server rather than a section bolted onto the
 * coworker dashboard: that page is built around agent rosters and task
 * kanban, a different domain with a different snapshot shape, and job search
 * has no business reshaping it (ADR 0003).
 *
 * Read-only by design. There is no apply button, no send button, and no
 * endpoint that can act on the outside world — every outbound action in this
 * project stays behind the approval gate in ADR 0004, and Phase 1 has no
 * outbound capability at all.
 */

export interface JobsDashboardDeps {
  readonly dataDir: string;
}

interface DigestPayload {
  readonly startedAt?: string;
  readonly counts?: Record<string, number>;
  readonly costUsd?: number;
  readonly shortlisted?: readonly Record<string, unknown>[];
  readonly health?: readonly { sourceId: string; state: string; error: string | null }[];
  readonly failures?: readonly string[];
}

export async function readLatestDigest(dataDir: string): Promise<DigestPayload | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, "digests", "latest.json"), "utf8")) as DigestPayload;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function roleCard(role: Record<string, unknown>): string {
  const gaps = Array.isArray(role["gaps"]) ? (role["gaps"] as string[]) : [];
  const stated = role["salaryStated"] === true;
  const pay = stated
    ? `${Number(role["salaryMin"]).toLocaleString()}–${Number(role["salaryMax"]).toLocaleString()}`
    : "Pay not stated";

  return `<article class="role">
  <h3>${escapeHtml(role["title"])} <span class="co">${escapeHtml(role["company"])}</span></h3>
  <p class="meta">
    <span class="score">${escapeHtml(role["score"])}/100</span>
    <span>confidence ${escapeHtml(role["confidence"])}</span>
    <span>${escapeHtml(role["locationClass"])}</span>
    <span class="${stated ? "" : "muted"}">${escapeHtml(pay)}</span>
  </p>
  <p class="why">${escapeHtml(role["rationale"])}</p>
  ${gaps.length > 0 ? `<p class="gaps"><strong>Gaps:</strong> ${gaps.map(escapeHtml).join("; ")}</p>` : ""}
  <p><a href="${escapeHtml(role["applyUrl"])}" rel="noreferrer noopener" target="_blank">Open the posting</a></p>
</article>`;
}

export function renderJobsPage(digest: DigestPayload | null): string {
  const roles = digest?.shortlisted ?? [];
  const counts = digest?.counts ?? {};
  const broken = (digest?.health ?? []).filter((entry) => entry.state === "degraded");

  const body = digest
    ? `<p class="summary">
         <strong>${roles.length}</strong> role${roles.length === 1 ? "" : "s"} worth a look ·
         ${counts["new"] ?? 0} new of ${counts["fetched"] ?? 0} fetched ·
         ${counts["filtered"] ?? 0} filtered out ·
         run cost ${money(digest.costUsd ?? 0)}
       </p>
       ${roles.length === 0 ? "<p class='empty'>No new roles cleared the score cutoff on the last run.</p>" : roles.map(roleCard).join("\n")}
       ${broken.length > 0 ? `<section class="warn"><h2>Sources needing attention</h2><ul>${broken.map((entry) => `<li><code>${escapeHtml(entry.sourceId)}</code> — ${escapeHtml(entry.error)}</li>`).join("")}</ul></section>` : ""}
       ${(digest.failures ?? []).length > 0 ? `<section class="warn"><h2>Not scored this run</h2><p class="muted">These keep their place and are retried next run.</p><ul>${(digest.failures ?? []).map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul></section>` : ""}`
    : `<p class="empty">No digest yet. Run <code>npm run pipeline</code>.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job queue</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f6f8; --card:#fff; --text:#1a1d21; --muted:#4b515c; --border:#d8dce2; --accent:#0a6e2e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#15181c; --card:#1e2227; --text:#e8eaed; --muted:#a0a6b0; --border:#333941; --accent:#5fd08a; } }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 system-ui,-apple-system,sans-serif; }
  main { max-width: 50rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  .summary { color:var(--muted); margin:0 0 1.5rem; }
  .role { background:var(--card); border:1px solid var(--border); border-radius:.7rem; padding:1rem 1.1rem; margin-bottom:1rem; }
  .role h3 { margin:0 0 .4rem; font-size:1.05rem; }
  .co { color:var(--muted); font-weight:400; }
  .meta { display:flex; flex-wrap:wrap; gap:.75rem; margin:0 0 .6rem; font-size:.875rem; color:var(--muted); }
  .score { color:var(--accent); font-weight:600; }
  .why { margin:0 0 .5rem; }
  .gaps { margin:0 0 .5rem; font-size:.9rem; color:var(--muted); }
  .muted { color:var(--muted); }
  .empty { color:var(--muted); }
  .warn { margin-top:2rem; border-top:1px solid var(--border); padding-top:1rem; }
  .warn h2 { font-size:1rem; }
  a { color:var(--accent); }
  footer { margin-top:2.5rem; color:var(--muted); font-size:.85rem; border-top:1px solid var(--border); padding-top:1rem; }
</style></head>
<body><main>
<h1>Job queue</h1>
${body}
<footer>Discovery and scoring only. Nothing here has been applied to, nobody has been contacted, and no message has been sent. Every posting links out to the employer's own page.</footer>
</main></body></html>`;
}

export function createJobsDashboardServer(deps: JobsDashboardDeps): Server {
  return createServer(async (req, res) => {
    try {
      const digest = await readLatestDigest(deps.dataDir);

      if (req.url === "/api/digest") {
        const json = JSON.stringify(digest ?? {});
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(json);
        return;
      }

      const html = renderJobsPage(digest);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`dashboard error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
