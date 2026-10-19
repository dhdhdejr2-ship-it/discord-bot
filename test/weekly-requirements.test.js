"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  REQUIREMENT_TARGETS,
  createRequirementsTracker,
  getWeekWindow,
} = require("../lib/weekly-requirements");

test("week boundaries are Monday midnight in Amsterdam, including the autumn DST change", () => {
  const week = getWeekWindow(Date.parse("2026-10-25T02:30:00.000Z"));
  assert.equal(week.start, Date.parse("2026-10-18T22:00:00.000Z"));
  assert.equal(week.end, Date.parse("2026-10-25T23:00:00.000Z"));
  assert.equal(week.timeZone, "Europe/Amsterdam");
});

test("tracker deduplicates events and reports only this week's counts by member and guild", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-requirements-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tracker = createRequirementsTracker(directory);
  const monday = Date.parse("2026-10-19T00:30:00.000Z");
  const ticket = {
    key: "ticket:guild:channel:staff",
    type: "tickets",
    guildId: "guild",
    userId: "staff",
    sourceId: "channel",
    createdAt: monday,
  };
  assert.equal(tracker.recordEvent(ticket), true);
  assert.equal(tracker.recordEvent(ticket), false);
  assert.equal(tracker.recordEvent({ ...ticket, key: "vouch:message:staff", type: "vouches" }), true);
  assert.deepEqual(tracker.getCounts("guild", "staff", monday), { tickets: 1, deployments: 0, vouches: 1 });
  assert.deepEqual(tracker.getCounts("other-guild", "staff", monday), { tickets: 0, deployments: 0, vouches: 0 });
  const nextMonday = Date.parse("2026-10-25T23:00:00.000Z");
  assert.deepEqual(tracker.getCounts("guild", "staff", nextMonday), { tickets: 0, deployments: 0, vouches: 0 });
  assert.deepEqual(REQUIREMENT_TARGETS, { tickets: 10, deployments: 5, vouches: 5 });
});

test("resetGuild clears all requirement types for one server and preserves other servers", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-requirements-reset-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tracker = createRequirementsTracker(directory);
  const now = Date.parse("2026-10-19T12:00:00.000Z");
  for (const [guildId, userId, type] of [
    ["guild-a", "staff-a", "tickets"],
    ["guild-a", "staff-a", "deployments"],
    ["guild-a", "staff-a", "vouches"],
    ["guild-b", "staff-b", "tickets"],
  ]) {
    assert.equal(tracker.recordEvent({
      key: guildId + ":" + type,
      type,
      guildId,
      userId,
      createdAt: now,
    }), true);
  }

  assert.equal(tracker.resetGuild("guild-a"), 3);
  assert.equal(tracker.resetGuild("guild-a"), 0);
  assert.deepEqual(tracker.getCounts("guild-a", "staff-a", now), {
    tickets: 0,
    deployments: 0,
    vouches: 0,
  });
  assert.deepEqual(tracker.getCounts("guild-b", "staff-b", now), {
    tickets: 1,
    deployments: 0,
    vouches: 0,
  });
});
