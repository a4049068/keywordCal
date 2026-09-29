"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync("calendar-bridge/background.js", "utf8");

function loadBridge() {
  const listeners = {};
  const calls = [];
  const event = (name) => ({ addListener: (listener) => { listeners[name] = listener; } });
  const browser = {
    storage: { local: { set: async () => {} } },
    runtime: {
      onStartup: event("startup"),
      onInstalled: event("installed"),
      onMessage: event("internal"),
      onMessageExternal: event("external"),
    },
    BridgeParent: {
      listCalendars: async () => { calls.push("listCalendars"); return []; },
      createItem: async () => { calls.push("createItem"); return { ok: true }; },
    },
  };
  const context = {
    browser,
    console: { log() {}, warn() {} },
    setTimeout,
  };
  vm.runInNewContext(`${source}\nglobalThis.bridgeHandle = handle;`, context);
  return { calls, handle: context.bridgeHandle, listeners };
}

test("registry and privileged methods reject missing or foreign senders", async () => {
  const { calls, handle } = loadBridge();
  const probe = { keywordcal: "registry" };
  const request = { method: "createItem", item: { title: "Unexpected" } };

  assert.equal(await handle(probe), undefined);
  assert.equal(await handle(probe, { id: "other-addon@example.com" }), undefined);
  assert.equal(await handle(request, { id: "other-addon@example.com" }), undefined);
  assert.deepEqual(calls, []);
});

test("the configured KeywordCal sender can discover and call the bridge", async () => {
  const { calls, handle } = loadBridge();
  const sender = { id: "keywordcal@yourdomain.com" };
  const probe = await handle({ keywordcal: "registry" }, sender);
  assert.equal(probe.extensionId, "keywordcal-bridge@yourdomain.com");

  const result = await handle({ method: "createItem", item: {} }, sender);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["createItem"]);
});

test("both runtime listeners apply the same sender check", async () => {
  const { listeners } = loadBridge();
  const message = { method: "listCalendars" };
  assert.equal(await listeners.external(message, { id: "attacker@example.com" }), undefined);
  assert.equal(await listeners.internal(message, { id: "attacker@example.com" }), undefined);
});