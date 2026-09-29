/**
 * KeywordCal - Background Service Worker
 *
 * 1. Listens for new mail and dispatches to the Rule Engine.
 * 2. Provides a message API for the toolbar popup (status, run-on-selected,
 *    test-run without writing).
 * 3. Keeps the toolbar badge in sync with the number of active rules.
 */

"use strict";

// ---------- Shared helpers ----------

/**
 * Recursively extract plain text from MIME parts.
 */
function extractPlainText(part) {
  if (part.contentType === "text/plain" && part.body) {
    return part.body;
  }
  if (part.parts) {
    return part.parts.map(extractPlainText).join("\n");
  }
  // HTML-only messages: strip tags so keyword/date rules still work.
  if (part.contentType === "text/html" && part.body) {
    return part.body.replace(/<[^>]+>/g, " ");
  }
  return "";
}

/**
 * Fetch headers + body for a message id and build the context object the
 * Rule Engine evaluates.
 */
async function buildMessageContext(messageId) {
  const header = await browser.messages.get(messageId);
  const full = await browser.messages.getFull(messageId);
  const body = extractPlainText(full);

  return {
    id: messageId,
    subject: header.subject || "",
    sender: header.author || "",
    recipients: (header.recipients || []).join(", "),
    date: header.date ? new Date(header.date) : new Date(),
    body: body.slice(0, 50000), // Cap at 50KB
    headers: header,
  };
}

// ---------- Badge ----------

async function refreshBadge() {
  try {
    const rules = await RuleStore.getActiveRules();
    await browser.browserAction.setBadgeText({
      text: rules.length > 0 ? String(rules.length) : "",
    });
    await browser.browserAction.setBadgeBackgroundColor({ color: "#0a84ff" });
  } catch (e) {
    /* badge is best-effort */
  }
}

browser.storage.local.onChanged.addListener((changes) => {
  if (changes[RuleStore.STORAGE_KEY]) refreshBadge();
});

// ---------- New-mail listener ----------

browser.messages.onNewMailReceived.addListener(async (folder, messages) => {
  console.log(`[KeywordCal] New mail in ${folder.name}: ${messages.length} message(s)`);

  const rules = await RuleStore.getActiveRules();
  if (rules.length === 0) return;

  for (const message of messages) {
    try {
      const messageContext = await buildMessageContext(message.id);
      await RuleEngine.evaluate(messageContext, rules);
    } catch (err) {
      console.error(`[KeywordCal] Error processing message ${message.id}:`, err);
    }
  }
});

// ---------- Popup / cross-page message API ----------

browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "keywordcal:getStatus": {
      const [all, bridgeId] = await Promise.all([
        RuleStore.getAllRules(),
        CalendarWriter.findBridge(),
      ]);
      const calendars = bridgeId ? await CalendarWriter.listCalendars() : null;
      return {
        totalRules: all.length,
        activeRules: all.filter((r) => r.enabled).length,
        lastTriggered: all
          .map((r) => r.lastTriggered)
          .filter(Boolean)
          .sort()
          .reverse()[0] || null,
        bridgeInstalled: !!bridgeId,
        calendars: calendars || [],
      };
    }

    case "keywordcal:runOnSelected": {
      // Run the rule engine on the currently selected message WITHOUT
      // creating anything — returns which rules would match.
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.messageId) {
          return { ok: false, error: "Select a single email message first." };
        }
        const ctx = await buildMessageContext(tab.messageId);
        const rules = await RuleStore.getActiveRules();
        const matching = rules.filter((r) => RuleEngine._matchConditions(ctx, r));
        return {
          ok: true,
          subject: ctx.subject,
          matches: matching.map((r) => ({ name: r.name, actions: r.actions.length })),
        };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }

    case "keywordcal:executeOnSelected": {
      // Actually run the engine on the selected message (creates events).
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.messageId) {
          return { ok: false, error: "Select a single email message first." };
        }
        const ctx = await buildMessageContext(tab.messageId);
        const rules = await RuleStore.getActiveRules();
        const result = await RuleEngine.evaluate(ctx, rules);
        return { ok: true, subject: ctx.subject, result };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }

    case "keywordcal:listCalendars": {
      const bridgeId = await CalendarWriter.findBridge();
      const calendars = bridgeId ? await CalendarWriter.listCalendars() : null;
      return { bridgeInstalled: !!bridgeId, calendars: calendars || [] };
    }

    default:
      return undefined;
  }
});

// ---------- Lifecycle ----------

browser.runtime.onStartup.addListener(refreshBadge);

/**
 * Seed default rules on first install.
 */
browser.runtime.onInstalled.addListener(async () => {
  await RuleStore.seedDefaults();
  await refreshBadge();
});
