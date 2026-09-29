/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global ExtensionAPI, Services, Cc, Ci, cal */
/**
 * KeywordCal Calendar Bridge - privileged experiment API (parent process).
 *
 *   - listCalendars() -> [{ id, name, type, color, canWrite }]
 *   - createItem({ calendarId, kind, ... }) -> { ok, id } | { ok:false, error }
 *
 * Globals (ExtensionAPI, Services, Cc, Ci) come from the api "scopes"
 * declared in manifest.json; the `cal` module namespace comes from the
 * scopedAddonLoader for the "caldavjs" loader — exactly how Thunderbird's
 * own built-in calendar experiments get access. No ChromeUtils/Cu/
 * Components usage anywhere (those are unavailable/deprecated in this
 * sandbox and caused the shipped load errors).
 */

function getRegistry() {
  return Cc["@mozilla.org/calendar/registry;1"].getService(Ci.calIRegistry);
}

/**
 * Resolve a calendar by id, exact name, or case-insensitive substring.
 * "default"/empty resolves to the default event/task calendar, falling
 * back to the first writable local calendar. Returns { cal } or { error }.
 */
function resolveCalendar(wanted, kind) {
  const calendars = getRegistry().getCalendars();
  if (!calendars.length) {
    return { error: "no calendars are configured in Thunderbird" };
  }

  if (!wanted || wanted === "default") {
    let def = null;
    try {
      // Services.clm is the calICalendarManager in TB 115+ (no XPCOM lookup).
      def =
        kind === "task"
          ? Services.clm.getDefaultTaskCalendar?.()
          : Services.clm.getDefaultCalendar?.();
    } catch (e) {
      /* older/newer manager shape - fall through to heuristics */
    }
    const found =
      (def && calendars.find((c) => c.id === def.id)) ||
      calendars.find((c) => c.type === "local" && c.canModifyItems !== false) ||
      calendars.find((c) => c.canModifyItems !== false) ||
      calendars[0];
    return { cal: found };
  }

  const found =
    calendars.find((c) => c.id === wanted) ||
    calendars.find((c) => (c.name || "") === wanted) ||
    calendars.find((c) => (c.name || "").toLowerCase().includes(wanted.toLowerCase()));
  if (!found) {
    return {
      error: `calendar "${wanted}" not found`,
      available: calendars.map((c) => ({ id: c.id, name: c.name })),
    };
  }
  return { cal: found };
}

class BridgeParent extends ExtensionAPI {
  getAPI(context) {
    return {
      BridgeParent: {
        async listCalendars() {
          return getRegistry().getCalendars().map((c) => ({
            id: c.id,
            name: c.name || "(unnamed)",
            type: c.type || "",
            color: (typeof c.getProperty === "function" ? c.getProperty("color") : "") || "",
            canWrite: c.canModifyItems !== false,
          }));
        },

        async createItem(details) {
          try {
            const isTask = details.kind === "task";
            const { cal: target, error } = resolveCalendar(
              details.calendarId,
              isTask ? "task" : "event"
            );
            if (error) return { ok: false, error };

            const item = isTask ? cal.createTask() : cal.createEvent();
            item.calendar = target.superCalendar;

            item.title = details.title || "KeywordCal item";
            if (details.description) item.description = details.description;
            if (details.category) item.categories = [details.category];
            if (details.uid) item.setProperty("UID", details.uid);

            const tzService = Cc["@mozilla.org/calendar/timezone-service;1"]
              .getService(Ci.calITimezoneService);
            const localTz =
              tzService.getTimezone(target.defaultTimezone?.name || "floating") ||
              tzService.getTimezone("floating");

            const makeDt = (iso) => {
              const d = new Date(iso);
              if (isNaN(d.getTime())) {
                throw new Error(`invalid date value: ${iso}`);
              }
              return cal.DateTime.fromJavaScriptDate(d, localTz);
            };

            if (isTask) {
              if (details.dueDate) item.dueDate = makeDt(details.dueDate);
              item.isCompleted = false;
            } else {
              item.startTime = makeDt(details.startDate);
              item.endTime = makeDt(details.endDate);
            }

            for (const mins of details.alarms || []) {
              const alarm = item.makeAlarm(
                Ci.calIAlarm.ACTION_DISPLAY,
                `-${Math.abs(mins)} minutes`
              );
              item.addAlarm(alarm);
            }

            await item.addItem({});
            return {
              ok: true,
              id: item.hashId || item.id || "(assigned)",
              calendarName: target.name,
            };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        },
      },
    };
  }
}
