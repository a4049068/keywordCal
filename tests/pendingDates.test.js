"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync("keywordcal/lib/calendarWriter.js", "utf8");

function loadWriter(extractedDate = {
  date: new Date("2020-10-01T09:00:00Z"),
  token: "10/01",
  source: "heuristic",
  yearInferred: true,
  candidateCount: 1,
  uncertain: true,
}) {
  const stored = {};
  const context = {
    browser: {
      storage: {
        local: {
          get: async (key) => ({ [key]: stored[key] }),
          set: async (values) => Object.assign(stored, values),
        },
      },
      notifications: { create: async () => "notification" },
    },
    console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID },
    Date,
    Map,
    Set,
    DateParser: { extract: async () => extractedDate },
    TemplateResolver: { resolve: (template) => template || "" },
  };
  vm.runInNewContext(`${source}\nglobalThis.writer = CalendarWriter;`, context);
  context.writer._notify = () => {};
  return { stored, writer: context.writer };
}

test("pending items are deduplicated, editable, and removed only after success", async () => {
  const { stored, writer } = loadWriter();
  const message = {
    id: "mail-1",
    subject: "Project deadline",
    body: "Due 10/01",
    date: new Date("2020-06-01T12:00:00Z"),
  };
  const action = {
    titleTemplate: "{subject}",
    dateSource: "extract",
    calendarId: "default",
    reminderMinutes: [],
    durationMinutes: 30,
  };

  const first = await writer.createEvent(message, action);
  const duplicate = await writer.createEvent(message, action);
  assert.equal(first.pendingConfirmation, true);
  assert.equal(duplicate.pendingId, first.pendingId);
  assert.equal((await writer.getPendingDates()).length, 1);
  assert.equal("body" in stored.keywordcal_pending_dates[0], false);

  let createdItem;
  writer._createResolvedItem = async (item) => {
    createdItem = item;
    return { ok: true, calendarName: "Personal" };
  };
  const editedDate = "2026-11-03T15:45:00.000Z";
  const approved = await writer.approvePendingDate(first.pendingId, editedDate);
  assert.equal(approved.ok, true);
  assert.equal(createdItem.startDate, editedDate);
  assert.equal(createdItem.endDate, "2026-11-03T16:15:00.000Z");
  assert.equal((await writer.getPendingDates()).length, 0);
});

test("failed creation remains pending and skip removes the item", async () => {
  const { writer } = loadWriter();
  const result = await writer.createTask({
    id: "mail-2",
    subject: "Task",
    body: "Due 10/01",
    date: new Date("2020-06-01T12:00:00Z"),
  }, {
    titleTemplate: "Task",
    dateSource: "extract",
    calendarId: "default",
    reminderMinutes: [],
  });
  writer._createResolvedItem = async () => ({ ok: false, error: "calendar unavailable" });

  const failed = await writer.approvePendingDate(result.pendingId, "2026-11-03T15:45:00Z");
  assert.equal(failed.ok, false);
  assert.equal((await writer.getPendingDates()).length, 1);
  assert.equal((await writer.skipPendingDate(result.pendingId)).ok, true);
  assert.equal((await writer.getPendingDates()).length, 0);
});

test("missing dates are queued while clear explicit dates write immediately", async () => {
  const message = {
    id: "mail-3",
    subject: "Schedule",
    body: "No usable date",
    date: new Date("2026-09-01T12:00:00Z"),
  };
  const action = {
    titleTemplate: "{subject}",
    dateSource: "extract",
    calendarId: "default",
    reminderMinutes: [],
    durationMinutes: 30,
  };
  const missing = loadWriter(null);
  const queued = await missing.writer.createEvent(message, action);
  assert.equal(queued.pendingConfirmation, true);
  assert.match((await missing.writer.getPendingDates())[0].suggestion.reason, /No date was identified/);

  const clear = loadWriter({
    date: new Date("2026-10-01T09:00:00Z"),
    token: "2026-10-01",
    source: "heuristic",
    yearInferred: false,
    candidateCount: 1,
    uncertain: false,
  });
  let written = false;
  clear.writer._createResolvedItem = async () => { written = true; return { ok: true }; };
  const created = await clear.writer.createEvent(message, action);
  assert.equal(created.ok, true);
  assert.equal(written, true);
  assert.equal((await clear.writer.getPendingDates()).length, 0);
});