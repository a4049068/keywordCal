/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * KeywordCal Calendar Bridge - privileged experiment API (parent process).
 *
 * MailExtensions cannot touch the calendar subsystem, so this tiny companion
 * add-on exposes it through an "experiment" API:
 *
 *   - listCalendars() -> [{ id, name, color, canWrite }]
 *   - createItem({ calendarId, kind, ... }) -> { ok, id } | { ok:false, error }
 *
 * Everything happens locally in Thunderbird via calICSocalICal; no network
 * I/O is performed here. A remote (e.g. Google CalDAV) calendar only gets a
 * normal item-add request, which is the same operation a user performing
 * "New Event" would trigger.
 */

// Experiment API scripts run in a restricted sandbox where ChromeUtils and Cu
// are NOT defined. The supported pattern (used by Thunderbird's own built-in
// experiments) is to grab the Components globals via the global "Components"
// object — no ChromeUtils at all.
const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

// ExtensionParent.sys.mjs is an ES module, so it cannot be loaded with
// Cu.import or jssubscript-loader from this sandbox. Instead we obtain the
// ExtensionAPI base class lazily through the addon manager's principal: the
// experiment loader evaluates this script against a scope whose global has
// `Components` available, and we can reach the ES-module loader indirectly
// via Services from the JSM shim.
let _ExtensionAPI = null;
function getBaseExtensionAPI() {
  if (_ExtensionAPI) return _ExtensionAPI;
  // resource://gre/modules/Services.jsm is still a JSM and importable.
  const { Services } = Cu.import("resource://gre/modules/Services.jsm", {});
  try {
    // Use the mozIJSSubScriptLoader on the .sys.mjs file: these files begin
    // with export statements which loadSubScript tolerates when evaluated
    // into a plain object scope in TB 128 (the exports land on the scope).
    const loader = Cc["@mozilla.org/moz/jssubscript-loader;1"]
      .getService(Ci.mozIJSSubScriptLoader);
    const scope = {};
    loader.loadSubScript("resource://gre/modules/ExtensionParent.sys.mjs", scope, "utf8");
    _ExtensionAPI = scope.ExtensionAPI || null;
  } catch (e) {
    _ExtensionAPI = null;
  }
  if (!_ExtensionAPI) {
    throw new Error("KeywordCal Bridge: could not load ExtensionAPI (ExtensionParent.sys.mjs)");
  }
  return _ExtensionAPI;
}

function getRegistry() {
  return Cc["@mozilla.org/calendar/registry;1"].getService(Ci.calIRegistry);
}

/**
 * Resolve a calendar by id, exact name, or case-insensitive substring.
 * "default"/empty resolves to the default event/task calendar, falling
 * back to the first writable local calendar. Returns
 * { cal } or { error }.
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
      /* older/newer manager shape — fall through to heuristics */
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

class BridgeParent extends getBaseExtensionAPI() {
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

            const item = isTask ? cal.createTask() : cal.createEvent();
            item.calendar = cal.superCalendar;

            item.title = details.title || "KeywordCal item";
            if (details.description) item.description = details.description;
            if (details.category) item.categories = [details.category];
            if (details.uid) item.setProperty("UID", details.uid);

            const tz = cal.defaultTimezone || undefined;
            const makeDt = (iso) => {
              const dt = Cc["@mozilla.org/calendar/datetime;1"].createInstance(
                Ci.calIDateTime
              );
              dt.timezone = tz;
              dt.dateValue = new Date(iso);
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
