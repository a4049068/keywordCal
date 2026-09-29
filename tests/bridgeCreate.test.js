"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync("calendar-bridge/api.js", "utf8");

test("createItem with an existing UID is idempotent", async () => {
  let addCount = 0;
  const existing = {
    hashId: 123,
    id: "calendar-item-id",
    getProperty: (name) => name === "UID" ? "keywordcal-message-uid" : "",
  };
  const calendar = {
    id: "calendar-1",
    name: "Personal",
    type: "local",
    readOnly: false,
    getItemsAsArray: async () => [existing],
    addItem: async () => { addCount += 1; },
  };
  const manager = { getCalendars: () => [calendar] };
  const context = {
    Cc: {
      "@mozilla.org/calendar/manager;1": { getService: () => manager },
    },
    Ci: { calICalendar: { ITEM_FILTER_ALL_ITEMS: 1 } },
    ChromeUtils: { importESModule: () => ({ cal: { manager } }) },
    ExtensionAPI: class {},
    console: { log() {}, warn() {}, error() {} },
  };
  vm.runInNewContext(`${source}\nglobalThis.api = new globalThis.BridgeParent().getAPI({}).BridgeParent;`, context);

  const result = await context.api.createItem({
    kind: "event",
    calendarId: "calendar-1",
    uid: "keywordcal-message-uid",
    title: "Retry",
  });
  assert.equal(result.ok, true);
  assert.equal(result.existing, true);
  assert.equal(result.id, "123");
  assert.equal(addCount, 0);
});

test("createItem lets the calendar assign the item's owning calendar", async () => {
  const item = {
    hashId: 456,
    id: "new-calendar-item",
    title: "",
    descriptionText: "",
    startDate: null,
    endDate: null,
    calendar: null,
    assignedCategories: [],
    setCategories(categories) { this.assignedCategories = categories; },
    setProperty() {},
    addAlarm() {},
  };
  Object.preventExtensions(item);

  const calendar = {
    id: "calendar-2",
    name: "Work",
    type: "local",
    readOnly: false,
    defaultTimezone: { name: "UTC" },
    addItem: async (newItem) => {
      newItem.calendar = calendar;
      return newItem;
    },
  };
  const manager = { getCalendars: () => [calendar] };
  const context = {
    Cc: {
      "@mozilla.org/calendar/event;1": { createInstance: () => item },
      "@mozilla.org/calendar/datetime;1": { createInstance: () => ({}) },
      "@mozilla.org/calendar/timezone-service;1": {
        getService: () => { throw new Error("timezone service unavailable"); },
      },
    },
    Ci: { calIEvent: {}, calIDateTime: {}, calITimezoneService: {} },
    ChromeUtils: {
      importESModule: () => ({ cal: { manager, dtz: { floating: { name: "floating" } } } }),
    },
    ExtensionAPI: class {},
    console: { log() {}, warn() {}, error() {} },
  };
  vm.runInNewContext(`${source}\nglobalThis.api = new globalThis.BridgeParent().getAPI({}).BridgeParent;`, context);

  const result = await context.api.createItem({
    kind: "event",
    calendarId: "calendar-2",
    title: "Team meeting",
    description: "Discuss project status",
    category: "Work",
    startDate: "2026-10-01T09:00:00Z",
    endDate: "2026-10-01T10:00:00Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, "456");
  assert.equal(result.calendarName, "Work");
  assert.equal(item.title, "Team meeting");
  assert.equal(item.descriptionText, "Discuss project status");
  assert.deepEqual(Array.from(item.assignedCategories), ["Work"]);
  assert.equal(item.calendar, calendar);
  assert.equal(item.startDate.timezone.name, "floating");

  const missingDate = await context.api.createItem({
    kind: "event",
    calendarId: "calendar-2",
    title: "Invalid meeting",
  });
  assert.equal(missingDate.ok, false);
  assert.match(missingDate.error, /date value is required/);
});