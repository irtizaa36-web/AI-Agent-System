import { createHash, randomUUID } from "node:crypto";
import { readIntents, type RoutineIntent } from "./intent";
import { classifyScam, type ScamFlag } from "./scam";
import type { VoiceStateStore } from "./store";
import type { VoiceReplyTransport } from "./transport";
import type { Listing, ReplyDraft, SecurityAlert, VoiceInbound, VoiceStateDocument } from "./types";
import { looksLikeVerificationText, makeAlert } from "./verification";

/**
 * The approval-gated SMS reply drafter (ADR 0023).
 *
 * For each inbound text, in this order:
 *   1. Verification-shaped texts are never drafted against; they belong to the broker.
 *   2. The scam classifier runs. Any flag means an alert and no draft.
 *   3. The text must be about a known listing, and ask only routine questions.
 *   4. A reply is written from fixed templates. No model call, no free text.
 *
 * A draft goes out only after Toozy approves its exact text (the
 * exact-match shape of `inkbox approve-send`, ADR 0004). Send re-checks the
 * approved text's hash, the send switch, and whether the listing's status
 * has changed since the draft was written.
 */

export type DraftOutcome =
  | { readonly kind: "disabled" }
  | { readonly kind: "not-a-text" }
  | { readonly kind: "already-processed" }
  | { readonly kind: "verification-text" }
  | { readonly kind: "scam-alert"; readonly alert: SecurityAlert; readonly flags: readonly ScamFlag[] }
  | { readonly kind: "needs-toozy"; readonly reasons: readonly string[] }
  | { readonly kind: "drafted"; readonly draft: ReplyDraft };

export class DraftError extends Error {}

export interface DrafterOptions {
  readonly draftingEnabled: boolean;
  readonly sendingEnabled: boolean;
  readonly transport: VoiceReplyTransport;
  readonly now?: () => Date;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** The only text a draft can contain. Nothing from the buyer's message is echoed back. */
export function composeReply(listing: Listing, intents: readonly RoutineIntent[]): string {
  if (listing.status !== "available") {
    return listing.status === "sold"
      ? `Sorry, the ${listing.title} has sold.`
      : `Sorry, the ${listing.title} has a pickup pending right now. I'll reach out if that falls through.`;
  }
  const parts: string[] = [];
  if (intents.includes("availability")) parts.push(`Hi! Yes, the ${listing.title} is still available.`);
  else parts.push("Hi!");
  if (intents.includes("price")) parts.push(`It's $${listing.price}${listing.priceFirm ? ", and the price is firm" : ""}.`);
  if (intents.includes("pickup")) {
    const where = listing.pickupArea ? ` at ${listing.pickupArea}` : "";
    parts.push(
      listing.pickupWindows.length > 0
        ? `Pickup${where} works ${joinList(listing.pickupWindows)}. What works best for you?`
        : `Happy to set up a pickup${where}. What day and time work for you?`,
    );
  }
  return parts.join(" ");
}

function resolveListing(doc: VoiceStateDocument, threadId: string): Listing | undefined {
  const linked = doc.threadListings[threadId];
  if (linked) return doc.listings.find((l) => l.id === linked);
  const open = doc.listings.filter((l) => l.status !== "sold");
  return open.length === 1 ? open[0] : undefined;
}

export class ReplyDrafter {
  private readonly now: () => Date;

  constructor(
    private readonly store: VoiceStateStore,
    private readonly options: DrafterOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async handle(message: VoiceInbound): Promise<DraftOutcome> {
    if (!this.options.draftingEnabled) return { kind: "disabled" };
    if (message.kind !== "text" || !message.replyAddress) return { kind: "not-a-text" };
    if (looksLikeVerificationText(message.text) && classifyScam(message.text, undefined).length === 0) return { kind: "verification-text" };

    let outcome: DraftOutcome = { kind: "already-processed" };
    await this.store.update((doc) => {
      if (doc.processedMessageIds.includes(message.messageId)) return doc;
      const processed = [...doc.processedMessageIds, message.messageId];
      const listing = resolveListing(doc, message.threadId);

      const flags = classifyScam(message.text, listing);
      if (flags.length > 0) {
        const alert = makeAlert(message, "scam-suspected", `Scam indicators: ${flags.join(", ")}. No reply was drafted.`, this.now(), flags);
        outcome = { kind: "scam-alert", alert, flags };
        return { ...doc, processedMessageIds: processed, alerts: [...doc.alerts, alert] };
      }

      const reasons: string[] = [];
      if (!listing)
        reasons.push(
          doc.listings.length === 0
            ? "no listings are recorded (voice listing add)"
            : "the thread isn't linked to a listing and more than one is open (voice link)",
        );
      const intents = readIntents(message.text);
      reasons.push(...intents.needsToozy);
      if (reasons.length > 0 || !listing) {
        outcome = { kind: "needs-toozy", reasons };
        return { ...doc, processedMessageIds: processed };
      }

      const at = this.now().toISOString();
      const draft: ReplyDraft = {
        id: `draft-${randomUUID().slice(0, 8)}`,
        revision: 1,
        threadId: message.threadId,
        inReplyToMessageId: message.messageId,
        replyAddress: message.replyAddress!,
        counterparty: message.counterparty,
        listingId: listing.id,
        listingStatus: listing.status,
        intents: intents.routine,
        body: composeReply(listing, intents.routine),
        status: "pending_approval",
        createdAt: at,
        updatedAt: at,
      };
      outcome = { kind: "drafted", draft };
      return { ...doc, processedMessageIds: processed, drafts: [...doc.drafts, draft] };
    });
    return outcome;
  }

  /** Toozy's tap: the exact text shown, and the revision it was shown at. Anything else is refused. */
  async approve(draftId: string, revision: number, exactBody: string): Promise<ReplyDraft> {
    return this.change(draftId, (draft) => {
      if (draft.status !== "pending_approval") throw new DraftError(`Draft "${draftId}" is ${draft.status}; only a draft waiting for approval can be approved.`);
      if (draft.revision !== revision) throw new DraftError(`Draft "${draftId}" is at revision ${draft.revision}, not ${revision}. Review the current text and approve that.`);
      if (draft.body !== exactBody) throw new DraftError(`The approved text doesn't match draft "${draftId}" exactly. Nothing was approved.`);
      const at = this.now().toISOString();
      return { ...draft, status: "approved", approvedBodySha256: sha256(draft.body), approvedAt: at, updatedAt: at };
    });
  }

  /** Toozy rewrites the text. The new revision needs its own approval. */
  async edit(draftId: string, body: string): Promise<ReplyDraft> {
    const text = body.trim();
    if (text.length === 0) throw new DraftError("A reply can't be empty.");
    if (text.length > 480) throw new DraftError("Keep replies under 480 characters (three SMS segments).");
    return this.change(draftId, (draft) => {
      if (draft.status !== "pending_approval" && draft.status !== "approved") throw new DraftError(`Draft "${draftId}" is ${draft.status} and can't be edited.`);
      const { approvedBodySha256: _hash, approvedAt: _at, ...rest } = draft;
      return { ...rest, body: text, revision: draft.revision + 1, status: "pending_approval", updatedAt: this.now().toISOString() };
    });
  }

  async reject(draftId: string): Promise<ReplyDraft> {
    return this.change(draftId, (draft) => {
      if (draft.status === "released" || draft.status === "sent") throw new DraftError(`Draft "${draftId}" is already ${draft.status}.`);
      return { ...draft, status: "rejected", updatedAt: this.now().toISOString() };
    });
  }

  /**
   * Sends one approved draft. There is no retry: if the transport fails, the
   * draft stays approved and the error is reported, so a second send is
   * always a deliberate decision.
   */
  async send(draftId: string): Promise<ReplyDraft> {
    if (!this.options.sendingEnabled) throw new DraftError('Sending is off (VOICE_REPLY_SEND_ENABLED is not "true"). Nothing was sent.');
    const doc = await this.store.load();
    const draft = doc.drafts.find((d) => d.id === draftId);
    if (!draft) throw new DraftError(`No draft "${draftId}".`);
    if (draft.status !== "approved" || !draft.approvedBodySha256) throw new DraftError(`Draft "${draftId}" is ${draft.status}. Only a draft Toozy approved can be sent.`);
    if (sha256(draft.body) !== draft.approvedBodySha256) throw new DraftError(`Draft "${draftId}" changed after approval. Nothing was sent.`);
    const listing = doc.listings.find((l) => l.id === draft.listingId);
    if (!listing || listing.status !== draft.listingStatus)
      throw new DraftError(`The listing's status changed since draft "${draftId}" was written. Reject it and let a new draft be made.`);

    const result = await this.options.transport.send({
      draftId: draft.id,
      threadId: draft.threadId,
      inReplyToMessageId: draft.inReplyToMessageId,
      to: draft.replyAddress,
      body: draft.body,
    });
    const at = this.now().toISOString();
    return this.change(draftId, (current) => ({
      ...current,
      status: result.delivered ? "sent" : "released",
      ...(result.delivered ? { sentAt: at } : { releasedAt: at }),
      sendReference: result.reference,
      updatedAt: at,
    }));
  }

  /** Records that the agent's Gmail connector transmitted a released reply. */
  async markSent(draftId: string, reference: string): Promise<ReplyDraft> {
    if (reference.trim().length === 0) throw new DraftError("Give the Gmail message id of the sent reply.");
    return this.change(draftId, (draft) => {
      if (draft.status !== "released") throw new DraftError(`Draft "${draftId}" is ${draft.status}; only a released draft can be marked sent.`);
      const at = this.now().toISOString();
      return { ...draft, status: "sent", sentAt: at, sendReference: reference.trim(), updatedAt: at };
    });
  }

  async drafts(): Promise<readonly ReplyDraft[]> {
    return (await this.store.load()).drafts;
  }

  // ── listings ──────────────────────────────────────────────────────────

  async addListing(listing: Listing): Promise<Listing> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(listing.id)) throw new DraftError("Listing ids are lowercase letters, digits and dashes, e.g. couch-2026.");
    if (listing.title.trim().length === 0) throw new DraftError("A listing needs a title.");
    if (!Number.isInteger(listing.price) || listing.price < 0) throw new DraftError("Price must be a whole number of dollars.");
    await this.store.update((doc) => {
      if (doc.listings.some((l) => l.id === listing.id)) throw new DraftError(`Listing "${listing.id}" already exists.`);
      return { ...doc, listings: [...doc.listings, listing] };
    });
    return listing;
  }

  async setListingStatus(id: string, status: Listing["status"]): Promise<Listing> {
    let updated: Listing | undefined;
    await this.store.update((doc) => {
      const found = doc.listings.find((l) => l.id === id);
      if (!found) throw new DraftError(`No listing "${id}".`);
      updated = { ...found, status };
      return { ...doc, listings: doc.listings.map((l) => (l.id === id ? updated! : l)) };
    });
    return updated!;
  }

  async linkThread(threadId: string, listingId: string): Promise<void> {
    await this.store.update((doc) => {
      if (!doc.listings.some((l) => l.id === listingId)) throw new DraftError(`No listing "${listingId}".`);
      return { ...doc, threadListings: { ...doc.threadListings, [threadId]: listingId } };
    });
  }

  async listings(): Promise<readonly Listing[]> {
    return (await this.store.load()).listings;
  }

  private async change(draftId: string, fn: (draft: ReplyDraft) => ReplyDraft): Promise<ReplyDraft> {
    let changed: ReplyDraft | undefined;
    await this.store.update((doc) => {
      const draft = doc.drafts.find((d) => d.id === draftId);
      if (!draft) throw new DraftError(`No draft "${draftId}".`);
      changed = fn(draft);
      return { ...doc, drafts: doc.drafts.map((d) => (d.id === draftId ? changed! : d)) };
    });
    return changed!;
  }
}
