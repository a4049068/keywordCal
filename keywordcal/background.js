/**
 * KeywordCal - Background Service Worker
 * Listens for new mail and dispatches to the Rule Engine.
 */

"use strict";

browser.messages.onNewMailReceived.addListener(async (folder, messages) => {
  console.log(`[KeywordCal] New mail in ${folder.name}: ${messages.length} message(s)`);

  const rules = await RuleStore.getActiveRules();
  if (rules.length === 0) return;

  for (const message of messages) {
    try {
      // Fetch headers
      const header = await browser.messages.get(message.id);

      // Fetch full body (plain text)
      const full = await browser.messages.getFull(message.id);
      const body = extractPlainText(full);

      const messageContext = {
        id: message.id,
        subject: header.subject || "",
        sender: header.author || "",
        recipients: (header.recipients || []).join(", "),
        date: header.date ? new Date(header.date) : new Date(),
        body: body.slice(0, 50000), // Cap at 50KB
        headers: header,
      };

      await RuleEngine.evaluate(messageContext, rules);
    } catch (err) {
      console.error(`[KeywordCal] Error processing message ${message.id}:`, err);
    }
  }
});

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
  return "";
}

/**
 * Seed default rules on first install.
 */
browser.runtime.onInstalled.addListener(async () => {
  await RuleStore.seedDefaults();
});
