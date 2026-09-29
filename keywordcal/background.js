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

  // Thunderbird's MsgHdrWithObject returns `recipients` as an array of
  // address objects ({ displayName, email, type }), not strings — joining
  // those directly would produce "[object Object]" in rules/templates.
  const recipients = (header.recipients || [])
    .map((r) => (typeof r === "string" ? r : r.email || r.displayName || ""))
    .filter(Boolean)
    .join(", ");

  return {
    id: messageId,
    subject: header.subject || "",
    sender: header.author || "",
    recipients,
    date: header.date ? new Date(header.date) : new Date(),
    body: body.slice(0, 50000), // Cap at 50KB
    headers: header.headers || {}, // raw { name: [values] } map for header conditions
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

// Keep the badge in sync across every context that owns a copy of this
// script (background page, options tab, popup): whenever the rule storage
// key changes anywhere, recompute it.
browser.storage.local.onChanged.addListener((changes) => {
  if (changes[RuleStore.STORAGE_KEY]) refreshBadge();
});

// ---------- New-mail listener ----------

browser.messages.onNewMailReceived.addListener(async (folder, messages) => {
  const incoming = Array.isArray(messages) ? messages : (messages ? [messages] : []);
  console.log(`[KeywordCal] New mail in ${folder && folder.name ? folder.name : "unknown"}: ${incoming.length} message(s)`);

  if (incoming.length === 0) return;

  const rules = await RuleStore.getActiveRules();
  if (rules.length === 0) return;

  for (const message of incoming) {
      if (!message || !message.id) continue;
      if (CalendarWriter.shouldSkipDuplicate(message.id)) {
        console.log(`[KeywordCal] Skipping duplicate delivery of message ${message.id} (within ${CalendarWriter.DEDUPE_WINDOW_MS / 1000}s window)`);
        continue;
      }
      try {
        const messageContext = await buildMessageContext(message.id);
        await RuleEngine.evaluate(messageContext, rules);
      } catch (err) {
        console.error(`[KeywordCal] Error processing message ${message.id}:`, err);
      }
  }
});

// ---------- Popup / cross-page message API ----------

/**
 * Resolve the currently selected message; prefer Thunderbird's mailTabs API
 * because the popup is not itself a mail tab and may not have a messageId.
 */
async function getSelectedMessageId() {
  if (browser.mailTabs && typeof browser.mailTabs.getSelectedMessages === "function") {
    try {
      const selected = await browser.mailTabs.getSelectedMessages();
      const list = Array.isArray(selected)
        ? selected
        : (selected && Array.isArray(selected.messages) ? selected.messages : []);
      const first = list.find((message) => message && (message.id || message.messageId));
      if (first) return first.id || first.messageId;
    } catch (e) {
      // Fall back to the tab heuristic below.
    }
  }

  let tabs = [];
  try {
    tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) tabs = await browser.tabs.query({ active: true });
  } catch (e) {
    tabs = await browser.tabs.query({ active: true });
  }
  const tab = tabs.find((t) => t && t.messageId) || null;
  return tab ? tab.messageId : null;
}

/**
 * Resolve the currently selected message once, for both test and run.
 */
async function _selectedContext() {
  const messageId = await getSelectedMessageId();
  if (!messageId) {
    return { error: "Select an email message first." };
  }
  try {
    return { ctx: await buildMessageContext(messageId) };
  } catch (err) {
    return { error: String(err) };
  }
}

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
      // Dry run: which rules WOULD match the selected message (creates nothing).
      const { ctx, error } = await _selectedContext();
      if (error) return { ok: false, error };
      const rules = await RuleStore.getActiveRules();
      return {
        ok: true,
        subject: ctx.subject,
        matches: rules
          .map((r) => ({ rule: r, passed: RuleEngine._matchedConditions(ctx, r) }))
          .filter(({ passed }) => passed)
          .map(({ rule, passed }) => ({
            name: rule.name,
            actions: rule.actions.length,
            why: passed.map((c) => `${c.field} ${c.operator} "${c.value}"`).join(rule.matchType === "all" ? " AND " : " OR "),
          })),
      };
    }

    case "keywordcal:executeOnSelected": {
      // Actually run the engine on the selected message (creates events).
      const { ctx, error } = await _selectedContext();
      if (error) return { ok: false, error };
      const result = await RuleEngine.evaluate(ctx, await RuleStore.getActiveRules());
      return { ok: true, subject: ctx.subject, result };
    }

    case "keywordcal:getUndoStatus": {
      const entry = await CalendarWriter.peekUndo();
      return { available: !!entry, entry };
    }

    case "keywordcal:undoLast": {
      const res = await CalendarWriter.undoLast();
      return res || { ok: false, error: "calendar bridge unavailable" };
    }

    case "keywordcal:listCalendars": {
      const bridgeId = await CalendarWriter.findBridge();
      const calendars = bridgeId ? await CalendarWriter.listCalendars() : null;
      return { bridgeInstalled: !!bridgeId, calendars: calendars || [] };
    }

    case "keywordcal:refreshBadge": {
      // Called by the options page after it mutates rules (each document
      // has its own globals in MV2, so RuleStore._write can't reach us).
      await refreshBadge();
      return { ok: true };
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
