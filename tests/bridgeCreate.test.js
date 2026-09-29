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
    ExtensionAPI: class {},
    console: { log() {}, warn() {}, error() {} },
  };
  vm.runInNewContext(`${source}\nglobalThis.api = new BridgeParent().getAPI({}).BridgeParent;`, context);

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