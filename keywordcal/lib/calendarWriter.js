/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * CalendarWriter - files events/tasks from matched messages.
 *
 * Path 1 (preferred): the Calendar Bridge companion add-on writes items
 *   silently into the rule's chosen calendar. Discovery: shared
 *   browser.storage.local key "keywordcal_bridge_id" (cross-extension
 *   messaging is blocked by default prefs), then runtime.sendMessage.
 * Path 2 (fallback, no bridge): open a compose window carrying an .ics
 *   attachment; Thunderbird's "Add to calendar" bar files it for the user.
 *
 * Every step logs "[KeywordCal]" lines so the Browser Console is diagnostic.
 */

"use strict";

const BRIDGE_METHODS = ["listCalendars", "createItem", "deleteItem", "findConflicts"];
const BRIDGE_STORAGE_KEY = "keywordcal_bridge_id";
const UNDO_KEY = "keywordcal_undo_queue";
const UNDO_TTL_MS = 86400000; // undo entries expire after 24h
const UNDO_MAX = 50;
const DEDUPE_WINDOW_MS = 180000; // suppress duplicate deliveries within 3 min

// Duplicate-delivery guard (IMAP re-fetches hand us the same message twice).
// In-process Map suffices: sub-minute duplicates never survive a restart.
const _seenMessages = new Map(); // messageId -> last processed epoch ms

function shouldSkipDuplicate(messageId) {
  const now = Date.now();
  for (const [id, t] of _seenMessages) if (now - t > DEDUPE_WINDOW_MS) _seenMessages.delete(id);
  if (_seenMessages.has(messageId)) return true;
  _seenMessages.set(messageId, now);
  return false;
}

async function _getQueue() {
  const data = (await browser.storage.local.get(UNDO_KEY)) || {};
  return Array.isArray(data[UNDO_KEY]) ? data[UNDO_KEY] : [];
}

const CalendarWriter = {
  _bridgeId: null,
  _discoveryPromise: null,

  /** Find the bridge; returns its extension id or null when absent. */
  async findBridge() {
    if (this._bridgeId) return this._bridgeId;
    if (this._discoveryPromise) return this._discoveryPromise;

    this._discoveryPromise = (async () => {
      let storedId = null;
      try {
        const data = await browser.storage.local.get(BRIDGE_STORAGE_KEY);
        storedId = data && data[BRIDGE_STORAGE_KEY];
      } catch (e) {
        console.warn("[KeywordCal] bridge storage lookup failed:", e);
      }
      if (typeof storedId !== "string" || !storedId.includes("@")) {
        console.log("[KeywordCal] Calendar Bridge not registered in shared storage — " +
          "is keywordcal-bridge installed AND enabled? Will fall back to .ics drafts.");
        return null;
      }

      // Probe both channels; cache whichever answers.
      for (const [label, probe] of [
        ["targeted", () => browser.runtime.sendMessage(storedId, { keywordcal: "registry" })],
        ["broadcast", () => browser.runtime.sendMessage({ keywordcal: "registry" })],
      ]) {
        try {
          const reply = await probe();
          if (reply && typeof reply.extensionId === "string" &&
              Array.isArray(reply.methods) && reply.methods.some((m) => BRIDGE_METHODS.includes(m))) {
            this._bridgeId = reply.extensionId;
            console.log(`[KeywordCal] Calendar Bridge found (${label}): ${this._bridgeId}`);
            return this._bridgeId;
          }
          console.warn(`[KeywordCal] Bridge probe (${label}) got unexpected reply:`, reply);
        } catch (err) {
          console.log(`[KeywordCal] Bridge probe (${label}) failed: ${err} ` +
            "(expected if cross-extension messaging is blocked)");
        }
      }

      // Registered but silent: keep the stored id — direct calls either work
      // (same-origin installs) or surface their own errors later.
      console.warn(`[KeywordCal] Bridge "${storedId}" registered but unresponsive — ` +
        "using stored id for direct calls; will fall back to .ics if they fail.");
      this._bridgeId = storedId;
      return storedId;
    })().finally(() => { this._discoveryPromise = null; });

    return this._discoveryPromise;
  },

  forgetBridge() { this._bridgeId = null; },

  /** One logging/error-handling path for every bridge round-trip. */
  async _bridgeCall(payload, label) {
    const bridgeId = await this.findBridge();
    if (!bridgeId) return null;
    try {
      console.log(`[KeywordCal] -> bridge(${bridgeId}) ${label}`);
      const reply = await browser.runtime.sendMessage(bridgeId, payload);
      console.log(`[KeywordCal] <- bridge ${label}: ${JSON.stringify(reply)}`);
      return reply;
    } catch (err) {
      console.warn(`[KeywordCal] Bridge ${label} failed:`, err);
      this.forgetBridge();
      return null;
    }
  },

  // ---------- Undo queue (design doc §9) ----------

  async pushUndo(entry) {
    try {
      const queue = await _getQueue();
      queue.push({ ...entry, at: Date.now() });
      while (queue.length > UNDO_MAX) queue.shift();
      await browser.storage.local.set({ [UNDO_KEY]: queue });
      console.log(`[KeywordCal] undo queue: ${queue.length} entry(ies), last "${entry.title}"`);
    } catch (e) {
      console.warn("[KeywordCal] could not persist undo queue:", e);
    }
  },

  /** Most recent non-expired undo entry, or null. */
  async peekUndo() {
    const fresh = (await _getQueue()).filter((e) => Date.now() - (e.at || 0) < UNDO_TTL_MS);
    return fresh.length ? fresh[fresh.length - 1] : null;
  },

  /** Delete the most recent bridge-created item and drop it from the queue. */
  async undoLast() {
    const entry = await this.peekUndo();
    if (!entry) return { ok: false, error: "nothing to undo" };
    const reply = await this._bridgeCall(
      { method: "deleteItem", item: { calendarId: entry.calendarId, itemId: entry.itemId, kind: entry.kind } },
      `deleteItem "${entry.title}"`
    );
    if (!reply) return { ok: false, error: "calendar bridge unavailable" };
    if (reply.ok) {
      const queue = await _getQueue();
      const idx = queue.findIndex((e) => e.itemId === entry.itemId);
      if (idx !== -1) queue.splice(idx, 1);
      await browser.storage.local.set({ [UNDO_KEY]: queue });
      this._notify(`Reverted: deleted "${entry.title}" from ${reply.calendarName || "calendar"}.`);
    }
    return reply;
  },

  // ---------- Queries ----------

  /** [{ id, name, type, color, canWrite }] or null when no bridge answers. */
  async listCalendars() {
    const reply = await this._bridgeCall({ method: "listCalendars" }, "listCalendars");
    return Array.isArray(reply) ? reply : null; // empty handler != broken bridge
  },

  /** Display name for a calendarId / free-text name typed in options. */
  async _calendarLabel(calendarId) {
    if (!calendarId || calendarId === "default") return "Default calendar";
    const hit = (await this.listCalendars() || []).find(
      (c) => c.id === calendarId || (c.name || "") === calendarId
    );
    return hit ? hit.name : calendarId;
  },

  /**
   * Conflict detection (§9): overlapping events in [start, end). Warn-only —
   * callers must never block creation on this; [] when bridge absent.
   */
  async findConflicts(calendarId, start, end) {
    const reply = await this._bridgeCall(
      { method: "findConflicts", item: { calendarId, start: start.toISOString(), end: end.toISOString() } },
      `findConflicts(${calendarId})`
    );
    return Array.isArray(reply) ? reply.filter((e) => e && typeof e.title === "string") : [];
  },

  /** createItem via bridge; pushes onto undo queue on success. */
  async _bridgeCreate(item) {
    console.log(`[KeywordCal] -> bridge createItem "${item.title}" into "${item.calendarId}"`);
    const created = await this._bridgeCall({ method: "createItem", item }, `createItem "${item.title}"`);
    if (!created || typeof created.ok !== "boolean") {
      // Silent/stale bridge: treat as absent so callers fall back to .ics
      // drafts instead of dropping the event.
      console.warn("[KeywordCal] Bridge returned an unexpected response:", created);
      this.forgetBridge();
      return null;
    }
    if (created.ok) {
      created.calendarName ||= await this._calendarLabel(item.calendarId);
      if (created.id) {
        await this.pushUndo({ itemId: created.id, calendarId: item.calendarId, kind: item.kind, title: item.title });
      }
    }
    console.log(`[KeywordCal] <- bridge createItem: ${JSON.stringify(created)}`);
    return created;
  },

  // ---------- Item construction ----------

  /** Start date per §3.3 strategies: extract | received | fixed(+N days @9am). */
  _resolveStartDate(msg, action) {
    if (action.dateSource === "extract") {
      return DateParser.extract(msg.body, action.datePattern) || msg.date;
    }
    if (action.dateSource === "received") return msg.date;
    const d = new Date();
    const offset = Number(action.fixedOffsetDays);
    if (Number.isFinite(offset) && offset !== 0) d.setDate(d.getDate() + offset);
    d.setHours(9, 0, 0, 0);
    return d;
  },

  /** Minimal valid iCalendar doc; UTC dates so no VTIMEZONE is needed. */
  buildICS({ uid, title, description, startDate, endDate, dueDate, isTask, alarms, category }) {
    const fmt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n")
      .replace(/;/g, "\\;").replace(/,/g, "\\,");
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "PRODID:-//KeywordCal//Thunderbird//EN", "METHOD:PUBLISH",
      isTask ? "BEGIN:VTODO" : "BEGIN:VEVENT",
      `UID:${uid}`, `DTSTAMP:${fmt(new Date())}`,
    ];
    if (isTask) {
      if (dueDate) lines.push(`DUE:${fmt(dueDate)}`);
      lines.push("STATUS:NEEDS-ACTION");
    } else {
      lines.push(`DTSTART:${fmt(startDate)}`, `DTEND:${fmt(endDate)}`);
    }
    lines.push(`SUMMARY:${esc(title)}`);
    if (description) lines.push(`DESCRIPTION:${esc(description)}`);
    if (category) lines.push(`CATEGORIES:${esc(category)}`);
    for (const mins of alarms || []) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-PT${mins}M`,
        `DESCRIPTION:${esc(title)}`, "END:VALARM");
    }
    lines.push(isTask ? "END:VTODO" : "END:VEVENT", "END:VCALENDAR", "");
    return lines.join("\r\n");
  },

  /** Compose window carrying the item as an .ics attachment (fallback path). */
  async createViaCompose(icsText, title, kind) {
    const safeTitle = (title || "KeywordCal item").replace(/[^\w \-]+/g, "").trim() || "event";
    const structured = {
      contentType: "multipart/mixed",
      parts: [
        {
          contentType: "text/plain", encoding: "7bit",
          content: `This ${kind} was generated by KeywordCal from a matching email.\n` +
            "Open the attached .ics file to add it to any calendar.",
        },
        {
          contentType: "text/calendar", encoding: "base64",
          content: btoa(String.fromCharCode(...new TextEncoder().encode(icsText))),
          disposition: "attachment", fileName: `${safeTitle.slice(0, 40)}.ics`,
        },
      ],
    };
    // identity null picks the default account.
    await browser.compose.openComposeWindow(null, "new", {
      subject: `[KeywordCal] ${safeTitle}`, isHtml: false, bodyText: "", structured,
    });
  },

  // ---------- Actions ----------

  /** Shared flow for createEvent/createTask: bridge first, .ics fallback. */
  async _fileItem(msg, action, { kind, defaultDuration, checkConflicts }) {
    const title = TemplateResolver.resolve(action.titleTemplate, msg) || msg.subject || `KeywordCal ${kind}`;
    const description = TemplateResolver.resolve(action.descriptionTemplate, msg);
    const calendarId = action.calendarId || "default";
    const alarms = action.reminderMinutes || [];
    const uid = `keywordcal-${msg.id}-${Date.now()}@keywordcal.local`;

    let startDate = null, endDate = null, dueDate = null;
    if (kind === "task") {
      dueDate = this._resolveStartDate(msg, action);
    } else {
      startDate = this._resolveStartDate(msg, action);
      if (!startDate) {
        this._notify(`Could not determine a date for "${title}" — skipped.`);
        return { ok: false, error: "no date could be determined" };
      }
      endDate = new Date(startDate.getTime() + (action.durationMinutes ?? defaultDuration) * 60000);
    }

    const created = await this._bridgeCreate(kind === "task"
      ? { kind, calendarId, uid, title, description, dueDate: dueDate ? dueDate.toISOString() : null, alarms, category: action.category || null }
      : { kind, calendarId, uid, title, description, startDate: startDate.toISOString(), endDate: endDate.toISOString(), alarms, category: action.category || null });

    if (created && created.ok) {
      console.log(`[KeywordCal] ${kind} created via bridge: "${title}" (${created.id})`);
      if (checkConflicts) {
        try {
          const conflicts = await this.findConflicts(calendarId, startDate, endDate);
          if (conflicts.length) {
            const names = conflicts.map((c) => `"${c.title}"`).join(", ");
            console.warn(`[KeywordCal] ${conflicts.length} overlapping event(s): ${names}`);
            this._notify(`Heads-up: "${title}" overlaps ${names}`);
          }
        } catch (e) { /* best-effort; never fails creation */ }
      }
      this._notify(`${kind === "task" ? "Task" : "Event"} created in "${created.calendarName || "calendar"}": "${title}"`);
      return created;
    }
    if (created) {
      // Bridge present but refused (e.g. unknown calendar) — surface it.
      console.warn(`[KeywordCal] Bridge refused ${kind}:`, created.error);
      this._notify(`Calendar error: ${created.error}`);
      return created;
    }

    try {
      const ics = this.buildICS({ uid, title, description, startDate, endDate, dueDate, isTask: kind === "task", alarms, category: action.category });
      await this.createViaCompose(ics, title, kind);
      this._notify(`No calendar bridge found — opened an .ics draft for: "${title}"`);
      return { fallback: "compose" };
    } catch (err) {
      console.error(`[KeywordCal] Failed to create ${kind}:`, err);
      return null;
    }
  },

  createEvent(msg, action) {
    return this._fileItem(msg, action, { kind: "event", defaultDuration: 60, checkConflicts: true });
  },

  createTask(msg, action) {
    return this._fileItem(msg, action, { kind: "task", checkConflicts: false });
  },

  /** Reminder-only: zero-duration event. */
  createReminder(msg, action) {
    return this.createEvent(msg, { ...action, durationMinutes: 0 });
  },

  _notify(message) {
    try {
      const p = browser.notifications.create({
        type: "basic", title: "KeywordCal", message, iconUrl: "icons/icon-32.png",
      });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) { /* notifications are best-effort */ }
  },
};
