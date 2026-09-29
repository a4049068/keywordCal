/**
 * CalendarWriter - Creates events and tasks via Thunderbird Calendar API.
 */
"use strict";

const CalendarWriter = {
  async _getTargetCalendar(calendarId) {
    const calendars = await browser.calendar.calendars.get();
    if (calendarId === "default") {
      return calendars[0]; // First calendar as fallback
    }
    return calendars.find((c) => c.id === calendarId) || calendars[0];
  },

  async createEvent(msg, action) {
    const calendar = await this._getTargetCalendar(action.calendarId);
    const title = TemplateResolver.resolve(action.titleTemplate, msg);
    const description = TemplateResolver.resolve(action.descriptionTemplate, msg);

    // Determine start date
    let startDate;
    if (action.dateSource === "extract") {
      startDate = DateParser.extract(msg.body, action.datePattern) || msg.date;
    } else if (action.dateSource === "received") {
      startDate = msg.date;
    } else {
      startDate = new Date();
    }

    const endDate = new Date(startDate.getTime() + (action.durationMinutes || 60) * 60000);

    // Build alarms (reminders)
    const alarms = (action.reminderMinutes || []).map((mins) => ({
      action: "display",
      trigger: { related: "start", offset: `PT${mins}M` },
    }));

    const eventProperties = {
      calendarId: calendar.id,
      title,
      description,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      alarms,
    };

    if (action.category) {
      eventProperties.categories = [action.category];
    }

    try {
      const created = await browser.calendar.items.create(calendar.id, eventProperties);
      console.log(`[KeywordCal] Event created: "${title}" (ID: ${created.id})`);

      browser.notifications.create({
        type: "basic",
        title: "KeywordCal",
        message: `Event created: "${title}"`,
        iconUrl: "icons/icon-32.png",
      });
    } catch (err) {
      console.error(`[KeywordCal] Failed to create event:`, err);
    }
  },

  async createTask(msg, action) {
    // Similar to createEvent but with isEvent: false
    const calendar = await this._getTargetCalendar(action.calendarId);
    const title = TemplateResolver.resolve(action.titleTemplate, msg);

    const dueDate = action.dateSource === "extract"
      ? DateParser.extract(msg.body, action.datePattern)
      : msg.date;

    try {
      await browser.calendar.items.create(calendar.id, {
        calendarId: calendar.id,
        title,
        isEvent: false,
        dueDate: dueDate ? dueDate.toISOString() : null,
      });
      console.log(`[KeywordCal] Task created: "${title}"`);
    } catch (err) {
      console.error(`[KeywordCal] Failed to create task:`, err);
    }
  },

  async createReminder(msg, action) {
    // Creates a zero-duration event (reminder-only)
    action.durationMinutes = 0;
    return this.createEvent(msg, action);
  },
};
