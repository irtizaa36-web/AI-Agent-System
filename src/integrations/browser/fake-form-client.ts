import type { PageSnapshot } from "./client";
import type { FormField, FormFillingClient, SubmitFormResult } from "./form-client";

export interface FakeFormFillingClientOptions {
  /** What checkPage returns per URL. A URL with no entry gets a healthy page; an Error entry is thrown. */
  readonly pages?: ReadonlyMap<string, string | PageSnapshot | Error>;
  /** Makes submitForm throw after recording the call, like a navigation crash right after the click. */
  readonly submitError?: Error;
}

const HEALTHY_FORM_PAGE = "Return request form. ".repeat(20);

/** An in-memory FormFillingClient for tests: fixture fields per URL, and a scripted result for submitForm. */
export class FakeFormFillingClient implements FormFillingClient {
  public readonly submittedCalls: { site: string | undefined; url: string; values: Readonly<Record<string, string>>; submitSelector: string }[] = [];
  public readonly checkedUrls: string[] = [];

  constructor(
    private readonly fieldsByUrl: ReadonlyMap<string, readonly FormField[]> = new Map(),
    private readonly submitResultText: string = "Your request has been received.",
    private readonly options: FakeFormFillingClientOptions = {},
  ) {}

  async listFormFields(_site: string | undefined, url: string): Promise<readonly FormField[]> {
    return this.fieldsByUrl.get(url) ?? [];
  }

  async previewFormFill(_site: string | undefined, url: string, values: Readonly<Record<string, string>>): Promise<readonly FormField[]> {
    const fields = this.fieldsByUrl.get(url) ?? [];
    return fields.map((f) => ({ ...f, currentValue: values[f.selector] ?? f.currentValue }));
  }

  async submitForm(
    site: string | undefined,
    url: string,
    values: Readonly<Record<string, string>>,
    submitSelector: string,
  ): Promise<SubmitFormResult> {
    this.submittedCalls.push({ site, url, values, submitSelector });
    if (this.options.submitError) throw this.options.submitError;
    return { resultText: this.submitResultText };
  }

  async checkPage(_site: string | undefined, url: string): Promise<PageSnapshot> {
    this.checkedUrls.push(url);
    const page = this.options.pages?.get(url) ?? HEALTHY_FORM_PAGE;
    if (page instanceof Error) throw page;
    return typeof page === "string" ? { text: page, finalUrl: url } : page;
  }
}
