import type { FormField, FormFillingClient } from "./form-client";

/** An in-memory FormFillingClient for tests: fixture fields per URL, and a scripted result for submitForm. */
export class FakeFormFillingClient implements FormFillingClient {
  public readonly submittedCalls: { site: string | undefined; url: string; values: Readonly<Record<string, string>>; submitSelector: string }[] = [];

  constructor(
    private readonly fieldsByUrl: ReadonlyMap<string, readonly FormField[]> = new Map(),
    private readonly submitResultText: string = "Your request has been received.",
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
  ): Promise<{ readonly resultText: string }> {
    this.submittedCalls.push({ site, url, values, submitSelector });
    return { resultText: this.submitResultText };
  }
}
