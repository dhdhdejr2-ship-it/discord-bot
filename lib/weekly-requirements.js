"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TIME_ZONE = "Europe/Amsterdam";
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUIREMENT_TARGETS = Object.freeze({ tickets: 10, deployments: 5, vouches: 5 });

function getZonedParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = {};
  for (const part of parts) if (part.type !== "literal") values[part.type] = Number(part.value);
  return { year: values.year, month: values.month, day: values.day };
}

function getTimeZoneOffsetMs(timestamp, timeZone) {
  const label = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(new Date(timestamp))
    .find(part => part.type === "timeZoneName")?.value;
  if (label === "GMT") return 0;
  const match = String(label || "").match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) throw new Error("Could not determine time-zone offset for " + timeZone + ".");
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0)) * 60 * 1000;
}

function localWallTimeToUtc(wallTime, timeZone) {
  let candidate = wallTime;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = wallTime - getTimeZoneOffsetMs(candidate, timeZone);
    if (next === candidate) return next;
    candidate = next;
  }
  return candidate;
}

function getWeekWindow(now = Date.now(), timeZone = TIME_ZONE) {
  const timestamp = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(timestamp)) throw new TypeError("A valid date is required.");
  const local = getZonedParts(timestamp, timeZone);
  const localDateAsUtc = Date.UTC(local.year, local.month - 1, local.day);
  const weekday = new Date(localDateAsUtc).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const monday = new Date(localDateAsUtc - daysSinceMonday * DAY_MS);
  const weekStartWallTime = Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate());
  const nextMonday = new Date(weekStartWallTime + 7 * DAY_MS);
  const nextWeekStartWallTime = Date.UTC(nextMonday.getUTCFullYear(), nextMonday.getUTCMonth(), nextMonday.getUTCDate());
  return {
    start: localWallTimeToUtc(weekStartWallTime, timeZone),
    end: localWallTimeToUtc(nextWeekStartWallTime, timeZone),
    timeZone,
  };
}

function normalizeLabel(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function channelMatchesActivity(channel, marker) {
  const labels = [
    channel?.name,
    channel?.parent?.name,
    channel?.parent?.parent?.name,
    channel?.parentName,
  ].filter(Boolean);
  const normalizedMarker = normalizeLabel(marker).trim();
  if (!normalizedMarker) return false;
  return labels.some(label => normalizeLabel(label).includes(normalizedMarker));
}

function createRequirementsTracker(dataDirectory) {
  if (!dataDirectory) throw new TypeError("A requirements data directory is required.");
  const filePath = path.join(path.resolve(dataDirectory), "requirements-events.json");

  function readEvents() {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  }

  function writeEvents(events) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = filePath + "." + process.pid + ".tmp";
    fs.writeFileSync(temporaryPath, JSON.stringify(events, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  }

  function recordEvent(event) {
    if (!event || !REQUIREMENT_TARGETS[event.type]) return false;
    const createdAt = Number(event.createdAt ?? Date.now());
    if (!Number.isFinite(createdAt) || !event.key || !event.guildId || !event.userId) return false;
    const week = getWeekWindow(createdAt);
    if (createdAt < week.start || createdAt >= week.end) return false;
    const events = readEvents();
    if (events.some(existing => existing.key === event.key)) return false;
    events.push({
      key: String(event.key),
      type: event.type,
      guildId: String(event.guildId),
      userId: String(event.userId),
      sourceId: event.sourceId ? String(event.sourceId) : null,
      createdAt,
    });
    writeEvents(events);
    return true;
  }

  function getCounts(guildId, userId, now = Date.now()) {
    const week = getWeekWindow(now);
    const counts = { tickets: 0, deployments: 0, vouches: 0 };
    for (const event of readEvents()) {
      if (
        event.guildId === String(guildId) &&
        event.userId === String(userId) &&
        event.createdAt >= week.start && event.createdAt < week.end &&
        Object.prototype.hasOwnProperty.call(counts, event.type)
      ) counts[event.type] += 1;
    }
    return counts;
  }

  return Object.freeze({ recordEvent, getCounts, filePath });
}

module.exports = {
  TIME_ZONE,
  REQUIREMENT_TARGETS,
  getWeekWindow,
  channelMatchesActivity,
  createRequirementsTracker,
};
