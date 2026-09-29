"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync("keywordcal/lib/dateParser.js", "utf8");

function loadParser() {
  const context = {
    RegexMatcher: { exec: async () => null },
    console: { warn() {} },
  };
  vm.runInNewContext(`${source}\nglobalThis.parser = DateParser;`, context);
  return context.parser;
}

test("yearless dates default to the message year and require review", async () => {
  const parser = loadParser();
  const result = await parser.extract("Deadline: 10/01", null, {
    messageDate: new Date("2019-06-01T12:00:00Z"),
    yearPolicy: "message-year",
  });
  assert.equal(result.date.getFullYear(), 2019);
  assert.equal(result.yearInferred, true);
  assert.equal(result.uncertain, true);
});

test("yearless leap days are parsed in the selected year", async () => {
  const parser = loadParser();
  const result = await parser.extract("Event on Feb 29", null, {
    messageDate: new Date("2020-01-01T12:00:00Z"),
    yearPolicy: "message-year",
  });
  assert.equal(result.date.getFullYear(), 2020);
  assert.equal(result.date.getMonth(), 1);
  assert.equal(result.date.getDate(), 29);
});

test("explicit ISO dates stay certain and preserve their year", async () => {
  const parser = loadParser();
  const result = await parser.extract("Deadline: 2026-10-01", null, {
    messageDate: new Date("2019-06-01T12:00:00Z"),
  });
  assert.equal(result.date.getFullYear(), 2026);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.uncertain, false);
});

test("named dates with two-digit years stay explicit", async () => {
  const parser = loadParser();
  const result = await parser.extract("Deadline: Oct 1, 26", null, {
    messageDate: new Date("2019-06-01T12:00:00Z"),
  });
  assert.equal(result.date.getFullYear(), 2026);
  assert.equal(result.yearInferred, false);
});

test("multiple distinct date candidates require review", async () => {
  const parser = loadParser();
  const result = await parser.extract("Choose 10/01 or 10/03", null, {
    messageDate: new Date("2026-06-01T12:00:00Z"),
  });
  assert.equal(result.candidateCount, 2);
  assert.equal(result.uncertain, true);
});

test("upcoming policy advances yearless dates that already passed", async () => {
  const parser = loadParser();
  const result = await parser.extract("Deadline: 1/1", null, {
    messageDate: new Date("2019-06-01T12:00:00Z"),
    yearPolicy: "upcoming",
  });
  assert.ok(result.date >= new Date(new Date().getFullYear(), 0, 1));
  assert.equal(result.yearInferred, true);
});

test("named month ranges and compressed weekend lists stay distinct", async () => {
  const parser = loadParser();
  const result = await parser.extract(
    "Set-Up Weekend (October 2-4): Weekends one, two and three " +
      "(October 9-11, 16-18, and 23-25): Fall Festival (October 31)",
    null,
    { messageDate: new Date("2026-09-29T18:36:45Z") }
  );

  assert.equal(result.date.getFullYear(), 2026);
  assert.equal(result.date.getMonth(), 9);
  assert.equal(result.date.getDate(), 2);
  assert.equal(result.candidateCount, 9);
  assert.equal(result.uncertain, true);
});
