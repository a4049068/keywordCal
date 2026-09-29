/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * CalendarWriter - Creates calendar events/tasks from matched messages.
 *
 * How it works (two paths, tried in order):
 *   1. Calendar Bridge add-on (../calendar-bridge/): a companion privileged
 *      experiment add-on that files items silently into the exact calendar
 *      each rule selects. KeywordCal finds it through a shared
 *      browser.storage.local key the bridge writes about itself ("primary"
 *      channel — cross-extension messaging is blocked by Thunderbird's
 *      default privacy prefs), then talks to it via runtime.sendMessage.
 *   2. Fallback (no bridge installed): open a compose window carrying the
 *      item as an .ics attachment (browser.compose.openComposeWindow); the
 *      user files it via Thunderbird's native "Add to calendar" bar.
 *
 * Every step logs "[KeywordCal]" lines so the Browser Console shows exactly
 * what happened and why.
 */

const BRIDGE_REGISTRY_MSG = { keywordcal: "registry" };
const BRIDGE_METHODS = ["listCalendars", "createItem", "deleteItem", "findConflicts"];
const BRIDGE_STORAGE_KEY = "keywordcal_bridge_id";

// Undo queue (design doc §9): every item the bridge files for us is pushed
// here so the user can revert the most recent one from the toolbar popup.
const UNDO_KEY = "keywordcal_undo_queue";
const UNDO_TTL_MS = 24 * 60 * 60 * 1000; // entries older than a day expire
const UNDO_MAX = 50;

// Duplicate-delivery guard (design doc §9 rate limiting): IMAP re-fetches and
// folder resyncs can hand us the same message twice within seconds. One
// in-process Map suffices — its sole purpose is suppressing sub-minute
// duplicates, which never survive a restart anyway.
const DEDUPE_WINDOW_MS = 3 * 60 * 1000;
const _seenMessages = new Map(); // messageId -> last processed epoch ms

function shouldSkipDuplicate(messageId) {
  const now = Date.now();
  for (const [id, t] of _seenMessages) {
    if (now - t > DEDUPE_WINDOW_MS) _seenMessages.delete(id);
  }
  if (_seenMessages.has(messageId)) return true;
  _seenMessages.set(messageId, now);
  return false;
}

const CalendarWriter = {
  _bridgeId: null,
  _discoveryPromise: null,

  /**
   * Find the Calendar Bridge companion add-on. Returns its extension id,
   * or null if it is not installed / not answering.
   */
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
        console.log(
          "[KeywordCal] Calendar Bridge not registered in shared storage — " +
          "is keywordcal-bridge installed AND enabled? Will fall back to .ics drafts."
        );
        return null;
      }

      // Probe it. If the bridge answers on ANY channel, cache its id.
      // Note: sendMessage to another extension normally requires the
      // privileged-collaboration pref; same-origin unpacked installs answer
      // regardless, so we try both targeted and broadcast and log results.
      const probes = [
        ["targeted", () => browser.runtime.sendMessage(storedId, BRIDGE_REGISTRY_MSG)],
        ["broadcast", () => browser.runtime.sendMessage(BRIDGE_REGISTRY_MSG)],
      ];
      for (const [label, probe] of probes) {
        try {
          const reply = await probe();
          if (
            reply &&
            typeof reply.extensionId === "string" &&
            Array.isArray(reply.methods) &&
            reply.methods.some((m) => BRIDGE_METHODS.includes(m))
          ) {
            this._bridgeId = reply.extensionId;
            console.log(`[KeywordCal] Calendar Bridge found (${label}): ${this._bridgeId}`);
            return this._bridgeId;
          }
          console.warn(`[KeywordCal] Bridge probe (${label}) got unexpected reply:`, reply);
        } catch (err) {
          console.log(
            `[KeywordCal] Bridge probe (${label}) failed: ${err} ` +
            "(expected if cross-extension messaging is blocked)"
          );
        }
      }

      // Storage says the bridge exists but nothing answered. Keep using the
      // stored id anyway: method calls below go straight to it and will
      // either work (same-origin) or surface their own errors.
      console.warn(
        `[KeywordCal] Bridge "${storedId}" registered but unresponsive — ` +
        "using stored id for direct calls; will fall back to .ics if they fail."
      );
      this._bridgeId = storedId;
      return storedId;
    })().finally(() => {
      this._discoveryPromise = null;
    });

    return this._discoveryPromise;
  },

  forgetBridge() {
    this._bridgeId = null;
  },

  /**
   * Send a method request to the bridge. Returns the reply, or null when no
   * bridge is available / it failed hard (caller decides on fallback).
   */
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

  // ---------- Undo queue ----------

  async pushUndo(entry) {
    // entry: { itemId, calendarId, kind, title, at }
    try {
      const data = (await browser.storage.local.get(UNDO_KEY)) || {};
      const queue = Array.isArray(data[UNDO_KEY]) ? data[UNDO_KEY] : [];
      queue.push({ ...entry, at: Date.now() });
      while (queue.length > UNDO_MAX) queue.shift();
      await browser.storage.local.set({ [UNDO_KEY]: queue });
      console.log(`[KeywordCal] undo queue: ${queue.length} entr(y/ies), last "${entry.title}"`);
    } catch (e) {
      console.warn("[KeywordCal] could not persist undo queue:", e);
    }
  },

  /** Most recent non-expired undo entry, or null. */
  async peekUndo() {
    const data = (await browser.storage.local.get(UNDO_KEY)) || {};
    const queue = Array.isArray(data[UNDO_KEY]) ? data[UNDO_KEY] : [];
    const fresh = queue.filter((e) => Date.now() - (e.at || 0) < UNDO_TTL_MS);
    return fresh.length ? fresh[fresh.length - 1] : null;
  },

  /**
   * Delete the most recent bridge-created item. Returns
   * { ok:true, title } | { ok:false, error } | null (no bridge / nothing to undo).
   */
  async undoLast() {
    const entry = await this.peekUndo();
    if (!entry) return { ok: false, error: "nothing to undo" };
    const reply = await this._bridgeCall(
      { method: "deleteItem", item: { calendarId: entry.calendarId, itemId: entry.itemId, kind: entry.kind } },
      `deleteItem "${entry.title}"`
    );
    if (!reply) return { ok: false, error: "calendar bridge unavailable" };
    if (reply.ok) {
      // Drop exactly this entry from the queue.
      const data = (await browser.storage.local.get(UNDO_KEY)) || {};
      const queue = Array.isArray(data[UNDO_KEY]) ? data[UNDO_KEY] : [];
      const idx = queue.findIndex((e) => e.itemId === entry.itemId);
      if (idx !== -1) queue.splice(idx, 1);
      await browser.storage.local.set({ [UNDO_KEY]: queue });
      this._notify(`Reverted: deleted "${entry.title}" from ${reply.calendarName || "calendar"}.`);
    }
    return reply;
  },

  /**
   * Resolve an action's calendarId ("default", a bridge calendar id, or a
   * free-text name typed in the options UI) to a human-readable display
   * name. Falls back to "Default calendar" / the raw string when unknown.
   */
  async _calendarLabel(calendarId) {
    if (!calendarId || calendarId === "default") return "Default calendar";
    const calendars = await this.listCalendars();
    const hit = (calendars || []).find(
      (c) => c.id === calendarId || (c.name || "") === calendarId
    );
    return hit ? hit.name : calendarId;
  },

  /**
   * List calendars via the bridge. Returns [{ id, name, type, color, canWrite }]
   * or null when no bridge is available.
   */
  async listCalendars() {
    const reply = await this._bridgeCall({ method: "listCalendars" }, "listCalendars");
    // A handler that returns nothing (or an unexpected payload) must not be
    // mistaken for "the bridge is broken" — keep the cached id then.
    return Array.isArray(reply) ? reply : null;
  },

  /**
   * Conflict detection (design doc §9): ask the bridge for events in the
   * target calendar overlapping [start, end). Returns [{ title, startDate,
   * endDate }] (never includes the just-created item itself), or [] when the
   * bridge is unavailable / has nothing to report. Warn-only by design —
   * callers must never block creation on this.
   */
  async findConflicts(calendarId, start, end) {
    const reply = await this._bridgeCall(
      { method: "findConflicts", item: { calendarId, start: start.toISOString(), end: end.toISOString() } },
      `findConflicts(${calendarId})`
    );
    if (!Array.isArray(reply)) return [];
    return reply.filter((e) => e && typeof e.title === "string");
  },

  /**
   * Send a createItem request to the bridge. Returns the bridge's result
   * object ({ ok, id, calendarName } / { ok:false, error }) or null if no
   * bridge/failed hard. On success the item is pushed onto the undo queue.
   */
  async _bridgeCreate(item) {
    console.log(`[KeywordCal] -> bridge createItem "${item.title}" into "${item.calendarId}"`);
    const created = await this._bridgeCall({ method: "createItem", item }, `createItem "${item.title}"`);
    if (created && typeof created.ok === "boolean") {
      if (created.ok) {
        if (!created.calendarName) {
          created.calendarName = await this._calendarLabel(item.calendarId);
        }
        if (created.id) {
          await this.pushUndo({
            itemId: created.id,
            calendarId: item.calendarId,
            kind: item.kind,
            title: item.title,
          });
        }
      }
      console.log(`[KeywordCal] <- bridge createItem: ${JSON.stringify(created)}`);
      return created;
    }
    // An unresponsive/updated bridge answers with undefined — treat as
    // absent so the caller falls back to the .ics compose draft instead
    // of silently dropping the event.
    console.warn("[KeywordCal] Bridge returned an unexpected response:", created);
    this.forgetBridge();
    return null;
  },

  /**
   * Resolve the start date for an action, per §3.3 date-source strategies.
   */
  _resolveStartDate(msg, action) {
    if (action.dateSource === "extract") {
      return DateParser.extract(msg.body, action.datePattern) || msg.date;
    }
    if (action.dateSource === "received") {
      return msg.date;
    }
    // "fixed": static offset in days from now (action.fixedOffsetDays).
    const d = new Date();
    const offset = Number(action.fixedOffsetDays);
    if (Number.isFinite(offset) && offset !== 0) {
      d.setDate(d.getDate() + offset);
    }
    d.setHours(9, 0, 0, 0);
    return d;
  },

  /**
   * Build a minimal, valid iCalendar document for one event/task.
   * Dates are emitted as UTC (Z suffix) so no VTIMEZONE block is needed.
   */
  buildICS({ uid, title, description, startDate, endDate, dueDate, isTask, alarms, category }) {
    const fmt = (d) =>
      d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const esc = (s) =>
      String(s || "")
        .replace(/\\/g, "\\\\")
        .replace(/\n/g, "\\n")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,");

    const stamp = fmt(new Date());
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//KeywordCal//Thunderbird//EN",
      "METHOD:PUBLISH",
      isTask ? "BEGIN:VTODO" : "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
    ];

    if (isTask) {
      if (dueDate) lines.push(`DUE:${fmt(dueDate)}`);
      lines.push("STATUS:NEEDS-ACTION");
    } else {
      lines.push(`DTSTART:${fmt(startDate)}`);
      lines.push(`DTEND:${fmt(endDate)}`);
    }

    lines.push(`SUMMARY:${esc(title)}`);
    if (description) lines.push(`DESCRIPTION:${esc(description)}`);
    if (category) lines.push(`CATEGORIES:${esc(category)}`);

    for (const mins of alarms || []) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `TRIGGER:-PT${mins}M`,
        `DESCRIPTION:${esc(title)}`,
        "END:VALARM"
      );
    }

    lines.push(isTask ? "END:VTODO" : "END:VEVENT", "END:VCALENDAR", "");
    return lines.join("\r\n");
  },

  /**
   * Open a pre-filled compose window carrying the item as an .ics
   * attachment. Thunderbird detects the text/calendar part and shows its
   * "Add to calendar"/invitation bar, letting the user file the event into any
   * calendar with one click.
   */
  async createViaCompose(icsText, title, kind) {
    const safeTitle =
      (title || "KeywordCal item").replace(/[^\w \-]+/g, "").trim() || "event";
    const filename = `${safeTitle.slice(0, 40)}.ics`;
    const bodyText =
      `This ${kind} was generated by KeywordCal from a matching email.\n` +
      `Open the attached .ics file to add it to any calendar.`;

    const structured = {
      contentType: "multipart/mixed",
      parts: [
        { contentType: "text/plain", encoding: "7bit", content: bodyText },
        {
          contentType: "text/calendar",
          encoding: "base64",
          content: this._b64(icsText),
          disposition: "attachment",
          fileName: filename,
        },
      ],
    };

    // openComposeWindow(gIdentityId, msgComposeType, subject?, body?, structured?)
    // — identity null picks the default account.
    await browser.compose.openComposeWindow(null, "new", {
      subject: `[KeywordCal] ${safeTitle}`,
      isHtml: false,
      bodyText: "",
      structured,
    });
  },

  _b64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  },

  /**
   * Create a calendar event. Uses the Calendar Bridge for direct, silent
   * writes into the chosen calendar; falls back to an .ics compose draft
   * when the bridge isn't installed. Never throws to the caller.
   */
  async createEvent(msg, action) {
    const title =
      TemplateResolver.resolve(action.titleTemplate, msg) || msg.subject || "KeywordCal event";
    const description = TemplateResolver.resolve(action.descriptionTemplate, msg);

    const startDate = this._resolveStartDate(msg, action);
    if (!startDate) {
      this._notify(`Could not determine a date for "${title}" — skipped.`);
      return { ok: false, error: "no date could be determined" };
    }
    const durationMinutes = action.durationMinutes ?? 60;
    const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
    const alarms = action.reminderMinutes || [];
    const uid = `keywordcal-${msg.id}-${Date.now()}@keywordcal.local`;

    const created = await this._bridgeCreate({
      kind: "event",
      calendarId: action.calendarId || "default",
      uid,
      title,
      description,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      alarms,
      category: action.category || null,
    });
    if (created && created.ok) {
      console.log(`[KeywordCal] Event created via bridge: "${title}" (${created.id})`);
      // Conflict detection (design doc §9): warn — never block — when the
      // target calendar already holds an event overlapping this window.
      try {
        const conflicts = await CalendarWriter.findConflicts(
          action.calendarId || "default", startDate, endDate
        );
        if (conflicts.length) {
          const names = conflicts.map((c) => `"${c.title}"`).join(", ");
          console.warn(`[KeywordCal] ${conflicts.length} overlapping event(s) in target calendar: ${names}`);
          this._notify(`Heads-up: "${title}" overlaps ${names}`);
        }
      } catch (e) {
        /* conflict check is best-effort; never fails creation */
      }
      this._notify(`Event created in "${created.calendarName || "calendar"}": "${title}"`);
      return created;
    }
    if (created && !created.ok) {
      // Bridge present but refused (e.g. unknown calendar name). Surface it.
      console.warn("[KeywordCal] Bridge refused event:", created.error);
      this._notify(`Calendar error: ${created.error}`);
      return created;
    }

    try {
      const ics = this.buildICS({
        uid, title, description, startDate, endDate,
        isTask: false, alarms, category: action.category,
      });
      await this.createViaCompose(ics, title, "event");
      this._notify(`No calendar bridge found — opened an .ics draft for: "${title}"`);
      return { fallback: "compose" };
    } catch (err) {
      console.error("[KeywordCal] Failed to create event:", err);
      return null;
    }
  },

  /**
   * Create a calendar task (VTODO). Same bridge-first/compose-fallback
   * strategy as createEvent.
   */
  async createTask(msg, action) {
    const title =
      TemplateResolver.resolve(action.titleTemplate, msg) || msg.subject || "KeywordCal task";
    const description = TemplateResolver.resolve(action.descriptionTemplate, msg);

    let dueDate = null;
    if (action.dateSource === "extract") {
      // Fall back to the message date when nothing parseable is found —
      // same behaviour as events, so tasks never end up undated.
      dueDate = DateParser.extract(msg.body, action.datePattern) || msg.date;
    } else if (action.dateSource === "received") {
      dueDate = msg.date;
    } else if (action.dateSource === "fixed") {
      dueDate = this._resolveStartDate(msg, action);
    }

    const alarms = action.reminderMinutes || [];
    const uid = `keywordcal-${msg.id}-${Date.now()}@keywordcal.local`;

    const created = await this._bridgeCreate({
      kind: "task",
      calendarId: action.calendarId || "default",
      uid,
      title,
      description,
      dueDate: dueDate ? dueDate.toISOString() : null,
      alarms,
      category: action.category || null,
    });
    if (created && created.ok) {
      console.log(`[KeywordCal] Task created via bridge: "${title}" (${created.id})`);
      this._notify(`Task created in "${created.calendarName || "calendar"}": "${title}"`);
      return created;
    }
    if (created && !created.ok) {
      console.warn("[KeywordCal] Bridge refused task:", created.error);
      this._notify(`Calendar error: ${created.error}`);
      return created;
    }

    try {
      const ics = this.buildICS({
        uid, title, description, dueDate,
        isTask: true, alarms, category: action.category,
      });
      await this.createViaCompose(ics, title, "task");
      this._notify(`No calendar bridge found — opened an .ics draft for: "${title}"`);
      return { fallback: "compose" };
    } catch (err) {
      console.error("[KeywordCal] Failed to create task:", err);
      return null;
    }
  },

  /**
   * Reminder-only: zero-duration event.
   */
  async createReminder(msg, action) {
    const cloned = { ...action, durationMinutes: 0 };
    return this.createEvent(msg, cloned);
  },

  _notify(message) {
    try {
      // notifications.create() returns a promise; swallow rejections so a
      // failed notification never surfaces as an unhandled rejection.
      const p = browser.notifications.create({
        type: "basic",
        title: "KeywordCal",
        message,
        iconUrl: "icons/icon-32.png",
      });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      /* notifications are best-effort */
    }
  },
};
