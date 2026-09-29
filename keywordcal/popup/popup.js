/**
 * KeywordCal - Toolbar popup
 * Shows engine status, lets you test/run rules against the selected message.
 */
"use strict";

const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const undoBtn = document.getElementById("undo-btn");
const pendingSection = document.getElementById("pending-section");
const pendingList = document.getElementById("pending-list");

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
  const pendingResponse = await send({ type: "keywordcal:getPendingDates" });
  const pending = pendingResponse && Array.isArray(pendingResponse.pending)
    ? pendingResponse.pending
    : [];
  renderPendingDates(pending);

  const s = await send({ type: "keywordcal:getStatus" });
  if (!s || typeof s.activeRules !== "number") {
    statusEl.textContent = (s && s.error) || "Background unavailable.";
    statusEl.classList.add("warn");
    return;
  }
  const lines = [`${s.activeRules}/${s.totalRules} rule(s) active`];
  if (pending.length) lines.push(`${pending.length} date(s) need confirmation`);
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
    const count = document.createElement("strong");
    count.textContent = String(res.matches.length);
    const subject = document.createElement("strong");
    subject.textContent = res.subject;
    const list = document.createElement("ul");
    for (const match of res.matches) {
      const item = document.createElement("li");
      item.textContent = `${match.name} → ${match.actions} action(s)`;
      list.appendChild(item);
    }
    resultEl.replaceChildren("Would match ", count, " rule(s) on \"", subject, "\":", list);
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
    if (o.pendingConfirmation) return `${kind}: waiting for date confirmation`;
    if (o.ok === false) return `${kind}: error: ${o.error}`;
    return `${kind}: done`;
  };
  resultEl.className = "ok";
  resultEl.replaceChildren();
  for (const entry of firedRules) {
    const ruleName = document.createElement("strong");
    ruleName.textContent = entry.ruleName;
    resultEl.append("Rule ", ruleName, " fired:");
    const list = document.createElement("ul");
    for (const outcome of entry.results || []) {
      const item = document.createElement("li");
      item.textContent = labelOutcome(outcome);
      list.appendChild(item);
    }
    resultEl.appendChild(list);
  }
  resultEl.append("Check your calendar or the notification.");
  loadStatus();
});

document.getElementById("options-btn").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
});

function renderPendingDates(entries) {
  pendingSection.hidden = entries.length === 0;
  pendingList.replaceChildren();

  for (const entry of entries) {
    const row = document.createElement("li");
    row.className = "pending-item";
    const title = document.createElement("strong");
    title.textContent = entry.item?.title || "Calendar item";
    const subject = document.createElement("p");
    subject.textContent = `From: ${entry.subject || "(no subject)"}`;
    const reason = document.createElement("p");
    reason.textContent = entry.suggestion?.reason || "Please confirm the suggested date.";
    const source = document.createElement("p");
    source.textContent = entry.suggestion?.token
      ? `Found: ${entry.suggestion.token}${entry.suggestion.candidateCount > 1 ? ` (${entry.suggestion.candidateCount} dates found)` : ""}`
      : "No date found; suggested message date shown.";
    const dateInput = document.createElement("input");
    dateInput.type = "datetime-local";
    const suggested = new Date(entry.suggestion?.date);
    if (!isNaN(suggested.getTime())) {
      dateInput.value = new Date(suggested.getTime() - suggested.getTimezoneOffset() * 60000)
        .toISOString().slice(0, 16);
    }
    dateInput.setAttribute("aria-label", `Confirm date for ${entry.item?.title || "calendar item"}`);

    const actions = document.createElement("div");
    actions.className = "pending-actions";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Approve date";
    approve.addEventListener("click", async () => {
      const date = new Date(dateInput.value);
      if (!dateInput.value || isNaN(date.getTime())) {
        reason.className = "pending-error";
        reason.textContent = "Choose a valid date before approving.";
        return;
      }
      approve.disabled = true;
      const response = await send({
        type: "keywordcal:approvePendingDate",
        pendingId: entry.id,
        date: date.toISOString(),
      });
      if (response && response.ok) {
        resultEl.className = "ok";
        resultEl.textContent = `Created "${response.title}" in ${response.calendarName}.`;
        loadStatus();
      } else {
        approve.disabled = false;
        reason.className = "pending-error";
        reason.textContent = (response && response.error) || "Could not create the calendar item.";
      }
    });
    const skip = document.createElement("button");
    skip.type = "button";
    skip.textContent = "Skip";
    skip.addEventListener("click", async () => {
      skip.disabled = true;
      const response = await send({ type: "keywordcal:skipPendingDate", pendingId: entry.id });
      if (response && response.ok) {
        resultEl.className = "ok";
        resultEl.textContent = "Skipped the pending calendar item.";
        loadStatus();
      } else {
        skip.disabled = false;
        reason.className = "pending-error";
        reason.textContent = (response && response.error) || "Could not skip the pending item.";
      }
    });
    actions.append(approve, skip);
    row.append(title, subject, reason, source, dateInput, actions);
    pendingList.appendChild(row);
  }
}

browser.storage?.local?.onChanged?.addListener((changes, areaName) => {
  if (areaName === "local" && changes.keywordcal_pending_dates) loadStatus();
});

loadStatus();
