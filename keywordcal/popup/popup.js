/**
 * KeywordCal - Toolbar popup
 * Shows engine status, lets you test/run rules against the selected message.
 */
"use strict";

const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");

async function loadStatus() {
  try {
    const s = await browser.runtime.sendMessage({ type: "keywordcal:getStatus" });
    const lines = [`${s.activeRules}/${s.totalRules} rule(s) active`];
    if (s.lastTriggered) {
      lines.push(`Last trigger: ${new Date(s.lastTriggered).toLocaleString()}`);
    }
    if (!s.bridgeInstalled) {
      lines.push(
        "⚠ Calendar Bridge not detected — items will open as .ics compose drafts. " +
        "Install keywordcal-bridge for silent direct calendar writes."
      );
      statusEl.classList.add("warn");
    } else {
      const names = (s.calendars || []).map((c) => c.name).join(", ");
      if (names) lines.push(`Calendars reachable: ${names}`);
    }
    statusEl.textContent = lines.join("\n");
    statusEl.style.whiteSpace = "pre-wrap";
  } catch (err) {
    statusEl.textContent = "Background unavailable: " + err;
    statusEl.classList.add("warn");
  }
}

document.getElementById("test-btn").addEventListener("click", async () => {
  resultEl.textContent = "Testing…";
  const res = await browser.runtime.sendMessage({ type: "keywordcal:runOnSelected" });
  if (!res || !res.ok) {
    resultEl.className = "err";
    resultEl.textContent = (res && res.error) || "No response from background.";
    return;
  }
  resultEl.className = "ok";
  if (res.matches.length === 0) {
    resultEl.textContent = `No rules matched "${res.subject}".`;
  } else {
    resultEl.innerHTML =
      `Would match <b>${res.matches.length}</b> rule(s) on "<b>${escapeHtml(res.subject)}</b>":<ul>` +
      res.matches.map((m) => `<li>${escapeHtml(m.name)} → ${m.actions} action(s)</li>`).join("") +
      "</ul>";
  }
});

document.getElementById("run-btn").addEventListener("click", async () => {
  resultEl.textContent = "Running…";
  const res = await browser.runtime.sendMessage({ type: "keywordcal:executeOnSelected" });
  if (!res || !res.ok) {
    resultEl.className = "err";
    resultEl.textContent = (res && res.error) || "No response from background.";
    return;
  }
  if (!res.result) {
    resultEl.className = "ok";
    resultEl.textContent = `Ran on "${res.subject}" — no rules matched.`;
    return;
  }
  const r = res.result;
  const outcomes = (r.results || []).map((x) => {
    if (!x) return "failed (see Error Console)";
    if (x.ok) return `created in "${x.calendarName || "calendar"}"`;
    if (x.fallback === "compose") return "opened .ics draft (no bridge)";
    if (x.ok === false) return `error: ${x.error}`;
    return "done";
  });
  resultEl.className = "ok";
  resultEl.innerHTML =
    `Rule <b>${escapeHtml(r.ruleName)}</b> fired:<ul>` +
    outcomes.map((o) => `<li>${escapeHtml(o)}</li>`).join("") +
    "</ul>Check your calendar or the notification.";
});

document.getElementById("options-btn").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

loadStatus();
