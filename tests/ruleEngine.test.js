"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync("keywordcal/lib/ruleEngine.js", "utf8");

function loadEngine() {
  const context = {
    CalendarWriter: {},
    RegexMatcher: {
      test: async (pattern, input) => new RegExp(pattern, "i").test(input),
    },
    RuleStore: {},
    console: { log() {}, warn() {} },
  };
  vm.runInNewContext(`${source}\nglobalThis.engine = RuleEngine;`, context);
  return context.engine;
}

test("header conditions match the operand after the separator", async () => {
  const engine = loadEngine();
  const message = { headers: { "X-Priority": ["Urgent"] } };

  assert.equal(await engine._evaluateCondition(message, {
    field: "header",
    operator: "matches",
    value: "x-priority::^urgent$",
  }), true);
  assert.equal(await engine._evaluateCondition(message, {
    field: "header",
    operator: "contains",
    value: "X-Priority::gent",
  }), true);
});

test("malformed header conditions fail closed", async () => {
  const engine = loadEngine();
  assert.equal(await engine._evaluateCondition({ headers: {} }, {
    field: "header",
    operator: "contains",
    value: "X-Priority",
  }), false);
});