/**
 * RuleStore - CRUD for rules via browser.storage.local.
 */
"use strict";

const RuleStore = {
  STORAGE_KEY: "keywordcal_rules",

  async getAllRules() {
    // storage.local.get(key) returns an object keyed by the requested key;
    // get() with no argument returns the whole store. Accept both shapes so a
    // missing/renamed key can never throw "cannot read property of undefined".
    const data = (await browser.storage.local.get(this.STORAGE_KEY)) || {};
    return Array.isArray(data) ? data : data[this.STORAGE_KEY] || [];
  },

  async getActiveRules() {
    const all = await this.getAllRules();
    return all.filter((r) => r.enabled);
  },

  async addRule(rule) {
    const rules = await this.getAllRules();
    Object.assign(rule, {
      id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      lastTriggered: null,
    });
    rules.push(rule);
    await this._write(rules);
    return rule;
  },

  async updateRule(updatedRule) {
    const rules = await this.getAllRules();
    const idx = rules.findIndex((r) => r.id === updatedRule.id);
    if (idx !== -1) {
      rules[idx] = { ...rules[idx], ...updatedRule };
      await this._write(rules);
    }
  },

  async deleteRule(ruleId) {
    const rules = (await this.getAllRules()).filter((r) => r.id !== ruleId);
    await this._write(rules);
  },

  /**
   * Persist + keep the toolbar badge in sync. refreshBadge() lives in
   * background.js and is loaded before this file, so it is a global here.
   */
  async _write(rules) {
    await browser.storage.local.set({ [this.STORAGE_KEY]: rules });
    try {
      if (typeof refreshBadge === "function") await refreshBadge();
    } catch (e) {
      /* badge is best-effort */
    }
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
