import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFeedbackPatch,
  buildFeedbackPrompt,
  buildFeedbackReplyBody,
  classifyFeedback,
  looksLikeDirectMessage,
  parseFeedbackClassification,
} from "./feedback";
import { DEFAULT_PREFERENCES, type Preferences } from "./records";
import { FakeScoringClient } from "./scoring-client";

const prefs: Preferences = { ...DEFAULT_PREFERENCES, titles: ["program manager"], scoreCutoff: 65, salaryFloor: 120000 };

test("looksLikeDirectMessage requires her as the sender AND the mailbox as a direct recipient", () => {
  const candidate = "brshivani@gmail.com";
  const mailbox = "toozy@inkboxmail.com";

  assert.equal(
    looksLikeDirectMessage({ from: { address: candidate }, to: [{ address: mailbox }] }, candidate, mailbox),
    true,
  );
});

test("looksLikeDirectMessage rejects a message from someone else, even if addressed to the mailbox", () => {
  const candidate = "brshivani@gmail.com";
  const mailbox = "toozy@inkboxmail.com";
  assert.equal(
    looksLikeDirectMessage({ from: { address: "hello@emails.reebok.com" }, to: [{ address: mailbox }] }, candidate, mailbox),
    false,
  );
});

test("looksLikeDirectMessage rejects her own forwarded mail that never actually reached the mailbox directly", () => {
  // The exact shape of a real forwarded LinkedIn alert: she's the recipient
  // named in the forwarded headers, not the one who wrote to us just now.
  const candidate = "brshivani@gmail.com";
  const mailbox = "toozy@inkboxmail.com";
  assert.equal(
    looksLikeDirectMessage({ from: { address: "jobalerts-noreply@linkedin.com" }, to: [{ address: candidate }] }, candidate, mailbox),
    false,
  );
});

test("looksLikeDirectMessage is case-insensitive", () => {
  assert.equal(
    looksLikeDirectMessage(
      { from: { address: "BrShivani@Gmail.com" }, to: [{ address: "Toozy@InkboxMail.com" }] },
      "brshivani@gmail.com",
      "toozy@inkboxmail.com",
    ),
    true,
  );
});

test("buildFeedbackPrompt lists every allowed field with its meaning, and only the allowed fields' current values", () => {
  const { system, user } = buildFeedbackPrompt("bump the salary floor to 130k", prefs, "some context");
  assert.match(system, /salaryFloor: number or null/);
  assert.match(system, /Never invent a value/);
  assert.doesNotMatch(system, /scoringModel/, "pipeline-internal fields must never appear as changeable");
  assert.match(user, /"salaryFloor": 120000/);
  assert.doesNotMatch(user, /"scoringModel"/, "only allow-listed current values are shown to the model");
});

test("parseFeedbackClassification returns the empty classification on malformed JSON, never a guess", () => {
  assert.deepEqual(parseFeedbackClassification("not json at all"), {
    hasQuestion: false,
    answerDraft: null,
    changes: [],
    unclear: [],
  });
});

test("parseFeedbackClassification returns the empty classification when the top level isn't an object", () => {
  assert.deepEqual(parseFeedbackClassification("[1,2,3]"), { hasQuestion: false, answerDraft: null, changes: [], unclear: [] });
});

test("parseFeedbackClassification reads a well-formed response with a question and a change", () => {
  const result = parseFeedbackClassification(
    JSON.stringify({
      hasQuestion: true,
      answerDraft: "Your current floor is $120,000.",
      changes: [{ field: "salaryFloor", value: 130000, quote: "bump the floor to 130k" }],
      unclear: [],
    }),
  );
  assert.equal(result.hasQuestion, true);
  assert.equal(result.answerDraft, "Your current floor is $120,000.");
  assert.deepEqual(result.changes, [{ field: "salaryFloor", value: 130000, quote: "bump the floor to 130k" }]);
});

test("parseFeedbackClassification drops a change naming a field outside the allow-list, filing it under unclear instead of applying it", () => {
  const result = parseFeedbackClassification(
    JSON.stringify({
      hasQuestion: false,
      answerDraft: null,
      changes: [{ field: "scoringModel", value: "gpt-5", quote: "use a different model" }],
      unclear: [],
    }),
  );
  assert.equal(result.changes.length, 0);
  assert.equal(result.unclear.length, 1);
  assert.match(result.unclear[0] ?? "", /scoringModel/);
});

test("parseFeedbackClassification drops a malformed change entry rather than crash or half-apply it", () => {
  const result = parseFeedbackClassification(
    JSON.stringify({ hasQuestion: false, answerDraft: null, changes: [{ field: "salaryFloor" }], unclear: [] }),
  );
  assert.equal(result.changes.length, 0);
  assert.equal(result.unclear.length, 1);
});

test("parseFeedbackClassification preserves the model's own unclear list", () => {
  const result = parseFeedbackClassification(
    JSON.stringify({ hasQuestion: false, answerDraft: null, changes: [], unclear: ["she mentioned wanting 'better' roles, too vague to act on"] }),
  );
  assert.deepEqual(result.unclear, ["she mentioned wanting 'better' roles, too vague to act on"]);
});

test("classifyFeedback round-trips through a fake scoring client", async () => {
  const client = new FakeScoringClient([
    JSON.stringify({
      hasQuestion: false,
      answerDraft: null,
      changes: [{ field: "metros", value: ["Houston", "Dallas", "New York", "Austin"], quote: "add Austin too" }],
      unclear: [],
    }),
  ]);
  const result = await classifyFeedback("add Austin too", prefs, "160 new, 0 shortlisted today", client, "claude-haiku-4-5");
  assert.equal(result.changes[0]?.field, "metros");
  assert.deepEqual(result.changes[0]?.value, ["Houston", "Dallas", "New York", "Austin"]);
});

test("applyFeedbackPatch applies a well-typed change and returns it in applied, not rejected", () => {
  const { next, applied, rejected } = applyFeedbackPatch(prefs, [{ field: "salaryFloor", value: 130000, quote: "bump it" }]);
  assert.equal(next.salaryFloor, 130000);
  assert.equal(applied.length, 1);
  assert.equal(rejected.length, 0);
});

test("applyFeedbackPatch rejects a type-mismatched value instead of writing something that would corrupt the file", () => {
  const { next, applied, rejected } = applyFeedbackPatch(prefs, [{ field: "salaryFloor", value: "a lot", quote: "more money" }]);
  assert.equal(next.salaryFloor, prefs.salaryFloor, "unchanged");
  assert.equal(applied.length, 0);
  assert.equal(rejected.length, 1);
});

test("applyFeedbackPatch replaces an array field wholesale with the model's full new array, not a merge", () => {
  const { next } = applyFeedbackPatch(prefs, [{ field: "titles", value: ["program manager", "project manager"], quote: "also project manager" }]);
  assert.deepEqual(next.titles, ["program manager", "project manager"]);
});

test("applyFeedbackPatch applies multiple changes in one call and reports each outcome separately", () => {
  const { next, applied, rejected } = applyFeedbackPatch(prefs, [
    { field: "scoreCutoff", value: 70, quote: "raise the bar" },
    { field: "remoteOnly", value: "yes", quote: "still remote only" }, // wrong type on purpose
  ]);
  assert.equal(next.scoreCutoff, 70);
  assert.equal(next.remoteOnly, prefs.remoteOnly);
  assert.equal(applied.length, 1);
  assert.equal(rejected.length, 1);
});

test("applyFeedbackPatch out-of-range scoreCutoff is rejected, not clamped or guessed", () => {
  const { applied, rejected } = applyFeedbackPatch(prefs, [{ field: "scoreCutoff", value: 150, quote: "way pickier" }]);
  assert.equal(applied.length, 0);
  assert.equal(rejected.length, 1);
});

test("buildFeedbackReplyBody answers her question when there is one", () => {
  const classification = { hasQuestion: true, answerDraft: "Your floor is currently $120,000.", changes: [], unclear: [] };
  const body = buildFeedbackReplyBody(classification, [], []);
  assert.equal(body, "Your floor is currently $120,000.");
});

test("buildFeedbackReplyBody is honest when there was a question but no groundable answer, rather than staying silent", () => {
  const classification = { hasQuestion: true, answerDraft: null, changes: [], unclear: [] };
  const body = buildFeedbackReplyBody(classification, [], []);
  assert.match(body, /not confident I can answer/);
});

test("buildFeedbackReplyBody lists every applied change with its new value", () => {
  const classification = { hasQuestion: false, answerDraft: null, changes: [], unclear: [] };
  const applied = [
    { field: "salaryFloor" as const, value: 130000, quote: "bump it" },
    { field: "metros" as const, value: ["Houston", "Austin"], quote: "add Austin" },
  ];
  const body = buildFeedbackReplyBody(classification, applied, []);
  assert.match(body, /salaryFloor → 130000/);
  assert.match(body, /metros → \["Houston","Austin"\]/);
});

test("buildFeedbackReplyBody surfaces both unclear items and rejected changes, inviting a clearer follow-up rather than pretending nothing happened", () => {
  const classification = { hasQuestion: false, answerDraft: null, changes: [], unclear: ["wants 'better' roles, too vague"] };
  const rejected = [{ field: "salaryFloor" as const, value: "a lot", quote: "way more money" }];
  const body = buildFeedbackReplyBody(classification, [], rejected);
  assert.match(body, /too vague/);
  assert.match(body, /way more money.*salaryFloor/);
  assert.match(body, /say more and I'll apply it/);
});

test("buildFeedbackReplyBody is empty when there's genuinely nothing to say — no question, nothing applied, nothing unclear", () => {
  const classification = { hasQuestion: false, answerDraft: null, changes: [], unclear: [] };
  assert.equal(buildFeedbackReplyBody(classification, [], []), "");
});
