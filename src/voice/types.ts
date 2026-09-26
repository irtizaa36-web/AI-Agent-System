/**
 * Shared shapes for the Google Voice channel (ADR 0023). Everything the
 * module persists fits in one VoiceStateDocument, stored under the
 * gitignored .orchestrator/voice/ directory. No verification code value is
 * ever part of any persisted shape.
 */

/** How an inbound Voice email arrives: the agent reads it from Gmail and hands it over as this JSON. */
export interface VoiceEmailInput {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  /** The address a reply goes to. For a forwarded text, replying to it sends an SMS from the Voice number. */
  readonly replyTo?: string;
  readonly subject: string;
  readonly body: string;
  readonly receivedAt: string;
}

export type VoiceInboundKind = "text" | "voicemail";

export interface VoiceInbound {
  readonly kind: VoiceInboundKind;
  readonly messageId: string;
  readonly threadId: string;
  /** The other party's number as Google Voice printed it in the subject, e.g. "(555) 010-0000". */
  readonly counterparty: string;
  /** Where a reply is sent; only set for texts. */
  readonly replyAddress?: string;
  /** The message text (a text's body or a voicemail transcript), without Google's footer. */
  readonly text: string;
  readonly receivedAt: string;
}

export type PendingStatus = "open" | "consumed" | "cancelled";

/** A verification the agent itself started. It records the service, never the code. */
export interface PendingVerification {
  readonly id: string;
  readonly service: string;
  /** Names that count as the service being named in a message (the service name itself included). */
  readonly aliases: readonly string[];
  readonly purpose: string;
  readonly startedAt: string;
  readonly status: PendingStatus;
  readonly closedAt?: string;
  /** The message whose code was used; the code itself is not recorded. */
  readonly consumedFromMessageId?: string;
}

export type AlertReason =
  | "no-pending-verification"
  | "pending-expired"
  | "service-not-named"
  | "service-mismatch"
  | "ambiguous-service"
  | "scam-suspected";

/** Something Toozy has to look at. Text is always stored with code-like digit runs redacted. */
export interface SecurityAlert {
  readonly id: string;
  readonly at: string;
  readonly reason: AlertReason;
  readonly detail: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly counterparty: string;
  readonly redactedText: string;
  /** Scam indicators, for reason "scam-suspected". */
  readonly flags?: readonly string[];
  readonly acknowledged: boolean;
}

export interface Listing {
  readonly id: string;
  readonly title: string;
  /** Whole dollars, as listed. */
  readonly price: number;
  readonly priceFirm: boolean;
  /** Local pickup only. A buyer asking for shipping on a local listing is a scam signal. */
  readonly localOnly: boolean;
  /** e.g. ["Saturday 10am-2pm", "weekdays after 6pm"]. */
  readonly pickupWindows: readonly string[];
  /** A public meeting area, never a home address, e.g. "the Target on Main St". */
  readonly pickupArea?: string;
  readonly status: "available" | "pending" | "sold";
}

/** "released" = handed to the outbox for the agent's Gmail connector to transmit; "sent" = confirmed gone. */
export type DraftStatus = "pending_approval" | "approved" | "rejected" | "released" | "sent";

export interface ReplyDraft {
  readonly id: string;
  readonly revision: number;
  readonly threadId: string;
  readonly inReplyToMessageId: string;
  readonly replyAddress: string;
  readonly counterparty: string;
  readonly listingId: string;
  /** The listing's status when the draft was written; send refuses if it has changed since. */
  readonly listingStatus: Listing["status"];
  readonly intents: readonly string[];
  readonly body: string;
  readonly status: DraftStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** sha256 of the exact body Toozy approved; send re-checks it. */
  readonly approvedBodySha256?: string;
  readonly approvedAt?: string;
  readonly releasedAt?: string;
  readonly sentAt?: string;
  readonly sendReference?: string;
}

export interface VoiceStateDocument {
  readonly version: 1;
  readonly pending: readonly PendingVerification[];
  readonly alerts: readonly SecurityAlert[];
  readonly listings: readonly Listing[];
  /** threadId → listingId, set by Toozy when a buyer's thread is about a specific listing. */
  readonly threadListings: Readonly<Record<string, string>>;
  readonly drafts: readonly ReplyDraft[];
  /** Message ids already handled, so re-ingesting the same email never acts twice. */
  readonly processedMessageIds: readonly string[];
}

export function emptyVoiceState(): VoiceStateDocument {
  return { version: 1, pending: [], alerts: [], listings: [], threadListings: {}, drafts: [], processedMessageIds: [] };
}

/** Switches are on only when the variable is exactly "true" (the ADR 0016/0018 shape). */
export function isEnabled(value: string | undefined): boolean {
  return value === "true";
}

export const CODE_BROKER_ENV = "VOICE_CODE_BROKER_ENABLED";
export const REPLY_DRAFTER_ENV = "VOICE_REPLY_DRAFTER_ENABLED";
export const REPLY_SEND_ENV = "VOICE_REPLY_SEND_ENABLED";
