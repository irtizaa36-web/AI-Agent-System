/**
 * Inkbox's Contacts API — the organization-wide contact book Inkbox itself
 * builds from every inbound/outbound message. Confirmed against the live
 * API (GET /contacts/lookup, PATCH /contacts/{id}) on this identity's real
 * data, not guessed — same discipline as sms-client.ts and
 * imessage-client.ts: base `https://inkbox.ai/api/v1/contacts`, header
 * `X-API-Key`, no `agent_identity_id` param (organization scoping is
 * implicit in the key, unlike the iMessage API).
 *
 * Narrow on purpose: lookup, update, and merge, because that's what this
 * project actually needs today (enriching a known correspondent's contact
 * record and consolidating the duplicate Inkbox auto-creates per channel —
 * see `jobs enrich-contact` in jobs-feedback.ts). Inkbox also exposes a
 * `contact_rules` blacklist and a `review_status`/`is_confirmed` distinction
 * on every contact — both look like the natural "is this real correspondence
 * or retail noise" signal this project could use — but neither is writable
 * through the documented API: there is no create/update endpoint for rules,
 * and `PATCH /contacts/{id}` does not accept `review_status` or
 * `is_confirmed` (confirmed against a live contact object's actual field
 * list, not assumed absent). That's a real gap in what Inkbox exposes, not
 * something to work around by guessing at an undocumented field.
 *
 * `merge` is confirmed against Inkbox's own docs (contacts/manage.md and
 * contacts/memory.md), not a live payload — there was nothing safe to test
 * a merge against without actually merging real contacts, so the request
 * shape here is "as documented," and any mismatch will surface as a loud
 * API error rather than a silent wrong merge.
 */

const DEFAULT_BASE_URL = "https://inkbox.ai";
const API_ROOT_SUFFIX = "/api/v1/contacts";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ContactEmail {
  readonly value: string;
  readonly label?: string | null;
  readonly isPrimary?: boolean;
}

export interface ContactPhone {
  readonly valueE164: string;
  readonly label?: string | null;
  readonly isPrimary?: boolean;
}

export interface ContactCustomField {
  readonly label: string;
  readonly value: string;
}

export interface Contact {
  readonly id: string;
  readonly preferredName: string | null;
  readonly emails: readonly ContactEmail[];
  readonly phones: readonly ContactPhone[];
  readonly customFields: readonly ContactCustomField[];
  readonly notes: string | null;
}

/** Every field is optional and replaces the whole array/value it names — PATCH semantics match Inkbox's own (send the complete new array, not a delta). */
export interface ContactPatch {
  readonly preferredName?: string;
  readonly emails?: readonly ContactEmail[];
  readonly phones?: readonly ContactPhone[];
  readonly customFields?: readonly ContactCustomField[];
  readonly notes?: string | null;
}

export class InkboxContactApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly detail: string,
  ) {
    super(`Inkbox contacts API error (HTTP ${statusCode}): ${detail}`);
    this.name = "InkboxContactApiError";
  }
}

export interface ContactClient {
  /** Reverse-lookup by exact email or phone (E.164). Empty array means no match — never null, never a guess at "probably this one". */
  lookup(query: { readonly email?: string; readonly phone?: string }): Promise<readonly Contact[]>;
  /** Replaces the named fields on one contact. Omitted fields are left untouched. */
  update(contactId: string, patch: ContactPatch): Promise<Contact>;
  /**
   * Absorbs `losingContactIds` into `survivorId` — the survivor keeps its
   * own identifiers/correspondence/memories plus everything the losing
   * contacts had. Per Inkbox's docs this is a real structural write with no
   * documented undo, so a caller should treat it the way this project treats
   * any other hard-to-reverse action: confirmed, not automatic-by-default.
   */
  merge(survivorId: string, losingContactIds: readonly string[]): Promise<Contact>;
}

export interface InkboxContactClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

function toEmail(raw: Record<string, unknown>): ContactEmail {
  return { value: String(raw["value"] ?? ""), label: (raw["label"] as string | null) ?? null, isPrimary: raw["is_primary"] === true };
}

function toPhone(raw: Record<string, unknown>): ContactPhone {
  return { valueE164: String(raw["value_e164"] ?? ""), label: (raw["label"] as string | null) ?? null, isPrimary: raw["is_primary"] === true };
}

function toCustomField(raw: Record<string, unknown>): ContactCustomField {
  return { label: String(raw["label"] ?? ""), value: String(raw["value"] ?? "") };
}

function toContact(raw: Record<string, unknown>): Contact {
  return {
    id: String(raw["id"] ?? ""),
    preferredName: typeof raw["preferred_name"] === "string" ? raw["preferred_name"] : null,
    emails: Array.isArray(raw["emails"]) ? raw["emails"].map((e) => toEmail(e as Record<string, unknown>)) : [],
    phones: Array.isArray(raw["phones"]) ? raw["phones"].map((p) => toPhone(p as Record<string, unknown>)) : [],
    customFields: Array.isArray(raw["custom_fields"]) ? raw["custom_fields"].map((f) => toCustomField(f as Record<string, unknown>)) : [],
    notes: typeof raw["notes"] === "string" ? raw["notes"] : null,
  };
}

function fromPatch(patch: ContactPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.preferredName !== undefined) body["preferred_name"] = patch.preferredName;
  if (patch.emails !== undefined) body["emails"] = patch.emails.map((e) => ({ value: e.value, label: e.label ?? null, is_primary: e.isPrimary ?? false }));
  if (patch.phones !== undefined) body["phones"] = patch.phones.map((p) => ({ value_e164: p.valueE164, label: p.label ?? null, is_primary: p.isPrimary ?? false }));
  if (patch.customFields !== undefined) body["custom_fields"] = patch.customFields.map((f) => ({ label: f.label, value: f.value }));
  if (patch.notes !== undefined) body["notes"] = patch.notes;
  return body;
}

export class InkboxContactClient implements ContactClient {
  constructor(private readonly options: InkboxContactClientOptions) {}

  private apiRoot(): string {
    return `${(this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}${API_ROOT_SUFFIX}`;
  }

  private async request(method: string, url: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { "X-API-Key": this.options.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let detail: unknown;
      try {
        detail = await response.json();
      } catch {
        detail = response.statusText;
      }
      throw new InkboxContactApiError(response.status, typeof detail === "string" ? detail : JSON.stringify(detail));
    }

    return response.json();
  }

  async lookup(query: { readonly email?: string; readonly phone?: string }): Promise<readonly Contact[]> {
    const params = new URLSearchParams();
    if (query.email) params.set("email", query.email);
    if (query.phone) params.set("phone", query.phone);
    const result = await this.request("GET", `${this.apiRoot()}/lookup?${params.toString()}`);
    if (!Array.isArray(result)) return [];
    return result.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null).map(toContact);
  }

  async update(contactId: string, patch: ContactPatch): Promise<Contact> {
    const result = await this.request("PATCH", `${this.apiRoot()}/${encodeURIComponent(contactId)}`, fromPatch(patch));
    return toContact(result as Record<string, unknown>);
  }

  async merge(survivorId: string, losingContactIds: readonly string[]): Promise<Contact> {
    const result = await this.request("POST", `${this.apiRoot()}/${encodeURIComponent(survivorId)}/merge`, { losing_contact_ids: losingContactIds });
    return toContact(result as Record<string, unknown>);
  }
}

/** Deterministic stand-in for tests — seeded contacts, records every update, never touches the network. */
export class FakeContactClient implements ContactClient {
  readonly updates: { contactId: string; patch: ContactPatch }[] = [];
  private readonly contacts: Contact[];

  constructor(seed: readonly Contact[] = []) {
    this.contacts = [...seed];
  }

  async lookup(query: { readonly email?: string; readonly phone?: string }): Promise<readonly Contact[]> {
    return this.contacts.filter(
      (c) => (query.email && c.emails.some((e) => e.value.toLowerCase() === query.email?.toLowerCase())) || (query.phone && c.phones.some((p) => p.valueE164 === query.phone)),
    );
  }

  async update(contactId: string, patch: ContactPatch): Promise<Contact> {
    this.updates.push({ contactId, patch });
    const index = this.contacts.findIndex((c) => c.id === contactId);
    if (index === -1) throw new InkboxContactApiError(404, "not found");
    const current = this.contacts[index] as Contact;
    const updated: Contact = {
      ...current,
      preferredName: patch.preferredName ?? current.preferredName,
      emails: patch.emails ?? current.emails,
      phones: patch.phones ?? current.phones,
      customFields: patch.customFields ?? current.customFields,
      notes: patch.notes !== undefined ? patch.notes : current.notes,
    };
    this.contacts[index] = updated;
    return updated;
  }

  async merge(survivorId: string, losingContactIds: readonly string[]): Promise<Contact> {
    const survivorIndex = this.contacts.findIndex((c) => c.id === survivorId);
    if (survivorIndex === -1) throw new InkboxContactApiError(404, "survivor not found");
    let survivor = this.contacts[survivorIndex] as Contact;

    for (const losingId of losingContactIds) {
      const losingIndex = this.contacts.findIndex((c) => c.id === losingId);
      if (losingIndex === -1) throw new InkboxContactApiError(404, `losing contact ${losingId} not found`);
      const losing = this.contacts[losingIndex] as Contact;
      survivor = {
        ...survivor,
        preferredName: survivor.preferredName ?? losing.preferredName,
        emails: [...survivor.emails, ...losing.emails.filter((e) => !survivor.emails.some((se) => se.value === e.value))],
        phones: [...survivor.phones, ...losing.phones.filter((p) => !survivor.phones.some((sp) => sp.valueE164 === p.valueE164))],
        customFields: [...survivor.customFields, ...losing.customFields],
      };
      this.contacts.splice(losingIndex, 1);
    }

    const finalIndex = this.contacts.findIndex((c) => c.id === survivorId);
    this.contacts[finalIndex as number] = survivor;
    return survivor;
  }
}

/** The real client when INKBOX_API_KEY is configured, otherwise `undefined` — never a half-configured client, same pattern as the other Inkbox clients in this project. */
export function createContactClientFromEnv(): ContactClient | undefined {
  const apiKey = process.env["INKBOX_API_KEY"];
  if (!apiKey) return undefined;

  return new InkboxContactClient({ apiKey, baseUrl: process.env["INKBOX_API_BASE_URL"] });
}
