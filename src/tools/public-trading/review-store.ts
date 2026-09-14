import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "../../store/run-store";
import { parseWatermark, renderReview } from "./render";
import type { Review } from "./review";

/**
 * Where per-run reviews live and how a run finds the previous one.
 *
 * Reviews are committed Markdown under `docs/operations/public-trading/`, one
 * file per run, named by run date. Continuity comes from the files themselves:
 * the newest review's frontmatter carries the `watermark` (the latest
 * transaction timestamp that run accounted for), and the next run reads it to
 * decide what "closed since last run" means. No separate state file exists to
 * drift out of sync with the reviews.
 *
 * A note on what these files contain, recorded here because it is a standing
 * property of the design rather than a one-off: a review holds account value,
 * positions, buying power and realised P/L, and this repository is public. That
 * was a deliberate, confirmed choice to keep the reviews durable and readable
 * across sessions and clients. If the repository's visibility assumptions ever
 * change, this directory is the thing to revisit first.
 */
export const DEFAULT_REVIEW_DIR = "docs/operations/public-trading";

/** `YYYY-MM-DD.md`, with a `-2`, `-3`, … suffix if a run repeats within a day. */
export function reviewFileName(runAt: string, existing: readonly string[] = []): string {
  const date = runAt.slice(0, 10);
  const base = `${date}.md`;
  if (!existing.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${date}-${suffix}.md`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${date}-${Date.parse(runAt)}.md`;
}

async function listReviewFiles(dir: string): Promise<readonly string[]> {
  try {
    const files = await readdir(dir);
    return files.filter((file) => /^\d{4}-\d{2}-\d{2}(-\d+)?\.md$/.test(file)).sort();
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
}

/**
 * Reads the watermark from the most recent review on disk, or `undefined` when
 * none exists yet (the first run, which then reports over the whole window).
 */
export async function readLatestWatermark(dir: string = DEFAULT_REVIEW_DIR): Promise<string | undefined> {
  const files = await listReviewFiles(dir);
  // Sorted ascending by name, which for `YYYY-MM-DD[-n].md` is chronological.
  for (const file of [...files].reverse()) {
    const watermark = parseWatermark(await readFile(join(dir, file), "utf-8"));
    if (watermark !== undefined) return watermark;
  }
  return undefined;
}

export interface WrittenReview {
  readonly path: string;
  readonly markdown: string;
}

/** Renders and writes a review, returning where it landed. */
export async function writeReview(review: Review, dir: string = DEFAULT_REVIEW_DIR): Promise<WrittenReview> {
  await mkdir(dir, { recursive: true });
  const existing = await listReviewFiles(dir);
  const path = join(dir, reviewFileName(review.runAt, existing));
  const markdown = renderReview(review);
  await writeFile(path, markdown, "utf-8");
  return { path, markdown };
}
