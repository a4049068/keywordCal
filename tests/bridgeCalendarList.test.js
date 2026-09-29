"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync("calendar-bridge/api.js", "utf8");

test("listCalendars returns only normalized data fields", async () => {
  const manager = {
    getCalendars: () => [{
      id: "cal-1",
      name: "Personal",
      type: "local",
      readOnly: false,
      getProperty: () => ({ toString: () => "#123456" }),
    }],
  };
  const context = {
    Cc: { "@mozilla.org/calendar/manager;1": { getService: () => manager } },
    Ci: { calICalendarManager: {} },
    ChromeUtils: { importESModule: () => ({ cal: { manager } }) },
    ExtensionAPI: class {},
    console: { log() {}, warn() {}, error() {} },
  };
  vm.runInNewContext(`${source}\nglobalThis.api = new globalThis.BridgeParent().getAPI({}).BridgeParent;`, context);

  const result = await context.api.listCalendars();
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "cal-1");
  assert.equal(result[0].name, "Personal");
  assert.equal(result[0].type, "local");
  assert.equal(result[0].color, "#123456");
  assert.equal(result[0].canWrite, true);
  assert.equal(JSON.stringify(result), '[{"id":"cal-1","name":"Personal","type":"local","color":"#123456","canWrite":true}]');
});