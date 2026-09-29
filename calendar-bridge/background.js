/**
 * KeywordCal Calendar Bridge - background script.
 *
 * 1. Answers KeywordCal's discovery broadcast ("registry") so the main
 *    add-on can find us via browser.runtime.sendMessage().
 * 2. Relays messages from KeywordCal to the privileged experiment API.
 * 3. Proactively registers itself in browser.storage.local under the key
 *    "keywordcal_bridge_id" — a shared, origin-scoped fallback for when
 *    cross-extension messaging is blocked by Thunderbird's privacy
 *    settings (mail.extensionsCrossClientPrivilegedCollaboration=false).
 */

"use strict";

// KeywordCal's own extension id (hardcoded so we can seed shared storage
// for it even before KeywordCal asks us anything).
const KEYWORDCAL_ID = "keywordcal@yourdomain.com";
const BRIDGE_ID = "keywordcal-bridge@yourdomain.com";

// --- Shared-storage registration (fallback discovery channel) ---
// Thunderbird gives all add-ons from the same origin (here: temporary/
// unpacked installs) one shared browser.storage.local. We pre-write our
// id into KeywordCal's copy so discovery works even when cross-extension
// messaging is blocked by privacy prefs. Re-seeded on startup/install
// because a KeywordCal-side cleanup may clear it.
function registerWithKeywordCal() {
  try {
    browser.storage.local
      .set({ keywordcal_bridge_id: BRIDGE_ID })
      .catch(() => {});
  } catch (e) {
    /* storage not ready yet */
  }
}
registerWithKeywordCal();
browser.runtime.onStartup.addListener(registerWithKeywordCal);
browser.runtime.onInstalled.addListener(registerWithKeywordCal);

// --- Discovery + method relay over cross-extension messaging ---
browser.runtime.onMessageExternal.addListener((message, sender) =>
  handle(message, sender)
);
browser.runtime.onMessage.addListener((message, sender) => {
  if (sender && sender.id === BRIDGE_ID) return undefined; // ignore self
  return handle(message, sender);
});

async function handle(message, sender) {
  if (!message || typeof message !== "object") return undefined;

  // Only serve KeywordCal itself.
  if (sender && sender.id && sender.id !== KEYWORDCAL_ID) return undefined;

  if (message.keywordcal === "registry") {
    return { extensionId: BRIDGE_ID, methods: ["listCalendars", "createItem"] };
  }

  if (typeof message.method !== "string") return undefined;
  if (!["listCalendars", "createItem"].includes(message.method)) return undefined;

  try {
    const api = browser.BridgeParent;
    if (!api || typeof api[message.method] !== "function") {
      return { ok: false, error: "BridgeParent experiment API unavailable" };
    }
    if (message.method === "listCalendars") {
      return await api.listCalendars();
    }
    return await api.createItem(message.item || {});
  } catch (err) {
    console.error("[KeywordCal Bridge] handler error:", err);
    return { ok: false, error: String(err) };
  }
}
