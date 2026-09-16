import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, parseGreenhouse } from "./greenhouse";
import { parseLever } from "./lever";
import { parseAshby } from "./ashby";
import { parseFeed } from "./feed";

const FETCHED_AT = "2026-09-13T08:00:00.000Z";

test("parseGreenhouse maps jobs and un-escapes the double-escaped HTML body", () => {
  const postings = parseGreenhouse(
    {
      jobs: [
        {
          id: 1,
          title: "Marketing Manager",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
          updated_at: "2026-09-01T00:00:00.000Z",
          location: { name: "Remote - US" },
          content: "&lt;p&gt;Own demand gen&lt;/p&gt;",
        },
      ],
    },
    "Acme",
    "greenhouse:acme",
    FETCHED_AT,
  );

  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.company, "Acme");
  assert.equal(postings[0]?.location, "Remote - US");
  assert.equal(postings[0]?.body, "<p>Own demand gen</p>");
});

test("decodeEntities handles ampersand last so it cannot double-decode", () => {
  assert.equal(decodeEntities("&amp;lt;p&amp;gt;"), "&lt;p&gt;");
});

test("parseGreenhouse survives an empty board without throwing", () => {
  assert.deepEqual(parseGreenhouse({}, "Acme", "greenhouse:acme", FETCHED_AT), []);
});

test("parseLever folds the requirement lists into the body", () => {
  const postings = parseLever(
    [
      {
        id: "1",
        text: "Growth Manager",
        hostedUrl: "https://jobs.lever.co/acme/1",
        createdAt: 1756684800000,
        categories: { location: "Remote" },
        description: "<p>Lead growth</p>",
        lists: [{ text: "Requirements", content: "<li>5 years demand gen</li>" }],
      },
    ],
    "Acme",
    "lever:acme",
    FETCHED_AT,
  );

  assert.match(postings[0]?.body ?? "", /Lead growth/);
  assert.match(postings[0]?.body ?? "", /5 years demand gen/, "requirements live in lists, not description");
  assert.equal(postings[0]?.postedAt, new Date(1756684800000).toISOString());
});

test("parseAshby folds its remote flag into the location string", () => {
  const postings = parseAshby(
    { jobs: [{ id: "1", title: "Ops Manager", jobUrl: "https://jobs.ashbyhq.com/acme/1", location: "New York", isRemote: true }] },
    "Acme",
    "ashby:acme",
    FETCHED_AT,
  );

  assert.equal(postings[0]?.location, "Remote (New York)");
});

test("parseFeed reads RSS items, CDATA and all", () => {
  const postings = parseFeed(
    `<rss><channel>
       <item>
         <title>Marketing Manager</title>
         <link>https://board.test/jobs/1</link>
         <description><![CDATA[<p>Own demand gen</p>]]></description>
         <pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate>
       </item>
     </channel></rss>`,
    "Acme",
    "feed:x",
    FETCHED_AT,
  );

  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.title, "Marketing Manager");
  assert.equal(postings[0]?.url, "https://board.test/jobs/1");
  assert.equal(postings[0]?.postedAt, "2026-09-01T00:00:00.000Z");
});

test("parseFeed reads Atom entries whose link is an href attribute", () => {
  const postings = parseFeed(
    `<feed><entry>
       <title>Growth Lead</title>
       <link href="https://board.test/jobs/2"/>
       <summary>Lead growth</summary>
       <updated>2026-09-02T00:00:00Z</updated>
     </entry></feed>`,
    null,
    "feed:y",
    FETCHED_AT,
  );

  assert.equal(postings[0]?.url, "https://board.test/jobs/2");
});

test("parseFeed drops entries with no title or no link rather than emitting a broken posting", () => {
  assert.deepEqual(parseFeed("<rss><item><title>No link</title></item></rss>", "Acme", "feed:z", FETCHED_AT), []);
});
