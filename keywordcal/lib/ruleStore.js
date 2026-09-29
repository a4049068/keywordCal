"use strict";

const RuleStore = {
  STORAGE_KEY: "keywordcal_rules",

  async getAllRules() {
    const data = await browser.storage.local.get(this.STORAGE_KEY);
    const rules = data?.[this.STORAGE_KEY];
    return Array.isArray(rules) ? rules : [];
  },

  async getActiveRules() {
    return (await this.getAllRules()).filter((r) => r.enabled);
  },

  async addRule(rule) {
    const rules = await this.getAllRules();
    const newRule = {
      ...rule,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      lastTriggered: null,
      enabled: rule.enabled ?? true,
    };
    rules.push(newRule);
    await this._write(rules);
    return newRule;
  },

  async addRules(rules) {
    const current = await this.getAllRules();
    const newRules = rules.map((r) => ({
      ...r,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      lastTriggered: null,
      enabled: r.enabled ?? true,
    }));
    await this._write([...current, ...newRules]);
    return newRules;
  },

  async updateRule(updatedRule) {
    const rules = await this.getAllRules();
    const idx = rules.findIndex((r) => r.id === updatedRule.id);
    if (idx === -1) return;
    rules[idx] = { ...rules[idx], ...updatedRule };
    await this._write(rules);
  },

  async toggleRule(ruleId) {
    const rules = await this.getAllRules();
    const rule = rules.find((r) => r.id === ruleId);
    if (!rule) return false;
    rule.enabled = !rule.enabled;
    await this._write(rules);
    return rule.enabled;
  },

  async deleteRule(ruleId) {
    await this._write((await this.getAllRules()).filter((r) => r.id !== ruleId));
  },

  async deleteRules(ruleIds) {
    const ids = new Set(ruleIds);
    await this._write((await this.getAllRules()).filter((r) => !ids.has(r.id)));
  },

  async moveRule(ruleId, newIndex) {
    const rules = await this.getAllRules();
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx === -1 || idx === newIndex) return;
    const [rule] = rules.splice(idx, 1);
    rules.splice(Math.max(0, Math.min(newIndex, rules.length)), 0, rule);
    await this._write(rules);
  },

  async clearAll() {
    await this._write([]);
  },

  async importRules(rules, merge = false) {
    if (!Array.isArray(rules)) return 0;
    const current = merge ? await this.getAllRules() : [];
    const existingIds = new Set(current.map((r) => r.id));

    const sanitized = rules.filter((r) => r?.name).map((r) => ({
      ...r,
      id: r.id || crypto.randomUUID(),
      createdAt: r.createdAt || new Date().toISOString(),
      lastTriggered: r.lastTriggered ?? null,
      enabled: r.enabled ?? true,
    }));

    const toAdd = sanitized.filter((r) => !existingIds.has(r.id));
    await this._write([...current, ...toAdd]);
    return toAdd.length;
  },

  async _write(rules) {
    try {
      await browser.storage.local.set({ [this.STORAGE_KEY]: rules });
      if (typeof refreshBadge === "function") refreshBadge().catch(() => {});
    } catch (e) {
      if (e.message?.includes("QUOTA_BYTES")) console.error("Storage quota exceeded");
      else throw e;
    }
  },

  async seedDefaults(force = false) {
    const existing = await this.getAllRules();
    if (existing.length > 0 && !force) return;

    const existingNames = new Set(existing.map((r) => r.name));
    const defaults = [
      {
        name: "ICS Auto-Accept",
        enabled: true,
        matchType: "all",
        conditions: [{ field: "body", operator: "matches", value: "BEGIN:VCALENDAR" }],
        actions: [{ type: "createEvent", titleTemplate: "{subject}", descriptionTemplate: "Imported from email by {sender}", dateSource: "extract", durationMinutes: 60, reminderMinutes: [15], calendarId: "default" }],
        stopProcessing: false,
      },
      {
        name: "Deadline Detector",
        enabled: true,
        matchType: "all",
        conditions: [{ field: "body", operator: "contains", value: "deadline" }, { field: "body", operator: "matches", value: "\\d{1,2}/\\d{1,2}" }],
        actions: [{ type: "createTask", titleTemplate: "Deadline: {subject}", descriptionTemplate: "From: {sender}\n\n{body_excerpt}", dateSource: "extract", datePattern: "(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})", reminderMinutes: [1440], calendarId: "default" }],
        stopProcessing: false,
      },
      {
        name: "Meeting Keyword",
        enabled: true,
        matchType: "any",
        conditions: [{ field: "subject", operator: "contains", value: "meeting" }, { field: "subject", operator: "contains", value: "standup" }],
        actions: [{ type: "createEvent", titleTemplate: "{subject}", descriptionTemplate: "From: {sender}", dateSource: "extract", durationMinutes: 30, reminderMinutes: [15], calendarId: "default", category: "Work" }],
        stopProcessing: false,
      },
      {
        name: "Reminder Flag",
        enabled: true,
        matchType: "all",
        conditions: [{ field: "subject", operator: "contains", value: "[REMIND]" }],
        actions: [{ type: "createReminder", titleTemplate: "{subject}", descriptionTemplate: "{body_excerpt}", dateSource: "extract", reminderMinutes: [0], calendarId: "default" }],
        stopProcessing: false,
      },
    ];

    for (const rule of defaults) {
      if (!existingNames.has(rule.name)) await this.addRule(structuredClone(rule));
    }
  },
};
