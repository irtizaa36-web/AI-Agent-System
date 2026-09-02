import type { FormField, FormFillingClient } from "./form-client";
import { browserSessionPath, hasBrowserSession } from "./session";

/**
 * Runs entirely inside the browser page (via page.evaluate) — must be a
 * plain, self-contained function with no closure over outer variables and
 * no imports, since Playwright serializes it to run in a separate JS
 * context with only the DOM available.
 */
function collectFormFields(): { selector: string; label?: string; type: string; currentValue?: string }[] {
  const elements = Array.from(document.querySelectorAll("input, select, textarea, button"));
  const results: { selector: string; label?: string; type: string; currentValue?: string }[] = [];

  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    const inputEl = el as HTMLInputElement;
    const type = tag === "input" ? inputEl.type || "text" : tag === "button" ? "button" : tag;
    if (type === "hidden") continue;

    const id = el.id;
    const name = el.getAttribute("name");
    const selector = id ? `#${CSS.escape(id)}` : name ? `[name="${CSS.escape(name)}"]` : undefined;
    if (!selector) continue;

    let label: string | undefined;
    if (id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      label = labelEl?.textContent?.trim() || undefined;
    }
    if (!label) label = el.getAttribute("aria-label") || el.getAttribute("placeholder") || (tag === "button" ? el.textContent?.trim() : undefined) || undefined;

    const currentValue = tag === "button" ? undefined : inputEl.value || undefined;
    results.push({ selector, label, type, currentValue });
  }

  return results;
}

/**
 * The Playwright-backed FormFillingClient (ADR 0011). Not bound to one
 * site at construction, unlike RealBrowserClient — `site` is optional and
 * per-call, since a return/refund form frequently needs no login at all.
 */
export class RealFormFillingClient implements FormFillingClient {
  private async withPage<T>(site: string | undefined, url: string, fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const context = site && hasBrowserSession(site) ? await browser.newContext({ storageState: browserSessionPath(site) }) : await browser.newContext();
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle" });
      return await fn(page);
    } finally {
      await browser.close();
    }
  }

  async listFormFields(site: string | undefined, url: string): Promise<readonly FormField[]> {
    return this.withPage(site, url, (page) => page.evaluate(collectFormFields));
  }

  async previewFormFill(site: string | undefined, url: string, values: Readonly<Record<string, string>>): Promise<readonly FormField[]> {
    return this.withPage(site, url, async (page) => {
      await fillFields(page, values);
      return page.evaluate(collectFormFields);
    });
  }

  async submitForm(
    site: string | undefined,
    url: string,
    values: Readonly<Record<string, string>>,
    submitSelector: string,
  ): Promise<{ readonly resultText: string }> {
    return this.withPage(site, url, async (page) => {
      await fillFields(page, values);
      await page.click(submitSelector);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const resultText = await page.evaluate(() => document.body.innerText);
      return { resultText };
    });
  }
}

async function fillFields(page: import("playwright").Page, values: Readonly<Record<string, string>>): Promise<void> {
  for (const [selector, value] of Object.entries(values)) {
    const locator = page.locator(selector).first();
    const tagName = await locator.evaluate((el) => el.tagName.toLowerCase());
    if (tagName === "select") {
      await locator.selectOption(value);
    } else if (tagName === "input" && (await locator.evaluate((el) => (el as HTMLInputElement).type)) === "checkbox") {
      if (value === "true") await locator.check();
      else await locator.uncheck();
    } else {
      await locator.fill(value);
    }
  }
}
