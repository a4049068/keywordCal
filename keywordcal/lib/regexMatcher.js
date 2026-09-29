"use strict";

const RegexMatcher = {
  timeoutMs: 100,
  maxPatternLength: 512,
  maxInputLength: 50000,

  _run(pattern, input, operation) {
    if (typeof pattern !== "string" || pattern.length > this.maxPatternLength) {
      return Promise.reject(new Error("regex pattern is too long or invalid"));
    }
    if (typeof input !== "string" || input.length > this.maxInputLength) {
      return Promise.reject(new Error("regex input is too long or invalid"));
    }
    if (typeof Worker !== "function") {
      return Promise.reject(new Error("isolated regex matching is unavailable"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let worker;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (worker) worker.terminate();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () => finish(new Error("regex evaluation timed out")),
        this.timeoutMs
      );

      try {
        worker = new Worker(browser.runtime.getURL("lib/regexWorker.js"));
        worker.onmessage = ({ data }) => {
          if (!data || !data.ok) {
            finish(new Error(data?.error || "regex evaluation failed"));
            return;
          }
          finish(null, data.result);
        };
        worker.onerror = (event) => {
          event.preventDefault?.();
          finish(new Error(event.message || "regex worker failed"));
        };
        worker.postMessage({ pattern, input, operation });
      } catch (error) {
        finish(error);
      }
    });
  },

  async test(pattern, input) {
    return Boolean(await this._run(pattern, input, "test"));
  },

  exec(pattern, input) {
    return this._run(pattern, input, "exec");
  },
};