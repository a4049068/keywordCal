"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { Worker: NodeWorker } = require("node:worker_threads");
const test = require("node:test");
const vm = require("node:vm");

const matcherSource = readFileSync("keywordcal/lib/regexMatcher.js", "utf8");
const workerSource = readFileSync("keywordcal/lib/regexWorker.js", "utf8");

class ExtensionWorker {
  constructor() {
    const bootstrap = `
      const { parentPort } = require("node:worker_threads");
      global.self = { postMessage: (value) => parentPort.postMessage(value) };
      ${workerSource}
      parentPort.on("message", (data) => self.onmessage({ data }));
    `;
    this.worker = new NodeWorker(bootstrap, { eval: true });
    this.worker.on("message", (data) => this.onmessage?.({ data }));
    this.worker.on("error", (error) => this.onerror?.({ message: error.message }));
  }

  postMessage(data) {
    this.worker.postMessage(data);
  }

  terminate() {
    return this.worker.terminate();
  }
}

function loadMatcher(timeoutMs = 100) {
  const context = {
    Worker: ExtensionWorker,
    browser: { runtime: { getURL: () => "worker.js" } },
    clearTimeout,
    setTimeout,
  };
  vm.runInNewContext(`${matcherSource}\nglobalThis.matcher = RegexMatcher;`, context);
  context.matcher.timeoutMs = timeoutMs;
  return context.matcher;
}

test("isolated matcher supports test and capture operations", async () => {
  const matcher = loadMatcher();
  assert.equal(await matcher.test("meeting", "Team meeting tomorrow"), true);
  assert.deepEqual(await matcher.exec("(\\d{4})-(\\d{2})", "due 2026-09"), ["2026-09", "2026", "09"]);
});

test("invalid patterns reject instead of blocking matching", async () => {
  const matcher = loadMatcher();
  await assert.rejects(matcher.test("(", "input"), /Invalid regular expression/);
});

test("catastrophic backtracking is terminated at the deadline", async () => {
  const matcher = loadMatcher(50);
  const started = Date.now();
  await assert.rejects(
    matcher.test("(a+)+$", `${"a".repeat(30000)}!`),
    /timed out/
  );
  assert.ok(Date.now() - started < 1000, "timed out regex should not hold the caller");
});