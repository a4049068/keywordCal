/**
 * KeywordCal - Toolbar popup
 * Shows engine status, lets you test/run rules against the selected message.
 */
"use strict";

const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const undoBtn = document.getElementById("undo-btn");

// Every sendMessage here must be wrapped: if the background script is
// momentarily unavailable (add-on just updated/reloaded), a raw await would
// throw and leave the button silently stuck on "Testing…"/"Running…".
async function send(msg) {
  try {
    return await browser.runtime.sendMessage(msg);
  } catch (err) {
    return { ok: false, error: `Background unavailable: ${err}` };
  }
}

async function loadStatus() {
  const s = await send({ type: "keywordcal:getStatus" });
  if (!s || typeof s.activeRules !== "number") {
    statusEl.textContent = (s && s.error) || "Background unavailable.";
    statusEl.classList.add("warn");
    return;
  }
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
  // Undo availability
  try {
    const u = await send({ type: "keywordcal:getUndoStatus" });
    if (u && u.available && u.entry) {
      undoBtn.disabled = false;
      undoBtn.textContent = `\u21A9 Undo: "${(u.entry.title || "").slice(0, 28)}"`;
      lines.push(`Last created: "${u.entry.title}" (${new Date(u.entry.at).toLocaleTimeString()})`);
    } else {
      undoBtn.disabled = true;
      undoBtn.textContent = "\u21A9 Undo last action";
    }
  } catch (e) { /* leave button disabled */ }

  statusEl.textContent = lines.join("\n");
  statusEl.style.whiteSpace = "pre-wrap";
}

undoBtn.addEventListener("click", async () => {
  undoBtn.disabled = true;
  resultEl.textContent = "Reverting\u2026";
  const res = await send({ type: "keywordcal:undoLast" });
  if (res && res.ok) {
    resultEl.className = "ok";
    resultEl.textContent = `Deleted "${res.title || "item"}" from ${res.calendarName || "calendar"}.`;
  } else {
    resultEl.className = "err";
    resultEl.textContent = (res && res.error) || "Undo failed \u2014 no response.";
  }
  loadStatus();
});

document.getElementById("test-btn").addEventListener("click", async () => {
  resultEl.textContent = "Testing…";
  const res = await send({ type: "keywordcal:runOnSelected" });
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
  const res = await send({ type: "keywordcal:executeOnSelected" });
  if (!res || !res.ok) {
    resultEl.className = "err";
    resultEl.textContent = (res && res.error) || "No response from background.";
    return;
  }
  const firedRules = res.result; // one entry per matched rule
  if (firedRules.length === 0) {
    resultEl.className = "ok";
    resultEl.textContent = `Ran on "${res.subject}" — no rules matched.`;
    return;
  }
  const labelOutcome = (x) => {
    const o = x && x.outcome;
    const kind = (x && x.actionType) || "action";
    if (!o) return `${kind}: failed (see Error Console)`;
    if (o.ok === true) return `${kind}: created in "${o.calendarName || "calendar"}"`;
    if (o.fallback === "compose") return `${kind}: opened .ics draft (no bridge)`;
    if (o.ok === false) return `${kind}: error: ${o.error}`;
    return `${kind}: done`;
  };
  resultEl.className = "ok";
  resultEl.innerHTML =
    firedRules
      .map(
        (entry) =>
          `Rule <b>${escapeHtml(entry.ruleName)}</b> fired:<ul>` +
          (entry.results || []).map((x) => `<li>${escapeHtml(labelOutcome(x))}</li>`).join("") +
          "</ul>"
      )
      .join("") +
    "Check your calendar or the notification.";
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
