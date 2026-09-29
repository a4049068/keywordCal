/**
 * RuleEngine - Evaluates messages against rules and triggers actions.
 */
"use strict";

const RuleEngine = {
  /**
   * Evaluate a message against rules. Returns an array of one result object
   * per MATCHED rule ({ ruleName, results }) — empty array when nothing
   * matched (used by the toolbar popup to show what happened).
   */
  async evaluate(messageContext, rules) {
    const allResults = [];

    for (const rule of rules) {
      if (!rule || !Array.isArray(rule.conditions) || !Array.isArray(rule.actions)) continue;
      const matchedConds = await this._matchedConditions(messageContext, rule);

      if (matchedConds) {
        console.log(`[KeywordCal] Rule "${rule.name}" matched message "${messageContext.subject}"`);

        // Expose the first matching condition's value so templates can use
        // {keyword} (design doc §3.1). Copy so we never mutate the caller's
        // rule objects.
        const ctx = Object.assign({}, messageContext, {
          keyword: matchedConds.length ? this._conditionOperand(matchedConds[0]) : "",
        });

        const results = [];
        for (const action of rule.actions) {
          results.push(await this._executeAction(ctx, action));
        }
        allResults.push({ ruleName: rule.name, results });

        // Update last triggered timestamp
        rule.lastTriggered = new Date().toISOString();
        await RuleStore.updateRule(rule);

        if (rule.stopProcessing) break;
      }
    }

    return allResults;
  },

  /**
   * Returns the list of conditions that passed when the rule matches
   * (per matchType), or null when it does not match.
   */
  async _matchedConditions(msg, rule) {
    const passed = [];
    for (const cond of rule.conditions) {
      if (await this._evaluateCondition(msg, cond)) passed.push(cond);
    }

    if (rule.matchType === "all") {
      return passed.length === rule.conditions.length && rule.conditions.length > 0
        ? passed
        : null;
    }
    // "any"
    return passed.length > 0 ? passed : null;
  },

  _conditionOperand(cond) {
    const value = String(cond.value || "");
    if (cond.field !== "header") return value;
    const separator = value.indexOf("::");
    return separator === -1 ? "" : value.slice(separator + 2);
  },

  async _evaluateCondition(msg, cond) {
    const fieldValue = this._getFieldValue(msg, cond);
    const targetValue = this._conditionOperand(cond);
    if (cond.field === "header" && !String(cond.value || "").includes("::")) {
      console.warn("[KeywordCal] Header condition must use Header-Name::pattern format.");
      return false;
    }
    // A missing/empty field simply fails every operator except notContains
    // ("does not contain X" is true for an absent field).
    if (!fieldValue) return cond.operator === "notContains";

    const normalized = fieldValue.toLowerCase();
    const target = targetValue.toLowerCase();

    switch (cond.operator) {
      case "contains":
        return normalized.includes(target);
      case "notContains":
        return !normalized.includes(target);
      case "is":
        return normalized === target;
      case "matches":
        try {
          return await RegexMatcher.test(targetValue, fieldValue);
        } catch (error) {
          console.warn(`[KeywordCal] Regex condition failed: ${error.message}`);
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
        // value format: "Header-Name::pattern" — look up raw header value.
        // Thunderbird's messages.get() returns headers as
        // { "X-Foo": ["value1", "value2"] } (arrays of strings), but older
        // shapes used plain strings — handle both. Normalize case so the map
        // is matched reliably regardless of how Thunderbird stores keys.
        const sep = (cond.value || "").indexOf("::");
        if (sep === -1) return "";
        const name = cond.value.slice(0, sep).trim().toLowerCase();
        const headers = msg.headers || {};
        const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
        if (typeof raw === "string") return raw;
        if (Array.isArray(raw)) return raw.join(", ");
        return "";
      }
      default:          return "";
    }
  },

  async _executeAction(msg, action) {
    let result = null;
    switch (action.type) {
      case "createEvent":
        result = await CalendarWriter.createEvent(msg, action);
        break;
      case "createTask":
        result = await CalendarWriter.createTask(msg, action);
        break;
      case "createReminder":
        result = await CalendarWriter.createReminder(msg, action);
        break;
      default:
        console.warn(`[KeywordCal] Unknown action type: ${action.type}`);
    }
    // Annotate with the action type so the popup can label outcomes.
    return { actionType: action.type, outcome: result };
  },
};
