import type { EmailAddress } from "./client";

const OWNER_FORWARD_ENV_VAR = "OWNER_FORWARD_EMAIL";

/** Unset by design until explicitly configured — never hard-code, never prompt for it. */
export function getOwnerForwardAddress(): string | undefined {
  const value = process.env[OWNER_FORWARD_ENV_VAR];
  return value && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;
}

function includesAddress(addresses: readonly EmailAddress[], address: string): boolean {
  return addresses.some((a) => a.address.toLowerCase() === address.toLowerCase());
}

/**
 * The BCC list an outbound email should actually carry: the owner's forward
 * address appended, unless forwarding is disabled (unset env var), the
 * owner is already a direct recipient (avoid a duplicate copy), or the
 * owner *is* the sending mailbox (avoid a pointless self-BCC). Pure and
 * total — no I/O — so the exact-approval preview and the actual send can
 * both call it and always agree.
 */
export function computeOutboundBcc(
  to: readonly EmailAddress[],
  existingBcc: readonly EmailAddress[],
  fromAddress: string,
): readonly EmailAddress[] {
  const owner = getOwnerForwardAddress();
  if (!owner) return existingBcc;
  if (owner === fromAddress.toLowerCase()) return existingBcc;
  if (includesAddress(to, owner) || includesAddress(existingBcc, owner)) return existingBcc;
  return [...existingBcc, { address: owner }];
}

/**
 * Whether a message sitting in the mailbox should be forwarded to the owner
 * as *inbound* mail: forwarding must be enabled, the message must not have
 * originated from the owner's own address (loop prevention), and it must
 * not be our own outbound copy of something we sent (that copy was already
 * BCC'd at send time — forwarding it too would duplicate it).
 */
export function shouldForwardInbound(
  fromAddress: string,
  mailboxAddress: string,
): { forward: boolean; reason?: string } {
  const owner = getOwnerForwardAddress();
  if (!owner) return { forward: false, reason: "OWNER_FORWARD_EMAIL is not configured" };
  if (owner === fromAddress.toLowerCase()) {
    return { forward: false, reason: "message originated from the owner's own forwarding address" };
  }
  if (fromAddress.toLowerCase() === mailboxAddress.toLowerCase()) {
    return { forward: false, reason: "message is our own outbound copy, already BCC'd at send time" };
  }
  return { forward: true };
}
