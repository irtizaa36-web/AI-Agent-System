import type { TrackerDocument } from "./types";

/**
 * Message templates with automatic seller-constraint injection (ADR 0024).
 *
 * Tone: friendly, brief, casual, authentic — aggressive + authentic on
 * listings, per Toozy. Active `pickup` constraints (e.g. the carry
 * constraint) are appended to every pickup-related message automatically so the
 * owner never retypes them.
 *
 * Hard rule: no template may reveal the apartment street address. Templates
 * use "{{meetup}}" (Highland Village area / public meetup language) and
 * render() throws if address-like markers appear in the final text.
 */

export interface TemplateDef {
  readonly name: string;
  readonly pickupRelated: boolean;
  readonly body: string;
}

const TEMPLATES: Record<string, TemplateDef> = {
  "pickup-confirm": {
    name: "pickup-confirm",
    pickupRelated: true,
    body: "Hey {{name}}! {{pickupTime}} works — see you then. It's ${{price}} firm, {{payment}} please. We'll meet {{meetup}}.",
  },
  "price-firm": {
    name: "price-firm",
    pickupRelated: false,
    body: "Hey {{name}} — price is firm at ${{price}}, no wiggle room on this one. Still interested?",
  },
  "rental-terms": {
    name: "rental-terms",
    pickupRelated: false,
    body: "Hey {{name}}! It's ${{dayRate}}/day plus a ${{deposit}} refundable deposit ({{depositMethods}}, paid at pickup, returned at drop-off). One solution packet included, extras ${{extraSolution}}. Pickup and return {{meetup}}. Which day did you need it?",
  },
  "booking-request": {
    name: "booking-request",
    pickupRelated: true,
    body: "Hey {{name}}! Locking you in for {{pickupDate}} — pickup {{meetup}}. ${{dayRate}}/day + ${{deposit}} refundable deposit ({{depositMethods}}) at pickup. Does that still work?",
  },
  "close-out": {
    name: "close-out",
    pickupRelated: false,
    body: "Hey {{name}} — quick update, we're going to pass on this one. Really appreciate your time though!",
  },
  "close-out-50pct": {
    name: "close-out-50pct",
    pickupRelated: false,
    body: "Hey {{name}} — we're passing at asking, but if you'd ever sell at 50% of your asking price, you can reach me at {{callbackNumber}}. No worries either way!",
  },
  "backup-advance": {
    name: "backup-advance",
    pickupRelated: true,
    body: "Hey {{name}} — good news, you're up next for the {{item}} at ${{price}}. Want to come by {{pickupTime}}? {{meetup}}, {{payment}}.",
  },
  "nudge-stale": {
    name: "nudge-stale",
    pickupRelated: false,
    body: "Hey {{name}} — just checking in, still interested in the {{item}}? It's ${{price}} and ready for pickup {{meetup}}.",
  },
  "nudge-gentle": {
    name: "nudge-gentle",
    pickupRelated: false,
    body: "Hey {{name}} — just floating this back up in case you missed it. The {{item}} is still available at ${{price}}. Want it?",
  },
  "nudge-firm": {
    name: "nudge-firm",
    pickupRelated: false,
    body: "Hey {{name}} — I've got a few people asking about the {{item}}, so I wanted to check with you first before I move on. Still want it at ${{price}}?",
  },
  "nudge-final": {
    name: "nudge-final",
    pickupRelated: false,
    body: "Hey {{name}} — last check on the {{item}} before I offer it to the next person in line. Let me know today if you want it at ${{price}}.",
  },
  "sold-notice": {
    name: "sold-notice",
    pickupRelated: false,
    body: "Hey {{name}} — quick heads up, the {{item}} just sold. Appreciate your interest!",
  },
  "holding-logistics": {
    name: "holding-logistics",
    pickupRelated: false,
    body: "Sounds good {{name}} — let me lock in the pickup details and I'll get right back to you shortly!",
  },
  // --- Negotiation bands (selling/negotiation.ts) ---
  "offer-hold": {
    name: "offer-hold",
    pickupRelated: false,
    body: "Hey {{name}} — appreciate the offer, but the {{item}} is firm at ${{price}}. It's yours at that price if you want it!",
  },
  "offer-counter": {
    name: "offer-counter",
    pickupRelated: false,
    body: "Hey {{name}} — I can't do ${{offer}}, but I can do ${{counter}}. That's my bottom line on the {{item}}. Let me know!",
  },
  "offer-bottom-line": {
    name: "offer-bottom-line",
    pickupRelated: false,
    body: "Hey {{name}} — ${{counter}} really is my bottom line on the {{item}}. Let me know if that works!",
  },
  "offer-decline": {
    name: "offer-decline",
    pickupRelated: false,
    body: "Hey {{name}} — thanks, but I'll have to pass at ${{offer}}. The {{item}} is ${{price}}.",
  },
  // --- Queue timeouts (selling/queue.ts) ---
  "hold-lapsed": {
    name: "hold-lapsed",
    pickupRelated: false,
    body: "Hey {{name}} — I held the {{item}} for you but didn't get a pickup time, so the hold has lapsed and I'm moving to the next person in line. Feel free to reach out if it's still around later!",
  },
  "hold-offer": {
    name: "hold-offer",
    pickupRelated: true,
    body: "Hey {{name}} — good news, the {{item}} opened up and you're next in line. Same terms: ${{price}}, {{payment}}, pickup {{meetup}}. I can hold it {{holdHours}} hours — what specific time works for you?",
  },
  // --- Rental decision tree (selling/rental_tree.ts) ---
  "rental-rate": {
    name: "rental-rate",
    pickupRelated: false,
    body: "Hey {{name}}! It's ${{dayRate}}/day plus a ${{deposit}} refundable deposit ({{depositMethods}}). Does that rate work for you?",
  },
  "rental-need-time": {
    name: "rental-need-time",
    pickupRelated: false,
    body: "Hey {{name}} — happy to set that up! What specific time works for pickup (like \"Saturday at 2pm\")? I need an exact time to lock it in.",
  },
  "rental-need-deposit": {
    name: "rental-need-deposit",
    pickupRelated: false,
    body: "Hey {{name}} — to confirm a booking I need the ${{deposit}} refundable deposit agreed first ({{depositMethods}}). It comes back in full when the machine is returned. Does that work?",
  },
  "rental-no-delivery": {
    name: "rental-no-delivery",
    pickupRelated: false,
    body: "Hey {{name}} — sorry, I can't deliver, ship, or meet elsewhere. Pickup and return are in the {{pickupArea}} only. Would that work for you?",
  },
  "rental-ready": {
    name: "rental-ready",
    pickupRelated: true,
    body: "Hey {{name}} — perfect: ${{dayRate}}/day, ${{deposit}} refundable deposit ({{depositMethod}}), pickup {{pickupTime}} in the {{pickupArea}}. Let me get that confirmed and I'll get right back to you!",
  },
  "sms-availability": {
    name: "sms-availability",
    pickupRelated: false,
    body: "Hi {{name}}, it's Toozy — saw your text about the {{item}}. Still available at ${{price}}. Pickup {{meetup}}. Want to set a time?",
  },
};

export function templateNames(): string[] {
  return Object.keys(TEMPLATES);
}

/** Markers that must never appear in outbound text (address-leak guard). */
const ADDRESS_MARKERS = [/\bapt\.?\b/i, /apartment/i, /\bsuite\b/i, /\bunit\s*#?\s*\d/i, /westcreek/i];

export class TemplateError extends Error {}

export type TemplateContext = Record<string, string | number>;

/**
 * Render a template. Missing variables throw. Active pickup constraints are
 * auto-appended to pickup-related templates. The final text is scanned for
 * address markers and rejected if any match.
 */
export function renderTemplate(doc: TrackerDocument, name: string, ctx: TemplateContext): string {
  const def = TEMPLATES[name];
  if (!def) throw new TemplateError(`Unknown template "${name}". Available: ${templateNames().join(", ")}`);
  let text = def.body.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = ctx[key];
    if (value === undefined || value === null || value === "") {
      throw new TemplateError(`Template "${name}" needs variable "{{${key}}}" but it was not provided.`);
    }
    return String(value);
  });
  if (def.pickupRelated) {
    const constraints = doc.constraints.filter((c) => c.active && (c.appliesTo === "pickup" || c.appliesTo === "all"));
    for (const c of constraints) text += `\n\n${c.text}`;
  }
  for (const marker of ADDRESS_MARKERS) {
    if (marker.test(text)) {
      throw new TemplateError(`Rendered template "${name}" tripped the address-leak guard (${marker}). Use public-meetup language only.`);
    }
  }
  return text;
}
