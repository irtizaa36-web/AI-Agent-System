import { test } from "node:test";
import assert from "node:assert/strict";
import { alertEmailToPostings, createAlertMailSource, extractListingsFromEmail, looksLikeJobAlert } from "./alert-mail";
import { FakeInkboxClient } from "../../integrations/inkbox/fake-client";
import type { EmailMessage } from "../../integrations/inkbox/client";

/**
 * IMPORTANT: the HTML fixtures below are constructed from the publicly
 * known general shape of a LinkedIn job-alert email (title link, then
 * "Company · Location" text) — they are NOT a captured real sample. If
 * `extractListingsFromEmail` is retuned against a real forwarded alert and
 * these fixtures no longer represent it accurately, update the fixtures
 * to match reality, not the other way around.
 */
const SAMPLE_ALERT_HTML = `
<html><body>
  <p>3 new jobs match your preferences</p>
  <table>
    <tr><td>
      <a href="https://www.linkedin.com/comm/jobs/view/4123456789/?trk=alert">Senior Marketing Program Manager</a>
      <div>Acme Corp · Remote</div>
    </td></tr>
    <tr><td>
      <a href="https://www.linkedin.com/comm/jobs/view/4123456790/?trk=alert">GTM Enablement Manager</a>
      <div>Globex · Houston, TX</div>
    </td></tr>
  </table>
  <p><a href="https://www.linkedin.com/psettings/job-alerts">Manage your job alerts</a></p>
</body></html>
`;

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-1",
    threadId: "thread-1",
    from: { address: "jobalerts-noreply@linkedin.com" },
    to: [{ address: "toozy@inkboxmail.com" }],
    subject: "3 new jobs match your preferences",
    body: SAMPLE_ALERT_HTML,
    receivedAt: "2026-09-13T08:00:00.000Z",
    ...overrides,
  };
}

test("looksLikeJobAlert accepts a real-shaped LinkedIn alert sender and subject", () => {
  assert.equal(looksLikeJobAlert(message()), true);
});

test("looksLikeJobAlert rejects an unrelated LinkedIn email — a connection request, not a job alert", () => {
  const outcome = looksLikeJobAlert(
    message({ from: { address: "messages-noreply@linkedin.com" }, subject: "You have a new connection request" }),
  );
  assert.equal(outcome, false);
});

test("looksLikeJobAlert rejects mail from an unrelated domain, even with a matching subject", () => {
  assert.equal(looksLikeJobAlert(message({ from: { address: "newsletter@example.com" } })), false);
});

test("extractListingsFromEmail reads title, company and location from each job card", () => {
  const listings = extractListingsFromEmail(SAMPLE_ALERT_HTML);

  assert.equal(listings.length, 2);
  assert.deepEqual(listings[0], {
    title: "Senior Marketing Program Manager",
    company: "Acme Corp",
    location: "Remote",
    url: "https://www.linkedin.com/comm/jobs/view/4123456789/?trk=alert",
  });
  assert.equal(listings[1]?.company, "Globex");
  assert.equal(listings[1]?.location, "Houston, TX");
});

test("extractListingsFromEmail ignores the 'manage your alerts' link — it has no job-view URL", () => {
  const listings = extractListingsFromEmail(SAMPLE_ALERT_HTML);
  assert.ok(!listings.some((l) => l.url.includes("psettings")));
});

test("extractListingsFromEmail returns nothing for an email with no job-view links, rather than guessing", () => {
  const html = "<html><body><p>Congratulations on your work anniversary!</p></body></html>";
  assert.deepEqual(extractListingsFromEmail(html), []);
});

test("a single unseparated segment after the anchor is read as the company, with location left blank rather than guessed", () => {
  // A known, honest limitation: with no "·"/"•"/"|" separator to tell company
  // from location apart, the one segment found ("Remote" here) is read as
  // the company — which is wrong in this specific case — rather than the
  // parser guessing which field it actually is. Documented, not hidden:
  // this is exactly the kind of case a real sample email should be checked
  // against once one exists.
  const html = `<a href="https://www.linkedin.com/jobs/view/1/">Some Role</a><div>Remote</div>`;
  const listings = extractListingsFromEmail(html);
  assert.equal(listings.length, 1);
  assert.equal(listings[0]?.company, "Remote");
  assert.equal(listings[0]?.location, "", "never guessed — left blank rather than silently split wrong");
});

test("extractListingsFromEmail de-duplicates the same job-view URL appearing twice", () => {
  const html = `
    <a href="https://www.linkedin.com/jobs/view/1/">Marketing Manager</a><div>Acme · Remote</div>
    <a href="https://www.linkedin.com/jobs/view/1/">Marketing Manager</a><div>Acme · Remote</div>
  `;
  assert.equal(extractListingsFromEmail(html).length, 1);
});

test("alertEmailToPostings maps each listing to a RawPosting, using the email's receipt time as postedAt", () => {
  const postings = alertEmailToPostings(message(), "inkbox:alert-mail");

  assert.equal(postings.length, 2);
  assert.equal(postings[0]?.title, "Senior Marketing Program Manager");
  assert.equal(postings[0]?.company, "Acme Corp");
  assert.equal(postings[0]?.location, "Remote");
  assert.equal(postings[0]?.postedAt, "2026-09-13T08:00:00.000Z");
  assert.equal(postings[0]?.body, "", "alert emails carry no job description");
  assert.equal(postings[0]?.sourceId, "inkbox:alert-mail");
});

test("createAlertMailSource reads only messages that look like job alerts, via the real InkboxClient port", async () => {
  const client = new FakeInkboxClient("toozy@inkboxmail.com", [
    message({ id: "a", threadId: "a" }),
    message({
      id: "b",
      threadId: "b",
      from: { address: "messages-noreply@linkedin.com" },
      subject: "New message from a recruiter",
      body: "<p>Hi, are you open to new roles?</p>",
    }),
  ]);

  const source = createAlertMailSource(client);
  const postings = await source.fetch();

  assert.equal(postings.length, 2, "only the genuine job-alert email's two listings, not the recruiter message");
  assert.ok(postings.every((p) => p.sourceId === "inkbox:alert-mail"));
});

test("createAlertMailSource returns an empty array, not a crash, when nothing matches", async () => {
  const client = new FakeInkboxClient("toozy@inkboxmail.com", []);
  const source = createAlertMailSource(client);
  assert.deepEqual(await source.fetch(), []);
});
