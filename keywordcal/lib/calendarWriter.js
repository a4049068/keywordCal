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

const CalendarWriter = {
  _bridgeId: null,
  _discoveryPromise: null,

  /**
   * Ask every running extension whether it is the KeywordCal Calendar
   * Bridge. Returns the bridge's extension id, or null if not installed.
   */
  findBridge() {
    if (this._bridgeId) return Promise.resolve(this._bridgeId);
    if (this._discoveryPromise) return this._discoveryPromise;

    this._discoveryPromise = (async () => {
      try {
        const reply = await browser.runtime.sendMessage(BRIDGE_REGISTRY_MSG);
        if (
          reply &&
          typeof reply.extensionId === "string" &&
          Array.isArray(reply.methods) &&
          reply.methods.some((m) => BRIDGE_METHODS.includes(m))
        ) {
          this._bridgeId = reply.extensionId;
          console.log(`[KeywordCal] Calendar Bridge found: ${this._bridgeId}`);
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
   * Resolve the start date for an action, per §3.3 date-source strategies.
   */
  _resolveStartDate(msg, action) {
    if (action.dateSource === "extract") {
      return DateParser.extract(msg.body, action.datePattern) || msg.date;
    }
    if (action.dateSource === "received") {
      return msg.date;
    }
    return new Date();
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
   * "Add to calendar"/invitation bar, letting the user pick the target
   * calendar without any privileged access from this add-on.
   */
  async createViaCompose(icsText, title, kind) {
    const safeTitle =
      (title || "KeywordCal item").replace(/[^\w \-]+/g, "").trim() || "event";
    const filename = `${safeTitle.slice(0, 40)}.ics`;
    const bodyText =
      `This ${kind} was generated by KeywordCal from a matching email.\n` +
      `Use the "Add to Calendar" button in the invitation bar below to file it.`;

    // Thunderbird's MIME composition API: build the message with the .ics
    // as a base64 text/calendar attachment, then hand the structured MIME
    // tree to a new compose window. Thunderbird detects the calendar part
    // and shows its invitation bar with an "Add to Calendar" button.
    const parts = [];
    const flatten = (p) => { p.parts ? p.parts.forEach(flatten) : parts.push(p); };
    flatten(await browser.compose.composeOptions({
      subject: `[KeywordCal] ${safeTitle}`,
      body: bodyText,
      isPlainText: true,
      attachments: [
        { name: filename, contentType: "text/calendar", encoding: "base64", content: this._b64(icsText) },
      ],
    }));

    const structured = {
      contentType: "multipart/mixed",
      parts: [
        {
          contentType: "text/plain",
          encoding: "7bit",
          content: bodyText,
        },
        ...parts.filter((p) => p.contentType === "text/calendar"),
      ],
    };

    await browser.composeAction.openComposeWindow(null, null, "new", {
      subject: `[KeywordCal] ${safeTitle}`,
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
   * Create a calendar event. Tries the Calendar Bridge first; falls back
   * to the compose (.ics) path. Never throws to the caller.
   */
  async createEvent(msg, action) {
    const title =
      TemplateResolver.resolve(action.titleTemplate, msg) || msg.subject || "KeywordCal event";
    const description = TemplateResolver.resolve(action.descriptionTemplate, msg);

    const startDate = this._resolveStartDate(msg, action);
    const durationMinutes = action.durationMinutes ?? 60;
    const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
    const alarms = action.reminderMinutes || [];
    const uid = `keywordcal-${msg.id}-${Date.now()}@keywordcal.local`;

    const bridgeId = await this.findBridge();
    if (bridgeId) {
      try {
        const created = await browser.runtime.sendMessage(bridgeId, {
          method: "createItem",
          item: {
            kind: "event",
            calendarId: action.calendarId || "default",
            uid,
            title,
            description,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            alarms,
            category: action.category || null,
          },
        });
        if (created && created.ok) {
          console.log(`[KeywordCal] Event created via bridge: "${title}" (${created.id})`);
          this._notify(`Event created: "${title}"`);
          return created;
        }
        throw new Error(created && created.error ? created.error : "bridge returned no result");
      } catch (err) {
        console.warn("[KeywordCal] Bridge createItem failed, falling back to compose:", err);
        this.forgetBridge();
      }
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
      dueDate = DateParser.extract(msg.body, action.datePattern);
    } else if (action.dateSource === "received") {
      dueDate = msg.date;
    }

    const alarms = action.reminderMinutes || [];
    const uid = `keywordcal-${msg.id}-${Date.now()}@keywordcal.local`;

    const bridgeId = await this.findBridge();
    if (bridgeId) {
      try {
        const created = await browser.runtime.sendMessage(bridgeId, {
          method: "createItem",
          item: {
            kind: "task",
            calendarId: action.calendarId || "default",
            uid,
            title,
            description,
            dueDate: dueDate ? dueDate.toISOString() : null,
            alarms,
            category: action.category || null,
          },
        });
        if (created && created.ok) {
          console.log(`[KeywordCal] Task created via bridge: "${title}" (${created.id})`);
          this._notify(`Task created: "${title}"`);
          return created;
        }
        throw new Error(created && created.error ? created.error : "bridge returned no result");
      } catch (err) {
        console.warn("[KeywordCal] Bridge createItem failed, falling back to compose:", err);
        this.forgetBridge();
      }
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
      browser.notifications.create({
        type: "basic",
        title: "KeywordCal",
        message,
        iconUrl: "icons/icon-32.png",
      });
    } catch (e) {
      /* notifications are best-effort */
    }
  },
};
