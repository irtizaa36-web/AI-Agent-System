import type { PageSnapshot } from "./client";
import type { FormField, FormFillingClient, SubmitFormResult } from "./form-client";
import { CircuitBreaker, classifyPage, DEFAULT_CIRCUIT_BREAKER_THRESHOLD, domainOf, isFailedStatus, type ClassifyOptions, type PageStatus } from "./page-health";

export interface HealthCheckedFormOptions {
  readonly classify?: ClassifyOptions;
  readonly circuitBreakerThreshold?: number;
}

/**
 * Wraps a FormFillingClient with the blocked-vs-quiet checks from ADR 0026,
 * adapted for a port that can submit:
 *
 * - Before filling (preview or submit), the form page is loaded read-only
 *   and classified. A blocked page aborts before anything is filled or
 *   clicked.
 * - A submit is attempted exactly once. There is no retry, ever: a second
 *   click on a return or payment form could file a duplicate request.
 * - A blank, error-shell, or otherwise ambiguous page after the click (or
 *   a crash during it) is reported as outcome `unknown`, so a human checks
 *   whether it went through. It is never reported as a success or a clean
 *   failure.
 * - A per-domain circuit breaker, held for the life of this instance (one
 *   run), refuses further submissions to a domain after three consecutive
 *   blocked or unknown results.
 *
 * Approval gating is untouched: browser-submit-form still decides whether
 * a human must approve (ADR 0004, ADR 0018). This wrapper only adds
 * refusals, never removes one.
 */
export class HealthCheckedFormFillingClient implements FormFillingClient {
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly inner: FormFillingClient,
    private readonly options: HealthCheckedFormOptions = {},
  ) {
    this.breaker = new CircuitBreaker(options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
  }

  listFormFields(site: string | undefined, url: string): Promise<readonly FormField[]> {
    return this.inner.listFormFields(site, url);
  }

  async previewFormFill(site: string | undefined, url: string, values: Readonly<Record<string, string>>): Promise<readonly FormField[]> {
    await this.preFillCheck(site, url, "preview");
    return this.inner.previewFormFill(site, url, values);
  }

  async submitForm(site: string | undefined, url: string, values: Readonly<Record<string, string>>, submitSelector: string): Promise<SubmitFormResult> {
    const domain = domainOf(url);
    if (this.breaker.isOpen(domain)) {
      throw new Error(
        `Submission refused: ${domain} tripped its circuit breaker after ${this.breaker.consecutiveFailures(domain)} consecutive blocked or unverified results this run. Nothing was filled or clicked. A human should check the site before trying again.`,
      );
    }
    await this.preFillCheck(site, url, "submit");

    let result: SubmitFormResult;
    try {
      result = await this.inner.submitForm(site, url, values, submitSelector);
    } catch (error) {
      this.breaker.record(domain, "error");
      return {
        resultText: "",
        outcome: "unknown",
        note: `The submit was attempted once and then failed (${(error as Error).message}). It may or may not have gone through, and it was not retried. A human must check the site or the confirmation email.`,
      };
    }

    const status: PageStatus = classifyPage({ text: result.resultText, ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}) }, { requestedUrl: url, ...this.options.classify });
    if (status === "ok") {
      this.breaker.record(domain, "ok");
      return { ...result, outcome: "submitted" };
    }
    this.breaker.record(domain, "blocked");
    return {
      ...result,
      outcome: "unknown",
      note: `The submit was attempted once, but the page after it came back ${status} (blank, error shell, login/challenge redirect, or no clear confirmation). It was not retried. A human must check whether it went through.`,
    };
  }

  async checkPage(site: string | undefined, url: string): Promise<PageSnapshot> {
    if (!this.inner.checkPage) throw new Error("The wrapped form client has no read-only checkPage operation.");
    return this.inner.checkPage(site, url);
  }

  private async preFillCheck(site: string | undefined, url: string, action: "preview" | "submit"): Promise<void> {
    if (!this.inner.checkPage) return;
    const domain = domainOf(url);
    let status: PageStatus;
    let detail = "";
    try {
      const snapshot = await this.inner.checkPage(site, url);
      status = classifyPage(snapshot, { requestedUrl: url, ...this.options.classify });
    } catch (error) {
      status = "error";
      detail = ` (${(error as Error).message})`;
    }
    if (isFailedStatus(status)) {
      this.breaker.record(domain, status);
      throw new Error(
        `Aborted before ${action === "submit" ? "submitting" : "filling"}: the form page at ${url} came back ${status}${detail} on its pre-fill health check. Nothing was filled or clicked.`,
      );
    }
  }
}
