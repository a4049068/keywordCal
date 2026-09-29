/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * KeywordCal Calendar Bridge - privileged experiment API (parent process).
 *
 *   - listCalendars() -> [{ id, name, type, color, canWrite }]
 *   - createItem({ calendarId, kind, ... }) -> { ok, id } | { ok:false, error }
 *
 * All calendar work happens locally via Thunderbird's calendar manager; no
 * network I/O is performed here. The base ExtensionAPI class is provided by
 * the mixin declared in manifest.json ("addon_parent:parentAPI.ExtensionAPI"),
 * so this sandboxed script needs no ChromeUtils/Cu/Components imports at all.
 */

// Experiment API scripts run in a restricted sandbox without ChromeUtils/Cu.
// The documented pattern (used by Thunderbird's own built-in experiments) is
// to destructure Cc/Ci from the global Components object; ExtensionAPI itself
// comes from the mixin declared in manifest.json options.
const { classes: Cc, interfaces: Ci } = Components;

let _cal = null; // lazy calICSocalICal ES-module namespace

async function getCal() {
  if (!_cal) {
    const mod = await import("resource:///modules/calendar/utils/calICSocalICal.sys.mjs");
    _cal = mod.cal;
  }
  return _cal;
}

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
      const mgr = Cc["@mozilla.org/calendar/manager;1"].getService(
        Ci.calICalendarManager
      );
      def =
        kind === "task"
          ? mgr.getDefaultTaskCalendar?.()
          : mgr.getDefaultCalendar?.();
    } catch (e) {
      /* older/newer manager shape - fall through to heuristics */
    }
    const cal =
      (def && calendars.find((c) => c.id === def.id)) ||
      calendars.find((c) => c.type === "local" && c.canModifyItems !== false) ||
      calendars.find((c) => c.canModifyItems !== false) ||
      calendars[0];
    return { cal };
  }

  const cal =
    calendars.find((c) => c.id === wanted) ||
    calendars.find((c) => (c.name || "") === wanted) ||
    calendars.find((c) => (c.name || "").toLowerCase().includes(wanted.toLowerCase()));
  if (!cal) {
    return {
      error: `calendar "${wanted}" not found`,
      available: calendars.map((c) => ({ id: c.id, name: c.name })),
    };
  }
  return { cal };
}

class BridgeParent extends ExtensionAPI {
  getAPI(context) {
    return {
      BridgeParent: {
        async listCalendars() {
          return getRegistry().getCalendars().map((cal) => ({
            id: cal.id,
            name: cal.name || "(unnamed)",
            type: cal.type || "",
            color: cal.getProperty("color") || "",
            canWrite: cal.canModifyItems !== false,
          }));
        },

        async createItem(details) {
          try {
            const isTask = details.kind === "task";
            const { cal, error } = resolveCalendar(
              details.calendarId,
              isTask ? "task" : "event"
            );
            if (error) return { ok: false, error };

            const calNamespace = await getCal();
            const item = isTask ? calNamespace.createTask() : calNamespace.createEvent();
            item.calendar = cal.superCalendar;

            item.title = details.title || "KeywordCal item";
            if (details.description) item.description = details.description;
            if (details.category) item.categories = [details.category];
            if (details.uid) item.setProperty("UID", details.uid);

            const tzService = Cc["@mozilla.org/calendar/timezone-service;1"]
              .getService(Ci.calITimezoneService);
            const localTz =
              tzService.getTimezone(cal.defaultTimezone?.name || "floating") ||
              tzService.getTimezone("floating");

            const makeDt = (iso) => {
              const d = new Date(iso);
              const dt = calNamespace.DateTime.fromJavaScriptDate(d, localTz);
              return dt;
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
              calendarName: cal.name,
            };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        },
      },
    };
  }
}
