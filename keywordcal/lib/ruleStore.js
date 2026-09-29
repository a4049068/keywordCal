/**
 * RuleStore - CRUD for rules via browser.storage.local.
 */
"use strict";

const RuleStore = {
  STORAGE_KEY: "keywordcal_rules",

  async getAllRules() {
    const data = await browser.storage.local.get(this.STORAGE_KEY);
    return data[this.STORAGE_KEY] || [];
  },

  async getActiveRules() {
    const all = await this.getAllRules();
    return all.filter((r) => r.enabled);
  },

  async addRule(rule) {
    const rules = await this.getAllRules();
    rule.id = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    rule.createdAt = new Date().toISOString();
    rule.lastTriggered = null;
    rules.push(rule);
    await browser.storage.local.set({ [this.STORAGE_KEY]: rules });
    return rule;
  },

  async updateRule(updatedRule) {
    const rules = await this.getAllRules();
    const idx = rules.findIndex((r) => r.id === updatedRule.id);
    if (idx !== -1) {
      rules[idx] = { ...rules[idx], ...updatedRule };
      await browser.storage.local.set({ [this.STORAGE_KEY]: rules });
    }
  },

  async deleteRule(ruleId) {
    const rules = (await this.getAllRules()).filter((r) => r.id !== ruleId);
    await browser.storage.local.set({ [this.STORAGE_KEY]: rules });
  },

  /**
   * Seed the default example rules (see design doc §8).
   * By default this is a no-op if any rules already exist (first-install seeding).
   * Pass `force = true` to append the defaults regardless (used by "Restore
   * Example Rules" in the Options UI); already-present rule names are skipped.
   */
  async seedDefaults(force = false) {
    const existing = await this.getAllRules();
    if (existing.length > 0 && !force) return;
    const existingNames = new Set(existing.map((r) => r.name));

    const defaults = [
      {
        name: "ICS Auto-Accept",
        enabled: true,
        matchType: "all",
        conditions: [
          { field: "body", operator: "matches", value: "BEGIN:VCALENDAR" },
        ],
        actions: [
          {
            type: "createEvent",
            titleTemplate: "{subject}",
            descriptionTemplate: "Imported from email by {sender}",
            dateSource: "extract",
            durationMinutes: 60,
            reminderMinutes: [15],
            calendarId: "default",
          },
        ],
        stopProcessing: false,
      },
      {
        name: "Deadline Detector",
        enabled: true,
        matchType: "all",
        conditions: [
          { field: "body", operator: "contains", value: "deadline" },
          { field: "body", operator: "matches", value: "\\d{1,2}/\\d{1,2}" },
        ],
        actions: [
          {
            type: "createTask",
            titleTemplate: "Deadline: {subject}",
            descriptionTemplate: "From: {sender}\n\n{body_excerpt}",
            dateSource: "extract",
            datePattern: "(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})",
            reminderMinutes: [1440],
            calendarId: "default",
          },
        ],
        stopProcessing: false,
      },
      {
        name: "Meeting Keyword",
        enabled: true,
        matchType: "any",
        conditions: [
          { field: "subject", operator: "contains", value: "meeting" },
          { field: "subject", operator: "contains", value: "standup" },
        ],
        actions: [
          {
            type: "createEvent",
            titleTemplate: "{subject}",
            descriptionTemplate: "From: {sender}",
            dateSource: "extract",
            durationMinutes: 30,
            reminderMinutes: [15],
            calendarId: "default",
            category: "Work",
          },
        ],
        stopProcessing: false,
      },
      {
        name: "Reminder Flag",
        enabled: true,
        matchType: "all",
        conditions: [
          { field: "subject", operator: "contains", value: "[REMIND]" },
        ],
        actions: [
          {
            type: "createReminder",
            titleTemplate: "{subject}",
            descriptionTemplate: "{body_excerpt}",
            dateSource: "extract",
            reminderMinutes: [0],
            calendarId: "default",
          },
        ],
        stopProcessing: false,
      },
    ];

    for (const rule of defaults) {
      if (existingNames.has(rule.name)) continue;
      await this.addRule(structuredClone(rule));
    }
  },
};
