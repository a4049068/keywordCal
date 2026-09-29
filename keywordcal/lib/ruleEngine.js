/**
 * RuleEngine - Evaluates messages against rules and triggers actions.
 */
"use strict";

const RuleEngine = {
  async evaluate(messageContext, rules) {
    for (const rule of rules) {
      const matched = this._matchConditions(messageContext, rule);

      if (matched) {
        console.log(`[KeywordCal] Rule "${rule.name}" matched message "${messageContext.subject}"`);

        for (const action of rule.actions) {
          await this._executeAction(messageContext, action);
        }

        // Update last triggered timestamp
        rule.lastTriggered = new Date().toISOString();
        await RuleStore.updateRule(rule);

        if (rule.stopProcessing) break;
      }
    }
  },

  _matchConditions(msg, rule) {
    const results = rule.conditions.map((cond) =>
      this._evaluateCondition(msg, cond)
    );

    return rule.matchType === "all"
      ? results.every(Boolean)
      : results.some(Boolean);
  },

  _evaluateCondition(msg, cond) {
    const fieldValue = this._getFieldValue(msg, cond);
    if (!fieldValue) return cond.operator === "notContains";

    const normalized = fieldValue.toLowerCase();
    const target = cond.value.toLowerCase();

    switch (cond.operator) {
      case "contains":
        return normalized.includes(target);
      case "notContains":
        return !normalized.includes(target);
      case "is":
        return normalized === target;
      case "matches":
        try {
          return new RegExp(cond.value, "i").test(fieldValue);
        } catch {
          console.warn(`[KeywordCal] Invalid regex: ${cond.value}`);
          return false;
        }
      default:
        return false;
    }
  },

  _getFieldValue(msg, cond) {
    switch (cond.field) {
      case "subject":   return msg.subject;
      case "body":      return msg.body;
      case "sender":    return msg.sender;
      case "recipient": return msg.recipients;
      case "header": {
        // value format: "Header-Name::pattern" — look up raw header value
        const sep = cond.value.indexOf("::");
        if (sep === -1) return "";
        const name = cond.value.slice(0, sep).toLowerCase();
        const headers = msg.headers || {};
        return typeof headers[name] === "string" ? headers[name] : "";
      }
      default:          return "";
    }
  },

  async _executeAction(msg, action) {
    switch (action.type) {
      case "createEvent":
        await CalendarWriter.createEvent(msg, action);
        break;
      case "createTask":
        await CalendarWriter.createTask(msg, action);
        break;
      case "createReminder":
        await CalendarWriter.createReminder(msg, action);
        break;
      default:
        console.warn(`[KeywordCal] Unknown action type: ${action.type}`);
    }
  },
};
