/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * CalendarWriter - Creates calendar events/tasks from matched messages.
 *
 * IMPORTANT IMPLEMENTATION NOTE
 * -----------------------------
 * MailExtensions (privileged WebExtensions) have NO calendar API:
 * `browser.calendar.*` does not exist for them and Thunderbird's built-in
 * experiment APIs are unavailable in MailExtension add-ons. Earlier
 * versions of this file called browser.calendar.calendars.list(), which
 * (a) always rejected and (b) risked disturbing remote (CalDAV/Google)
 * calendars — a failed DAV_REPORT gets a calendar disabled until restart.
 *
 * This version therefore:
 *   1. Never touches the calendar subsystem directly.
 *   2. Optionally delegates to a companion "Calendar Bridge" experiment
 *      add-on (see ../calendar-bridge/) discovered via a registry message
 *      broadcast to all extensions; only that add-on (experimental:true)
 *      may use calICalendar via Cc/Ci.
 *   3. Falls back to opening an .ics attachment in a compose window
 *      (browser.composeAction.openComposeWindow), where Thunderbird's
 *      native invitation bar lets the user file the event into any
 *      calendar with one click.
 */

const BRIDGE_REGISTRY_MSG = { keywordcal: "registry" };
const BRIDGE_METHODS = ["listCalendars", "createItem"];
const BRIDGE_STORAGE_KEY = "keywordcal_bridge_id";

const CalendarWriter = {
  _bridgeId: null,
  _discoveryPromise: null,

  /**
   * Find the Calendar Bridge companion add-on. Two channels:
   *   1. Shared browser.storage.local key written by the bridge itself
   *      (works even when cross-extension messaging is blocked).
   *   2. A registry broadcast to all running extensions.
   * Returns the bridge's extension id, or null if not installed.
   */
  findBridge() {
    if (this._bridgeId) return Promise.resolve(this._bridgeId);
    if (this._discoveryPromise) return this._discoveryPromise;

    this._discoveryPromise = (async () => {
      // Channel 1: shared-storage registration.
      try {
        const data = await browser.storage.local.get(BRIDGE_STORAGE_KEY);
        const id = data[BRIDGE_STORAGE_KEY];
        if (typeof id === "string" && id.includes("@")) {
          // Sanity-check it actually answers before caching.
          try {
            const reply = await browser.runtime.sendMessage(id, BRIDGE_REGISTRY_MSG);
            if (reply && Array.isArray(reply.methods) &&
                reply.methods.some((m) => BRIDGE_METHODS.includes(m))) {
              this._bridgeId = id;
              console.log(`[KeywordCal] Calendar Bridge found (storage): ${id}`);
              return id;
            }
          } catch (e) {
            // Stale entry — clean it up so the bridge can re-register.
            await browser.storage.local.remove(BRIDGE_STORAGE_KEY).catch(() => {});
          }
        }
      } catch (e) { /* storage unavailable */ }

      // Channel 2: broadcast discovery to every extension.
      try {
        const reply = await browser.runtime.sendMessage(BRIDGE_REGISTRY_MSG);
        if (
          reply &&
          typeof reply.extensionId === "string" &&
          Array.isArray(reply.methods) &&
          reply.methods.some((m) => BRIDGE_METHODS.includes(m))
        ) {
          this._bridgeId = reply.extensionId;
          console.log(`[KeywordCal] Calendar Bridge found (broadcast): ${this._bridgeId}`);
          return this._bridgeId;
        }
      } catch (err) {
        // No listener anywhere -> rejects with "Could not establish
        // connection". That simply means the bridge isn't installed.
      }
      return null;
    })().finally(() => {
      this._discoveryPromise = null;
    });

    return this._discoveryPromise;
  },

  forgetBridge() {
    this._bridgeId = null;
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
    const bridgeId = await this.findBridge();
    if (!bridgeId) return null;
    try {
      const reply = await browser.runtime.sendMessage(bridgeId, { method: "listCalendars" });
      // A handler that returns nothing (or an unexpected payload) must not
      // be mistaken for "the bridge is broken" — keep the cached id then.
      return Array.isArray(reply) ? reply : null;
    } catch (err) {
      console.warn("[KeywordCal] Bridge listCalendars failed:", err);
      this.forgetBridge();
      return null;
    }
  },

  /**
   * Send a createItem request to the bridge. Returns the bridge's result
   * object ({ ok, id, calendarName } / { ok:false, error }) or null if no
   * bridge/failed hard.
   */
  async _bridgeCreate(item) {
    const bridgeId = await this.findBridge();
    if (!bridgeId) return null;
    try {
      const created = await browser.runtime.sendMessage(bridgeId, {
        method: "createItem",
        item,
      });
      if (created && typeof created.ok === "boolean") {
        if (created.ok && !created.calendarName) {
          created.calendarName = await this._calendarLabel(item.calendarId);
        }
        return created;
      }
      return { ok: false, error: "bridge returned an unexpected response" };
    } catch (err) {
      console.warn("[KeywordCal] Bridge createItem failed:", err);
      this.forgetBridge();
      return null;
    }
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
    // Preferred path: composeAction.openComposeWindow with a structured MIME
    // tree (text/plain intro + base64 text/calendar attachment). Thunderbird's
    // compose window recognises the .ics part and offers "Add to Calendar".
    const filename = `${safeTitle.slice(0, 40)}.ics`;
    const bodyText =
      `This ${kind} was generated by KeywordCal from a matching email.\n` +
      `Use the "Add to Calendar" button in the invitation bar below to file it.`;

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

    await browser.composeAction.openComposeWindow(null, null, "new", {
      subject: `[KeywordCal] ${safeTitle}`,
      isHtml: false,
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
