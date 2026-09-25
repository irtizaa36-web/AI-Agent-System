import type { ActionKind, Criterion, DatedFact, IsoDate, Settlement, SettlementStatus, SourceRef, TrackerDocument, Verdict } from "./types";

/**
 * The owner's pipeline as of 2026-09-25 (ADR 0022). Deadlines are the ones he
 * tracks. Payout text and class definitions are quoted from the source named
 * next to each, read that day; where no source states a payout, none is
 * given. Eligibility stays `unverified` unless the owner decided it.
 *
 * Personal claim data is deliberately not here: this repository is public,
 * so the CVS confirmation number is recorded locally with
 * `settlements confirmation cvs-digital-privacy <number>` and lives only in
 * the gitignored tracker file.
 */

const SEEDED_ON: IsoDate = "2026-09-25";

const OWNER: SourceRef = { label: "Owner's settlement tracker", retrievedOn: SEEDED_ON };
const CAO: SourceRef = { label: "ClassAction.org settlements list", url: "https://www.classaction.org/settlements", retrievedOn: SEEDED_ON };
const tca = (path: string): SourceRef => ({ label: "Top Class Actions", url: `https://topclassactions.com/lawsuit-settlements/open-lawsuit-settlements/${path}/`, retrievedOn: SEEDED_ON });

const owner = (date: IsoDate): DatedFact => ({ date, source: OWNER });

const BREACH_NOTICE = (breach: string): Criterion => ({ kind: "evidence", description: `Your data was in the ${breach} — find the breach notice letter/email and its Class Member ID` });

interface Active {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly domains?: readonly string[];
  readonly deadline: IsoDate;
  readonly conflicts?: readonly DatedFact[];
  readonly payout?: { readonly text: string; readonly source: SourceRef };
  readonly classDefinition?: string;
  readonly criteria: readonly Criterion[];
  readonly actions: readonly (readonly [ActionKind, string])[];
}

const ATTEST: readonly [ActionKind, string] = ["attestation", "Read the claim form's attestation and sign it yourself, only if every statement is true for you"];

const ACTIVE: readonly Active[] = [
  {
    id: "usa-clinics-tcpa",
    name: "USA Clinics Group TCPA (unwanted texts)",
    aliases: ["USA Clinics Group - Unwanted Texts"],
    deadline: "2026-10-05",
    payout: { text: "$50 - $150", source: CAO },
    classDefinition: "Received more than one marketing text from USA Clinics Group between June 12, 2021 and June 16, 2026 (ClassAction.org).",
    criteria: [
      { kind: "profile", fact: "received_robocalls_or_texts", description: "Received robocalls or marketing texts" },
      { kind: "evidence", description: "More than one USA Clinics Group marketing text between 2021-06-12 and 2026-06-16 — find them, or the notice with your Claim ID" },
    ],
    actions: [
      ["notice_search", "Search texts and email for USA Clinics Group messages and any settlement notice (Claim ID, and the phone number it was sent to)"],
      ["verification_code", "If the claim site texts a verification code to your number, enter it yourself"],
      ATTEST,
    ],
  },
  {
    id: "vsl3-probiotic",
    name: "VSL#3 probiotic",
    aliases: ["VSL Pharmaceuticals probiotic", "VSL Pharmaceuticals - Probiotics"],
    domains: ["vsl3lawsuit.com"],
    deadline: "2026-10-20",
    payout: { text: "Up to $800 (Top Class Actions); $20 per unit (ClassAction.org)", source: tca("20m-vsl-pharmaceuticals-probiotic-class-action-settlement") },
    classDefinition: "Consumers who purchased VSL#3 in the United States between June 1, 2016, and June 19, 2019 (Top Class Actions).",
    criteria: [{ kind: "evidence", description: "Bought VSL#3 in the US between 2016-06-01 and 2019-06-19" }],
    actions: [
      ["product_count", "Count the VSL#3 units you bought between 2016-06-01 and 2019-06-19"],
      ["documentation", "Find receipts, online orders or card statements for them (Top Class Actions lists proof of purchase)"],
      ATTEST,
    ],
  },
  {
    id: "finwise",
    name: "FinWise Bank data breach",
    domains: ["finwisedatasettlement.com"],
    deadline: "2026-10-29",
    payout: { text: "Up to $5,000 in documented losses or a pro rata cash payment", source: tca("2-8m-finwise-bank-data-breach-class-action-settlement") },
    classDefinition: "Individuals whose private information was affected by the FinWise Bank data breach on or around May 31, 2024, including those who received a notice (Top Class Actions).",
    criteria: [BREACH_NOTICE("May 2024 FinWise Bank breach")],
    actions: [["notice_search", "Search mail and email for a FinWise Bank breach notice (2024) and its Class Member ID"], ATTEST],
  },
  {
    id: "bestway-pool",
    name: "Bestway above-ground pool",
    aliases: ["Bestway - Above-Ground Pools"],
    domains: ["poolsettlementbw.com"],
    deadline: "2026-10-30",
    payout: { text: "Up to $40 without proof of purchase or 10% of the purchase price with proof", source: tca("15m-bestway-above-ground-pool-safety-class-action-settlement") },
    classDefinition: "Bought a Bestway-branded pool 48 inches or taller with compression straps outside the support poles, sold 2008 through 2024 (Top Class Actions).",
    criteria: [{ kind: "evidence", description: "Bought a qualifying Bestway pool (48\"+ tall, straps outside the support poles) between 2008 and 2024" }],
    actions: [
      ["product_count", "Note the pool's model number and how many qualifying pools you bought"],
      ["documentation", "Find the receipt or order confirmation (model, price, date) if claiming 10% instead of $40"],
      ATTEST,
    ],
  },
  {
    id: "modmed",
    name: "Modernizing Medicine (ModMed) data breach",
    aliases: ["Modernizing Medicine - Data Breach", "ModMed data breach"],
    deadline: "2026-11-02",
    payout: { text: "$75 - $5,000", source: CAO },
    classDefinition: "Private information compromised in the July 2025 Modernizing Medicine data breach (ClassAction.org).",
    criteria: [BREACH_NOTICE("July 2025 Modernizing Medicine breach")],
    actions: [["notice_search", "Search mail and email for a ModMed / Modernizing Medicine breach notice and its Class Member ID"], ATTEST],
  },
  {
    id: "dr-squatch",
    name: "Dr. Squatch 'all natural' claims",
    aliases: ["Dr. Squatch - All Natural Claims"],
    deadline: "2026-11-27",
    payout: { text: "Varies", source: CAO },
    classDefinition: "Bought certain Dr. Squatch products between November 1, 2018 and August 29, 2026 (ClassAction.org).",
    criteria: [{ kind: "evidence", description: "Bought covered Dr. Squatch products between 2018-11-01 and 2026-08-29" }],
    actions: [["product_count", "Count the Dr. Squatch products you bought 2018-11-01 to 2026-08-29 (order history)"], ATTEST],
  },
  {
    id: "amazon-returns",
    name: "Amazon returns (refund policy)",
    aliases: ["Amazon Return Policy Litigation", "Amazon returns"],
    domains: ["returnsettlement.com"],
    deadline: "2026-12-01",
    payout: { text: "Not stated per claimant ($309.5M settlement fund)", source: { label: "ReturnSettlement.com (official site)", url: "https://www.returnsettlement.com/", retrievedOn: SEEDED_ON } },
    classDefinition:
      "Initiated a return or refund request to Amazon for a physical product bought through Amazon.com between Sept. 5, 2017 and Feb. 12, 2026, and did not get a refund, got a late or incorrect one, or was later charged again (settlement notice).",
    criteria: [
      { kind: "profile", fact: "amazon_shopper", description: "Shops on Amazon" },
      { kind: "profile", fact: "amazon_refund_problems", description: "Had an Amazon return with a missing, late or wrong refund" },
      { kind: "evidence", description: "Order numbers of affected returns between 2017-09-05 and 2026-02-12" },
    ],
    actions: [
      ["documentation", "Pull the Amazon order numbers for the botched refunds (2017-09-05 to 2026-02-12)"],
      ["notice_search", "Search email for a ReturnSettlement.com notice and Claim ID"],
      ATTEST,
    ],
  },
  {
    id: "inotiv",
    name: "Inotiv data breach",
    aliases: ["Inotiv - Data Breach"],
    deadline: "2026-12-02",
    payout: { text: "$45 - $4,580", source: CAO },
    classDefinition: "Personal information exposed in the August 2025 Inotiv data breach (ClassAction.org).",
    criteria: [BREACH_NOTICE("August 2025 Inotiv breach")],
    actions: [["notice_search", "Search mail and email for an Inotiv breach notice and its Class Member ID"], ATTEST],
  },
  {
    id: "nonbank-atm",
    name: "Non-bank ATM surcharges (Visa/Mastercard)",
    aliases: ["Non-Bank ATM Surcharges", "Visa Mastercard non-bank ATM"],
    deadline: "2027-02-10",
    conflicts: [{ date: "2027-02-27", source: CAO }],
    payout: { text: "Varies", source: tca("167-5m-visa-mastercard-non-bank-atm-class-action-settlement") },
    classDefinition: "Charged an access fee or surcharge to withdraw cash at an ATM not owned by Visa, Mastercard or any bank, from October 24, 2007 (ClassAction.org).",
    criteria: [{ kind: "evidence", description: "Paid a surcharge at an ATM not owned by a bank (e.g. at a store or gas station) in the class period" }],
    actions: [["documentation", "Find bank statements showing non-bank ATM surcharges"], ATTEST],
  },
  {
    id: "realpage",
    name: "RealPage rent price-fixing",
    aliases: ["RealPage - Rent Price-Fixing", "RealPage antitrust"],
    deadline: "2027-01-29",
    payout: { text: "Varies", source: CAO },
    classDefinition: "Paid rent on a lease for a multifamily property subject to a license for certain RealPage software between October 18, 2018 and November 21, 2025 (ClassAction.org).",
    criteria: [
      { kind: "profile", fact: "renter", description: "Rents a home" },
      { kind: "evidence", description: "A rental you leased 2018-10-18 to 2025-11-21 is on the settlement's RealPage property list" },
    ],
    actions: [
      ["notice_search", "Check each rental address you had 2018-10-18 to 2025-11-21 against the settlement's property list, and search email for a notice"],
      ["documentation", "Lease or rent records for any covered property (ClassAction.org says proof is required)"],
      ATTEST,
    ],
  },
];

interface Dropped {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly domains?: readonly string[];
  readonly verdict: Verdict;
  readonly reason: string;
}

const EVALUATED = "Evaluated and dropped by the owner";

const DROPPED: readonly Dropped[] = [
  { id: "apple-siri", name: "Apple Siri", aliases: ["iPhone Siri Apple Intelligence"], verdict: "not_eligible", reason: "Not eligible (owner's evaluation)" },
  { id: "connectoncall", name: "ConnectOnCall data breach", domains: ["connectoncallsettlement.com"], verdict: "not_eligible", reason: "Not eligible (owner's evaluation)" },
  { id: "trader-joes-facta", name: "Trader Joe's FACTA", verdict: "unverified", reason: EVALUATED },
  { id: "bestway-spa-pump", name: "Bestway spa pump", aliases: ["Bestway Spa Pumps"], verdict: "unverified", reason: `${EVALUATED} (spa pump variant; the pool settlement is tracked separately)` },
  { id: "fujifilm-diosynth", name: "Fujifilm Diosynth", verdict: "unverified", reason: EVALUATED },
  { id: "high-5-games", name: "High 5 Games", verdict: "unverified", reason: EVALUATED },
  { id: "planned-parenthood-breach", name: "Planned Parenthood breach", verdict: "unverified", reason: EVALUATED },
  { id: "davison-design", name: "Davison Design", verdict: "unverified", reason: EVALUATED },
  { id: "forbes-tracking", name: "Forbes tracking", aliases: ["Forbes Media website tracking"], domains: ["mediasitetrackersettlement.com"], verdict: "unverified", reason: EVALUATED },
  { id: "turkey-antitrust", name: "Turkey antitrust", verdict: "unverified", reason: EVALUATED },
  { id: "suntrust-overdraft", name: "SunTrust overdraft", verdict: "unverified", reason: EVALUATED },
  { id: "farmers-heckathorn-tcpa", name: "Farmers Heckathorn TCPA", aliases: ["Heckathorn Farmers"], verdict: "unverified", reason: EVALUATED },
  { id: "iq-credit-union", name: "iQ Credit Union", verdict: "unverified", reason: EVALUATED },
];

function history(to: SettlementStatus, evidence: string): Settlement["history"] {
  return [{ on: SEEDED_ON, to, evidence }];
}

export function seedDocument(): TrackerDocument {
  const active: Settlement[] = ACTIVE.map((a) => ({
    id: a.id,
    name: a.name,
    aliases: [...(a.aliases ?? [])],
    domains: [...(a.domains ?? [])],
    criteria: [...a.criteria],
    deadline: owner(a.deadline),
    deadlineConflicts: [...(a.conflicts ?? [])],
    eligibility: { verdict: "unverified", reason: "Tracked by the owner; eligibility evidence not recorded yet", decidedOn: SEEDED_ON },
    status: "researching",
    history: history("researching", "Imported from the owner's tracker"),
    actions: a.actions.map(([kind, description], i) => ({ id: `a${i + 1}`, kind, description, done: false })),
    ...(a.payout ? { payout: a.payout } : {}),
    ...(a.classDefinition ? { classDefinition: a.classDefinition } : {}),
  }));

  const cvs: Settlement = {
    id: "cvs-digital-privacy",
    name: "CVS digital privacy",
    aliases: ["CVS - Data Privacy"],
    domains: [],
    criteria: [{ kind: "profile", fact: "cvs_app_user", description: "Used the CVS website/app" }],
    classDefinition: "Accessed the CVS website or app prior to July 27, 2026 (ClassAction.org).",
    deadline: { date: "2026-11-16", source: CAO },
    deadlineConflicts: [],
    payout: { text: "$5 - $10", source: CAO },
    eligibility: { verdict: "eligible", reason: "Owner uses the CVS app and filed a claim", decidedOn: SEEDED_ON },
    status: "filed",
    filedOn: "2026-09-21",
    history: [
      { on: SEEDED_ON, to: "researching", evidence: "Imported from the owner's tracker" },
      { on: SEEDED_ON, from: "researching", to: "filed", evidence: "Owner reports he filed this claim himself on 2026-09-21" },
    ],
    actions: [],
  };

  const dropped: Settlement[] = DROPPED.map((d) => ({
    id: d.id,
    name: d.name,
    aliases: [...(d.aliases ?? [])],
    domains: [...(d.domains ?? [])],
    criteria: [],
    deadlineConflicts: [],
    eligibility: { verdict: d.verdict, reason: d.reason, decidedOn: SEEDED_ON },
    status: "dropped",
    dropReason: d.reason,
    history: history("dropped", d.reason),
    actions: [],
  }));

  return {
    version: 1,
    settlements: [...active, cvs, ...dropped],
    doNotResearch: DROPPED.map((d) => ({ name: d.name, aliases: [...(d.aliases ?? [])], domains: [...(d.domains ?? [])], reason: d.reason, addedOn: SEEDED_ON })),
    inbox: [],
    seenKeys: [],
    nudges: [],
  };
}
