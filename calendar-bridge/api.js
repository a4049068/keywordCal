/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * KeywordCal Calendar Bridge — privileged experiment API (parent process).
 *
 * Provides three functions to this add-on's own background script:
 *   listCalendars() -> [{ id, name, type, color, canWrite }]
 *   createItem({ calendarId, kind, ... }) -> { ok, id, calendarName }
 *                                          | { ok:false, error }
 *   deleteItem({ calendarId, itemId })    -> { ok } | { ok:false, error }
 * (deleteItem powers KeywordCal's "Undo last action" feature.)
 *
 * Everything here uses plain XPCOM contracts only — no ES-module imports,
 * no ChromeUtils/Cu (those are unavailable inside the WebExtension sandbox
 * and caused the earlier load errors). Cc/Ci come from the "main" scope;
 * ExtensionAPI comes from the "addon_parent" scope (see manifest scopes).
 * Verbose logging at every step so failures are diagnosable in the Browser
 * Console.
 */

/* global ExtensionAPI, Cc, Ci */

const LOG_PREFIX = "[KeywordCal Bridge]";
function log(...args) {
  console.log(LOG_PREFIX, ...args);
}
function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}
function errlog(...args) {
  console.error(LOG_PREFIX, ...args);
}

// ---------- XPCOM helpers ----------

const SERVICES = {
  manager: ["@mozilla.org/calendar/manager;1", "calICalendarManager"],
  tzService: ["@mozilla.org/calendar/timezone-service;1", "calITimezoneService"],
};
function svc(name) {
  const [contract, iface] = SERVICES[name];
  return Cc[contract].getService(Ci[iface]);
}

/**
 * Build a calIDateTime from an ISO string in the given timezone (local
 * wall-clock semantics — matches how a user typing "tomorrow 9am" means it).
 * Throws on unusable input so callers surface a clean error.
 */
function makeDateTime(iso, tz) {
  const dateValue = new Date(iso);
  if (isNaN(dateValue.getTime())) {
    throw new Error(`invalid date value: ${iso}`);
  }
  const dt = Cc["@mozilla.org/calendar/datetime;1"].createInstance(Ci.calIDateTime);
  dt.timezone = tz || svc("tzService").getTimezone("floating");
  dt.year = dateValue.getFullYear();
  dt.month = dateValue.getMonth();
  dt.day = dateValue.getDate();
  dt.hour = dateValue.getHours();
  dt.minute = dateValue.getMinutes();
  dt.second = dateValue.getSeconds();
  return dt;
}

/**
 * Resolve a calendar by id, exact name, or case-insensitive substring.
 * ""/"default" resolves to the default event/task calendar, falling back
 * to the first writable local calendar. Returns { cal } or { error }.
 */
function resolveCalendar(wanted, kind) {
  const calendars = svc("manager").getCalendars();
  log(
    `resolveCalendar("${wanted}", ${kind}): ${calendars.length} calendar(s):`,
    calendars.map((c) => `${c.name}[${c.id}]`).join(", ")
  );
  if (!calendars.length) {
    return { error: "no calendars are configured in Thunderbird" };
  }

  if (!wanted || wanted === "default") {
    let def = null;
    try {
      const mgr = svc("manager");
      def = kind === "task" ? mgr.getDefaultTaskCalendar?.() : mgr.getDefaultCalendar?.();
    } catch (e) {
      warn("could not query default calendar:", e);
    }
    const found =
      (def && calendars.find((c) => c.id === def.id)) ||
      calendars.find((c) => c.type === "local" && !c.readOnly) ||
      calendars.find((c) => !c.readOnly) ||
      calendars[0];
    log(`resolved default -> "${found.name}" (${found.id})`);
    return { cal: found };
  }

  const found =
    calendars.find((c) => c.id === wanted) ||
    calendars.find((c) => (c.name || "") === wanted) ||
    calendars.find((c) => (c.name || "").toLowerCase().includes(wanted.toLowerCase()));
  if (!found) {
    const names = calendars.map((c) => `"${c.name}" (${c.id})`).join(", ");
    return {
      error: `calendar "${wanted}" not found. Available: ${names}`,
      available: calendars.map((c) => ({ id: c.id, name: c.name })),
    };
  }
  log(`resolved "${wanted}" -> ${found.id}`);
  return { cal: found };
}

// ---------- Experiment API implementation ----------

class BridgeParent extends ExtensionAPI {
  getAPI(context) {
    log("BridgeParent API instantiated");

    return {
      BridgeParent: {
        async listCalendars() {
          const out = svc("manager")
            .getCalendars()
            .map((c) => ({
              id: c.id,
              name: c.name || "(unnamed)",
              type: c.type || "",
              color:
                (typeof c.getProperty === "function" ? c.getProperty("color") : "") || "",
              canWrite: !c.readOnly,
            }));
          log(`listCalendars -> ${out.length}:`, out.map((c) => c.name).join(", "));
          return out;
        },

        async createItem(details) {
          log("createItem called:", JSON.stringify(details));
          try {
            const isTask = details.kind === "task";
            const { cal: target, error } = resolveCalendar(
              details.calendarId,
              isTask ? "task" : "event"
            );
            if (error) {
              warn("createItem refused:", error);
              return { ok: false, error };
            }
            if (target.readOnly) {
              return { ok: false, error: `calendar "${target.name}" is read-only` };
            }

            if (details.uid) {
              try {
                const items = await target.getItemsAsArray(
                  Ci.calICalendar.ITEM_FILTER_ALL_ITEMS, 0, null, null
                );
                const existing = Array.from(items).find(
                  (candidate) => (candidate.getProperty("UID") || "") === details.uid ||
                    candidate.id === details.uid
                );
                if (existing) {
                  return {
                    ok: true,
                    id: String(existing.hashId || existing.id || ""),
                    calendarName: target.name,
                    existing: true,
                  };
                }
              } catch (lookupError) {
                warn("could not check for an existing UID; continuing with create:", lookupError);
              }
            }

            // Plain XPCOM item creation:
            //   events -> @mozilla.org/calendar/event;1 (calIEvent)
            //   tasks  -> @mozilla.org/calendar/todo;1  (calITodo)
            const item = isTask
              ? Cc["@mozilla.org/calendar/todo;1"].createInstance(Ci.calITodo)
              : Cc["@mozilla.org/calendar/event;1"].createInstance(Ci.calIEvent);

            item.calendar = target.superCalendar;
            item.title = details.title || "KeywordCal item";
            if (details.description) item.description = details.description;
            if (details.category) item.categories = [details.category];
            if (details.uid) item.setProperty("UID", details.uid);

            let tz = null;
            try {
              const tzName = target.defaultTimezone?.name || "floating";
              tz = svc("tzService").getTimezone(tzName);
            } catch (e) {
              warn("timezone lookup failed, using floating:", e);
            }

            if (isTask) {
              if (details.dueDate) item.dueDate = makeDateTime(details.dueDate, tz);
              item.isCompleted = false;
            } else {
              item.startDate = makeDateTime(details.startDate, tz);
              item.endDate = makeDateTime(details.endDate, tz);
            }

            for (const mins of details.alarms || []) {
              const alarm = Cc["@mozilla.org/calendar/alarm;1"].createInstance(Ci.calIAlarm);
              const offset = Cc["@mozilla.org/calendar/duration;1"].createInstance(Ci.calIDuration);
              offset.inSeconds = -Math.abs(Number(mins)) * 60;
              alarm.action = "DISPLAY";
              alarm.related = isTask ? Ci.calIAlarm.ALARM_RELATED_END : Ci.calIAlarm.ALARM_RELATED_START;
              alarm.offset = offset;
              alarm.description = item.title;
              item.addAlarm(alarm);
            }

            const savedItem = await target.addItem(item);
            const result = {
              ok: true,
              id: String(savedItem.hashId || savedItem.id || ""),
              calendarName: target.name,
            };
            log("createItem succeeded:", JSON.stringify(result));
            return result;
          } catch (err) {
            errlog("createItem failed:", err);
            return { ok: false, error: String(err) };
          }
        },

        async findConflicts(details) {
          log("findConflicts called:", JSON.stringify(details));
          try {
            const { cal: target, error } = resolveCalendar(details.calendarId, "event");
            if (error) return []; // conflict check is best-effort — never throws upward
            const start = new Date(details.start);
            const end = new Date(details.end);
            if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];
            const items = await target.getItemsAsArray(Ci.calICalendar.ITEM_FILTER_ALL_ITEMS, 0, null, null);
            const out = Array.from(items)
              .filter((i) => i.startDate && i.endDate)
              .filter((i) => {
                // Compare as UTC so DST shifts can't skew the overlap test.
                const ms = (dt) => dt.nativeTime / 1000;
                return ms(i.startDate) < end.getTime() && ms(i.endDate) > start.getTime();
              })
              .map((i) => ({
                title: i.title || "(untitled)",
                startDate: i.startDate?.toString?.() || "",
                endDate: i.endDate?.toString?.() || "",
              }));
            log(`findConflicts -> ${out.length} overlapping event(s)`);
            return out;
          } catch (err) {
            warn("findConflicts failed (ignored):", err);
            return [];
          }
        },

        async deleteItem(details) {
          log("deleteItem called:", JSON.stringify(details));
          try {
            const wanted = String((details && details.itemId) || "");
            if (!wanted) return { ok: false, error: "no itemId given" };

            const { cal: target, error } = resolveCalendar(
              details.calendarId,
              details.kind === "task" ? "task" : "event"
            );
            if (error) {
              warn("deleteItem refused:", error);
              return { ok: false, error };
            }

            const items = await target.getItemsAsArray(Ci.calICalendar.ITEM_FILTER_ALL_ITEMS, 0, null, null);
            // Match by numeric hashId first (what createItem returned), then
            // fall back to UID / backend id so hand-edited items still match.
            const hit = Array.from(items).find(
              (i) =>
                String(i.hashId) === wanted ||
                (i.getProperty("UID") || "") === wanted ||
                (i.id || "") === wanted
            );
            if (!hit) {
              return { ok: false, error: `item "${wanted}" not found in "${target.name}"` };
            }
            await target.deleteItem(hit);
            log(`deleteItem removed "${hit.title}" from "${target.name}"`);
            return { ok: true, title: hit.title, calendarName: target.name };
          } catch (err) {
            errlog("deleteItem failed:", err);
            return { ok: false, error: String(err) };
          }
        },
      },
    };
  }
}
