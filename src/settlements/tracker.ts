import { daysUntil, isIsoDate } from "./dates";
import { dueNudges, toNudgeRecord, type Nudge } from "./deadlines";
import { isSameAs, slugify, type Identity } from "./matching";
import type { TrackerStorage } from "./storage";
import type {
  ActionItem,
  ActionKind,
  Candidate,
  Criterion,
  DatedFact,
  DoNotResearchEntry,
  IsoDate,
  PayoutEstimate,
  Settlement,
  SettlementStatus,
  TrackerDocument,
  Verdict,
} from "./types";

/**
 * The settlement tracker (ADR 0022): the one place every rule about the
 * owner's claims lives.
 *
 * Hard rules, enforced here rather than left to a prompt:
 * - Nothing here files, attests or submits anything. `filed` and `paid` only
 *   record what the owner reports he did himself, and only the CLI calls them.
 * - A status changes only with evidence, along an allowed path. `dropped` is
 *   permanent and puts the settlement on the do-not-research list.
 * - A deadline must come with a source. A confirmation number is only ever
 *   the one the owner supplies; nothing generates one.
 */

export class TrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerError";
  }
}

const TRANSITIONS: Readonly<Record<SettlementStatus, readonly SettlementStatus[]>> = {
  researching: ["ready_to_file", "filed", "dropped"],
  ready_to_file: ["researching", "filed", "dropped"],
  filed: ["paid", "dropped"],
  paid: [],
  dropped: [],
};

const CONFIRMATION = /^[A-Za-z0-9][A-Za-z0-9-]{3,63}$/;

export interface TransitionEvidence {
  /** What the owner saw or did that justifies the change. Always required. */
  readonly evidence: string;
  /** For `filed`: the day the owner submitted the claim himself. */
  readonly filedOn?: IsoDate;
  /** For `filed`: the confirmation number the claims administrator gave him, if any. */
  readonly confirmation?: string;
  /** For `paid`. */
  readonly amount?: number;
  readonly paidOn?: IsoDate;
}

export interface NewSettlement {
  readonly name: string;
  readonly deadline: DatedFact;
  readonly aliases?: readonly string[];
  readonly domains?: readonly string[];
  readonly website?: string;
  readonly payout?: PayoutEstimate;
  readonly classDefinition?: string;
  readonly criteria?: readonly Criterion[];
  readonly actions?: readonly { readonly kind: ActionKind; readonly description: string }[];
}

function identityOf(x: { name: string; aliases: readonly string[]; domains: readonly string[] }): Identity {
  return { names: [x.name, ...x.aliases], domains: x.domains };
}

function requireText(value: string | undefined, what: string): string {
  const text = value?.trim();
  if (!text) throw new TrackerError(`${what} is required.`);
  return text;
}

export class SettlementTracker {
  private constructor(
    private doc: TrackerDocument,
    private readonly storage: TrackerStorage,
    private readonly today: () => IsoDate,
  ) {}

  /** Loads the tracker, seeding it on first use only; an existing tracker is never re-seeded. */
  static async open(storage: TrackerStorage, opts: { readonly today: () => IsoDate; readonly seed?: () => TrackerDocument }): Promise<SettlementTracker> {
    const loaded = await storage.load();
    if (loaded) return new SettlementTracker(loaded, storage, opts.today);
    const doc: TrackerDocument = opts.seed ? opts.seed() : { version: 1, settlements: [], doNotResearch: [], inbox: [], seenKeys: [], nudges: [] };
    const tracker = new SettlementTracker(doc, storage, opts.today);
    await tracker.save();
    return tracker;
  }

  todayDate(): IsoDate {
    return this.today();
  }

  /** A deep copy, so callers can't change the tracker without going through its rules. */
  snapshot(): TrackerDocument {
    return structuredClone(this.doc);
  }

  list(): readonly Settlement[] {
    return this.snapshot().settlements;
  }

  get(id: string): Settlement {
    const s = this.doc.settlements.find((x) => x.id === id);
    if (!s) throw new TrackerError(`No tracked settlement "${id}". Run "settlements review" for ids.`);
    return structuredClone(s);
  }

  inbox(): readonly Candidate[] {
    return this.snapshot().inbox;
  }

  /** The permanent do-not-research list: explicit entries plus every dropped settlement. */
  doNotResearch(): readonly DoNotResearchEntry[] {
    return this.snapshot().doNotResearch;
  }

  /** The do-not-research entry that covers this settlement, if any. */
  blockedBy(identity: Identity): DoNotResearchEntry | undefined {
    return this.doc.doNotResearch.find((e) => isSameAs(identityOf(e), identity));
  }

  /** The tracked, not-dropped settlement this is, if any. */
  trackedAs(identity: Identity): Settlement | undefined {
    return this.doc.settlements.find((s) => s.status !== "dropped" && isSameAs(identityOf(s), identity));
  }

  hasSeen(keys: readonly string[]): boolean {
    return keys.some((k) => this.doc.seenKeys.includes(k));
  }

  async add(input: NewSettlement): Promise<Settlement> {
    const name = requireText(input.name, "A name");
    if (!isIsoDate(input.deadline.date)) throw new TrackerError(`Deadline must be YYYY-MM-DD, got "${input.deadline.date}".`);
    requireText(input.deadline.source.label, "A source for the deadline");
    const identity: Identity = { names: [name, ...(input.aliases ?? [])], domains: input.domains ?? [] };
    const blocked = this.blockedBy(identity);
    if (blocked) throw new TrackerError(`"${name}" is on the do-not-research list (${blocked.name}: ${blocked.reason}).`);
    const existing = this.trackedAs(identity);
    if (existing) throw new TrackerError(`"${name}" is already tracked as ${existing.id}.`);

    const today = this.today();
    const settlement: Settlement = {
      id: this.uniqueId(slugify(name)),
      name,
      aliases: [...(input.aliases ?? [])],
      domains: [...(input.domains ?? [])],
      criteria: [...(input.criteria ?? [])],
      deadline: input.deadline,
      deadlineConflicts: [],
      eligibility: { verdict: "unverified", reason: "Added; not yet reviewed against the class definition", decidedOn: today },
      status: "researching",
      history: [{ on: today, to: "researching", evidence: `Added by the owner (deadline source: ${input.deadline.source.label})` }],
      actions: (input.actions ?? []).map((a, i) => ({ id: `a${i + 1}`, kind: a.kind, description: a.description, done: false })),
      ...(input.website ? { website: input.website } : {}),
      ...(input.payout ? { payout: input.payout } : {}),
      ...(input.classDefinition ? { classDefinition: input.classDefinition } : {}),
    };
    this.doc.settlements.push(settlement);
    await this.save();
    return structuredClone(settlement);
  }

  /** Moves a research candidate into the tracker. Its deadline must be sourced, or supplied by the owner. */
  async promote(candidateId: string, override?: { readonly deadline?: DatedFact }): Promise<Settlement> {
    const candidate = this.doc.inbox.find((c) => c.id === candidateId);
    if (!candidate) throw new TrackerError(`No research candidate "${candidateId}". Run "settlements inbox" for ids.`);
    const deadline = override?.deadline ?? candidate.deadline;
    if (!deadline) throw new TrackerError(`${candidate.name} has no sourced deadline. Check the settlement site and pass --deadline YYYY-MM-DD --source <url>.`);
    const settlement = await this.add({
      name: candidate.name,
      deadline,
      domains: candidate.domains,
      criteria: candidate.criteria,
      ...(candidate.website ? { website: candidate.website } : {}),
      ...(candidate.payout ? { payout: candidate.payout } : {}),
      ...(candidate.eligibilityText ? { classDefinition: candidate.eligibilityText } : {}),
    });
    if (candidate.deadlineConflicts.length > 0) {
      const i = this.indexOf(settlement.id);
      this.doc.settlements[i] = { ...this.doc.settlements[i]!, deadlineConflicts: candidate.deadlineConflicts };
    }
    this.doc.inbox.splice(this.doc.inbox.findIndex((c) => c.id === candidateId), 1);
    await this.save();
    return this.get(settlement.id);
  }

  /** The owner decided a candidate isn't his: it goes on the permanent do-not-research list. */
  async dismiss(candidateId: string, reason: string): Promise<DoNotResearchEntry> {
    const candidate = this.doc.inbox.find((c) => c.id === candidateId);
    if (!candidate) throw new TrackerError(`No research candidate "${candidateId}".`);
    const entry = await this.addDoNotResearch({ name: candidate.name, aliases: [], domains: candidate.domains, reason });
    this.doc.inbox.splice(this.doc.inbox.indexOf(candidate), 1);
    await this.save();
    return entry;
  }

  async addDoNotResearch(input: { readonly name: string; readonly aliases?: readonly string[]; readonly domains?: readonly string[]; readonly reason: string }): Promise<DoNotResearchEntry> {
    const entry: DoNotResearchEntry = {
      name: requireText(input.name, "A name"),
      aliases: [...(input.aliases ?? [])],
      domains: [...(input.domains ?? [])],
      reason: requireText(input.reason, "A reason"),
      addedOn: this.today(),
    };
    if (!this.doc.doNotResearch.some((e) => e.name === entry.name)) this.doc.doNotResearch.push(entry);
    await this.save();
    return entry;
  }

  async transition(id: string, to: SettlementStatus, ev: TransitionEvidence): Promise<Settlement> {
    const i = this.indexOf(id);
    const s = this.doc.settlements[i]!;
    const evidence = requireText(ev.evidence, "Evidence for a status change");
    if (s.status === to) throw new TrackerError(`${s.name} is already ${to}.`);
    if (!TRANSITIONS[s.status].includes(to)) {
      const allowed = TRANSITIONS[s.status];
      throw new TrackerError(`${s.name} can't go from ${s.status} to ${to}${allowed.length ? ` (allowed: ${allowed.join(", ")})` : `; ${s.status} is final`}.`);
    }
    const today = this.today();
    let next: Settlement = { ...s, status: to, history: [...s.history, { on: today, from: s.status, to, evidence }] };

    if (to === "ready_to_file" && s.eligibility.verdict !== "eligible") {
      throw new TrackerError(`${s.name} is ${s.eligibility.verdict}. Record an "eligible" verdict with its evidence before marking it ready to file.`);
    }
    if (to === "filed") {
      if (!ev.filedOn || !isIsoDate(ev.filedOn)) throw new TrackerError("--filed-on YYYY-MM-DD (the day you submitted it) is required.");
      if (daysUntil(ev.filedOn, today) > 0) throw new TrackerError(`Filed date ${ev.filedOn} is in the future.`);
      const confirmation = ev.confirmation?.trim();
      if (confirmation !== undefined && !CONFIRMATION.test(confirmation)) throw new TrackerError(`"${confirmation}" doesn't look like a confirmation number (letters, digits, dashes).`);
      next = { ...next, filedOn: ev.filedOn, ...(confirmation ? { confirmation } : {}) };
    }
    if (to === "paid") {
      if (!(typeof ev.amount === "number" && Number.isFinite(ev.amount) && ev.amount >= 0)) throw new TrackerError("--amount (what was actually paid) is required.");
      if (!ev.paidOn || !isIsoDate(ev.paidOn)) throw new TrackerError("--paid-on YYYY-MM-DD is required.");
      next = { ...next, paid: { amount: ev.amount, on: ev.paidOn } };
    }
    if (to === "dropped") {
      next = { ...next, dropReason: evidence };
      if (!this.doc.doNotResearch.some((e) => e.name === s.name)) {
        this.doc.doNotResearch.push({ name: s.name, aliases: [...s.aliases], domains: [...s.domains], reason: evidence, addedOn: today });
      }
    }
    this.doc.settlements[i] = next;
    await this.save();
    return structuredClone(next);
  }

  async setVerdict(id: string, verdict: Verdict, reason: string): Promise<Settlement> {
    const i = this.indexOf(id);
    const s = this.doc.settlements[i]!;
    const next: Settlement = { ...s, eligibility: { verdict, reason: requireText(reason, "Evidence for the verdict"), decidedOn: this.today() } };
    this.doc.settlements[i] = next;
    await this.save();
    return structuredClone(next);
  }

  /** Records the confirmation number the owner received after filing. Never overwrites a different one. */
  async recordConfirmation(id: string, confirmation: string): Promise<Settlement> {
    const i = this.indexOf(id);
    const s = this.doc.settlements[i]!;
    const value = confirmation.trim();
    if (s.status !== "filed" && s.status !== "paid") throw new TrackerError(`${s.name} isn't filed. Record the filing with "settlements status ${id} filed".`);
    if (!CONFIRMATION.test(value)) throw new TrackerError(`"${value}" doesn't look like a confirmation number (letters, digits, dashes).`);
    if (s.confirmation && s.confirmation !== value) throw new TrackerError(`${s.name} already has confirmation ${s.confirmation}; not overwriting it.`);
    const next: Settlement = { ...s, confirmation: value };
    this.doc.settlements[i] = next;
    await this.save();
    return structuredClone(next);
  }

  async addAction(id: string, kind: ActionKind, description: string): Promise<ActionItem> {
    const i = this.indexOf(id);
    const s = this.doc.settlements[i]!;
    const action: ActionItem = { id: `a${s.actions.length + 1}`, kind, description: requireText(description, "An action description"), done: false };
    this.doc.settlements[i] = { ...s, actions: [...s.actions, action] };
    await this.save();
    return action;
  }

  async completeAction(id: string, actionId: string, note?: string): Promise<ActionItem> {
    const i = this.indexOf(id);
    const s = this.doc.settlements[i]!;
    const action = s.actions.find((a) => a.id === actionId);
    if (!action) throw new TrackerError(`${s.name} has no action "${actionId}".`);
    if (action.done) throw new TrackerError(`Action ${actionId} is already done (${action.doneOn}).`);
    const done: ActionItem = { ...action, done: true, doneOn: this.today(), ...(note?.trim() ? { note: note.trim() } : {}) };
    this.doc.settlements[i] = { ...s, actions: s.actions.map((a) => (a.id === actionId ? done : a)) };
    await this.save();
    return done;
  }

  /** A source reported a different deadline. Recorded for the owner to check; the recorded deadline is not changed. */
  async noteDeadlineConflict(id: string, fact: DatedFact): Promise<boolean> {
    const i = this.indexOf(id);
    const s = this.doc.settlements[i]!;
    if (s.deadline?.date === fact.date || s.deadlineConflicts.some((c) => c.date === fact.date)) return false;
    this.doc.settlements[i] = { ...s, deadlineConflicts: [...s.deadlineConflicts, fact] };
    await this.save();
    return true;
  }

  async recordCandidates(candidates: readonly Candidate[], keys: readonly string[]): Promise<void> {
    this.doc.inbox.push(...candidates);
    for (const k of keys) if (!this.doc.seenKeys.includes(k)) this.doc.seenKeys.push(k);
    await this.save();
  }

  dueNudges(): Nudge[] {
    return dueNudges(this.doc.settlements, this.doc.nudges, this.today());
  }

  /** Marks nudges as delivered so they never repeat. */
  async markNudged(nudges: readonly Nudge[]): Promise<void> {
    const today = this.today();
    this.doc.nudges.push(...nudges.map((n) => toNudgeRecord(n, today)));
    await this.save();
  }

  private indexOf(id: string): number {
    const i = this.doc.settlements.findIndex((s) => s.id === id);
    if (i < 0) throw new TrackerError(`No tracked settlement "${id}". Run "settlements review" for ids.`);
    return i;
  }

  private uniqueId(base: string): string {
    let id = base;
    for (let n = 2; this.doc.settlements.some((s) => s.id === id); n++) id = `${base}-${n}`;
    return id;
  }

  private async save(): Promise<void> {
    await this.storage.save(this.doc);
  }
}
