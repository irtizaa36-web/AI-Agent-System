/**
 * The brief file format the orchestrator writes and the watcher reads
 * (ADR 0027), documented for humans in docs/delegation/PROTOCOL.md. A brief
 * lives at `docs/delegation/briefs/<task>.md` on a `claude/*` branch:
 *
 *   # <Task title>
 *
 *   Target branch: `claude/<task>-<suffix>`
 *
 *   <free-form body — instructions for the Code session picking this up>
 *
 * Parsing is deliberately strict about the two structural lines (title,
 * target branch) and permissive about everything else, so a malformed
 * brief is reported clearly rather than silently misread or guessed at
 * (PROTOCOL.md hard rule 2: never invent results).
 */

export interface Brief {
  readonly title: string;
  readonly targetBranch: string;
  readonly body: string;
}

export type ParseBriefResult = { readonly ok: true; readonly brief: Brief } | { readonly ok: false; readonly error: string };

const TARGET_BRANCH_LINE = /^target branch:\s*(.+)$/i;
const TITLE_LINE = /^#\s+(.+?)\s*$/;
/** Mirrors the naming convention PROTOCOL.md already documents for a Code session's own branch. */
const VALID_BRANCH_NAME = /^claude\/[A-Za-z0-9._/-]+$/;

export function parseBrief(raw: string): ParseBriefResult {
  const lines = raw.split(/\r?\n/);
  let index = 0;

  while (index < lines.length && lines[index].trim().length === 0) index++;
  if (index >= lines.length) {
    return { ok: false, error: "empty brief file" };
  }

  const titleMatch = TITLE_LINE.exec(lines[index]);
  if (!titleMatch) {
    return { ok: false, error: "missing title — expected the first non-blank line to be '# <Task title>'" };
  }
  const title = titleMatch[1];
  index++;

  let targetBranch: string | undefined;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0) {
      index++;
      continue;
    }
    const branchMatch = TARGET_BRANCH_LINE.exec(line.trim());
    if (branchMatch) {
      targetBranch = branchMatch[1].trim().replace(/^`+|`+$/g, "").trim();
      index++;
      break;
    }
    // Any other non-blank line before "Target branch:" is unexpected content — fail rather than guess.
    return { ok: false, error: `expected a 'Target branch:' line before other content, found: "${line.trim()}"` };
  }

  if (!targetBranch) {
    return { ok: false, error: "missing 'Target branch:' line" };
  }
  if (!VALID_BRANCH_NAME.test(targetBranch)) {
    return { ok: false, error: `invalid target branch "${targetBranch}" — expected a name starting with "claude/"` };
  }

  const body = lines.slice(index).join("\n").trim();
  return { ok: true, brief: { title, targetBranch, body } };
}
