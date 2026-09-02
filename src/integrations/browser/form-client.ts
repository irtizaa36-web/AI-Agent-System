/**
 * The port for reading and filling a web form (ADR 0011). This is the
 * write-capable counterpart to BrowserClient (ADR 0007), which is
 * deliberately read-only. Unlike BrowserClient, this port isn't bound to
 * one site at construction — `site` is passed per call, so one registered
 * Tool instance works against any site a human has logged into (or none,
 * for a form that needs no login), rather than requiring new code for
 * every new retailer.
 *
 * The safe/consequential split mirrors inkbox-save-draft/send-email
 * exactly: `previewFormFill` fills fields into an in-memory page state and
 * reports back what would be submitted, without ever clicking a submit
 * control — a human reviews that exact output before `submitForm`, the
 * only operation in this port that actually clicks anything, ever runs.
 */
export interface FormField {
  readonly selector: string;
  readonly label?: string;
  readonly type: string;
  readonly currentValue?: string;
}

export interface FormFillingClient {
  /** Read-only: lists the fillable fields (and any submit controls) found on the page at `url`. */
  listFormFields(site: string | undefined, url: string): Promise<readonly FormField[]>;

  /**
   * Safe: fills `values` (selector -> value) into the page's fields and
   * returns the resulting field values for a human to review. Never
   * clicks a submit/confirm control — filling a form that's never
   * submitted has no external effect, the same way saving an email draft
   * doesn't deliver anything.
   */
  previewFormFill(site: string | undefined, url: string, values: Readonly<Record<string, string>>): Promise<readonly FormField[]>;

  /**
   * Consequential: fills `values` exactly as previewed, then clicks
   * `submitSelector`. Must only ever be called by a Tool marked
   * `requiresApproval: true`, after a human has approved these exact
   * values (ADR 0004) — this port has no way to enforce that itself, the
   * same way `send()` on InkboxClient relies on the Orchestrator's
   * approval gate rather than gating itself.
   */
  submitForm(
    site: string | undefined,
    url: string,
    values: Readonly<Record<string, string>>,
    submitSelector: string,
  ): Promise<{ readonly resultText: string }>;
}
