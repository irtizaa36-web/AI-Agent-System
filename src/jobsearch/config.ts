import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PREFERENCES, type Preferences, type WatchlistEntry } from "./records";
import type { CandidateProfile } from "./score";
import { isNotFoundError } from "../store/run-store";

/**
 * Loads the pipeline's configuration from disk.
 *
 * Preferences and the watchlist are committed config — the person who knows
 * which titles and which employers matter edits JSON, never TypeScript. The
 * candidate profile is the opposite: it is her actual resume, so it lives in
 * `profile/`, which is gitignored, and a missing profile is a loud, explained
 * failure rather than a run that quietly scores against nothing.
 */

export const CONFIG_DIR = "config/job-search";
export const PROFILE_DIR = "profile";
export const DATA_DIR = ".orchestrator/jobs";
export const COST_LOG_PATH = "logs/costs.jsonl";

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw new Error(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Merges the file over the defaults, so a config missing a key still runs. */
export async function loadPreferences(root = "."): Promise<Preferences> {
  const fromFile = await readJsonIfPresent<Partial<Preferences>>(join(root, CONFIG_DIR, "preferences.json"));
  return { ...DEFAULT_PREFERENCES, ...(fromFile ?? {}) };
}

export async function loadWatchlist(root = "."): Promise<readonly WatchlistEntry[]> {
  const entries = await readJsonIfPresent<readonly WatchlistEntry[]>(join(root, CONFIG_DIR, "watchlist.json"));
  return entries ?? [];
}

export class MissingProfileError extends Error {}

/**
 * The resume, converted to text once and cached. Absent means the pipeline
 * cannot score honestly, so it says so by name instead of scoring against an
 * empty string and producing confident nonsense.
 */
export async function loadProfile(root = "."): Promise<CandidateProfile> {
  let resumeText: string;
  try {
    resumeText = await readFile(join(root, PROFILE_DIR, "resume.md"), "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new MissingProfileError(
        `No resume found at ${join(root, PROFILE_DIR, "resume.md")}. ` +
          "Convert the base resume to Markdown once and save it there — the pipeline caches it and never re-parses. " +
          "Scoring is skipped until it exists; discovery and filtering still run.",
      );
    }
    throw error;
  }

  const notes = (await readFileIfPresent(join(root, PROFILE_DIR, "notes.md"))) ?? "";
  return { resume: resumeText.trim(), notes: notes.trim() };
}

async function readFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}
