"use strict";

self.onmessage = ({ data }) => {
  try {
    const regex = new RegExp(data.pattern, "i");
    const result = data.operation === "exec"
      ? regex.exec(data.input)
      : regex.test(data.input);
    self.postMessage({ ok: true, result: result ? Array.from(result) : result });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error) });
  }
};