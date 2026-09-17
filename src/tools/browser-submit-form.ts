import type { Tool } from "./tool";
import type { FormFillingClient } from "../integrations/browser/form-client";

interface SubmitFormInput {
  readonly url: string;
  readonly values: Readonly<Record<string, string>>;
  readonly submitSelector: string;
  readonly site?: string;
}

function isSubmitFormInput(value: unknown): value is SubmitFormInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SubmitFormInput>;
  return (
    typeof v.url === "string" &&
    typeof v.values === "object" &&
    v.values !== null &&
    typeof v.submitSelector === "string" &&
    (v.site === undefined || typeof v.site === "string")
  );
}

/**
 * Whether the returns autopilot is switched on (ADR 0018). Read at Tool
 * construction, not cached at module load, so a test can set it and build
 * a Tool without the import order mattering.
 *
 * Deliberately the same shape as every other outbound capability in this
 * project: having the capability configured is not the same thing as
 * having it enabled, and the default is always off. `DIGEST_SMS_ENABLED`
 * (ADR 0016) is the precedent — an env var that must be the literal
 * string "true", where anything else, including absent, keeps the gate on.
 */
function returnsAutopilotEnabled(): boolean {
  return process.env["RETURNS_AUTOPILOT_ENABLED"] === "true";
}

/**
 * Consequential: the only operation in this project that clicks submit on
 * a real, external web page (ADR 0011).
 *
 * By default `requiresApproval` is true, which means the Orchestrator never
 * auto-executes this — it only runs via approveAndExecute, after a human
 * has matched every field exactly against what browser-fill-form-preview
 * showed them (ADR 0004's exact-match pattern, same as send-email).
 *
 * With `RETURNS_AUTOPILOT_ENABLED=true` the flag flips and the Orchestrator
 * will auto-execute it. That is a real removal of the only thing standing
 * between a model's decision and a live click on someone else's website,
 * taken deliberately per ADR 0018 for the retailer-returns domain. What the
 * env var does NOT do is make the judgment safe — the agent driving this
 * still has to stop on its own at CAPTCHAs, identity verification, and
 * anything that moves money in a direction other than back to the owner.
 * Those stops live in the agent's own instructions
 * (`.claude/agents/customer-service-steward.md`), because this Tool is
 * generic and cannot tell a return form from a checkout page.
 */
export function createBrowserSubmitFormTool(client: FormFillingClient): Tool {
  return {
    name: "browser-submit-form",
    description:
      "Fills the given field values into a web page's form and clicks the given submit control. Consequential: only ever runs after exact-match human approval of these exact values.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        values: { type: "object" },
        submitSelector: { type: "string" },
        site: { type: "string" },
      },
      required: ["url", "values", "submitSelector"],
    },
    requiresApproval: !returnsAutopilotEnabled(),
    async execute(input: unknown): Promise<string> {
      if (!isSubmitFormInput(input)) {
        throw new Error('browser-submit-form requires { "url": string, "values": {selector: string}, "submitSelector": string, "site"?: string }');
      }
      const result = await client.submitForm(input.site, input.url, input.values, input.submitSelector);
      return `submitted:true\nresultText:${result.resultText}`;
    },
  };
}
