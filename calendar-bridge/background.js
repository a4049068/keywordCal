/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * KeywordCal Calendar Bridge — background script.
 *
 * Responsibilities (all verbose-logged so the Browser Console tells you
 * exactly what happened):
 *   1. Register this add-on's id in shared browser.storage.local under
 *      "keywordcal_bridge_id" on startup/install/update. That is the
 *      PRIMARY discovery channel KeywordCal uses (cross-extension
 *      messaging is blocked by default privacy prefs, so we do NOT rely
 *      on it).
 *   2. Serve KeywordCal's messages: { keywordcal: "registry" } -> our id;
 *      { method: "listCalendars" | "createItem" | "deleteItem", item? } -> forwarded to
 *      the privileged BridgeParent experiment API defined in api.js.
 *
 * Only requests from KeywordCal itself are served; everything else is
 * ignored and logged.
 */

const KEYWORDCAL_ID = "keywordcal@yourdomain.com";
const BRIDGE_ID = "keywordcal-bridge@yourdomain.com";
const BRIDGE_STORAGE_KEY = "keywordcal_bridge_id";
const LOG_PREFIX = "[KeywordCal Bridge]";

// Anything that isn't our known protocol shape (foreign add-on discovery
// pings from CardBook/VFS Toolkit/FileLink, junk payloads, etc.) is expected
// and harmless — drop it silently. Only KeywordCal's own traffic is served.
function isForeignNoise(message) {
  if (!message || typeof message !== "object") return true; // junk payload
  return !(message.keywordcal === "registry" ||
    ["listCalendars", "createItem", "deleteItem"].includes(message.method));
}

function log(...args) { console.log(LOG_PREFIX, ...args); }
function warn(...args) { console.warn(LOG_PREFIX, ...args); }

// ---------- 1. Shared-storage registration ----------

// The "storage" permission must be granted before browser.storage.local
// exists; on temporary installs it can lag behind the background script's
// first lines, so retry with backoff instead of giving up once.
const RETRY_DELAYS_MS = [250, 1000, 3000, 8000, 20000];

async function register(attempt = 0) {
  try {
    if (!browser.storage || !browser.storage.local) throw new Error("api missing");
    await browser.storage.local.set({ [BRIDGE_STORAGE_KEY]: BRIDGE_ID });
    log(`registered as "${BRIDGE_ID}" in shared storage (attempt ${attempt + 1})`);
    return true;
  } catch (e) {
    if (attempt < RETRY_DELAYS_MS.length) {
      log(`storage not ready (attempt ${attempt + 1}: ${e.message}) — retrying in ${RETRY_DELAYS_MS[attempt]}ms`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      return register(attempt + 1);
    }
    warn("storage permanently unavailable after retries — direct-message discovery still active; KeywordCal may fall back to .ics drafts");
    return false;
  }
}

register();
browser.runtime.onStartup.addListener(() => register());
browser.runtime.onInstalled.addListener((info) => {
  log("onInstalled:", JSON.stringify(info));
  register();
});

// ---------- 2. Message relay ----------

async function handle(message, sender) {
  if (!message || typeof message !== "object") return undefined;

  // Serve KeywordCal only. Other add-ons constantly broadcast discovery
  // pings to every extension via onMessageExternal; drop all foreign
  // traffic silently EXCEPT KeywordCal-shaped requests that arrive from an
  // unexpected sender id (those indicate a misconfigured install and are
  // worth one warning line).
  if (!sender || sender.id !== KEYWORDCAL_ID) {
    if (!isForeignNoise(message)) {
      warn(`KeywordCal-shaped request from unexpected sender "${sender && sender.id}" — ignoring. ` +
        `Expected sender id: ${KEYWORDCAL_ID}. If you renamed/reinstalled KeywordCal, ` +
        `check its manifest applications.gecko.id.`);
    }
    return undefined;
  }

  if (message.keywordcal === "registry") {
    log("registry probe answered");
    return { extensionId: BRIDGE_ID, methods: ["listCalendars", "createItem", "deleteItem"] };
  }

  const method = message.method;
  if (!["listCalendars", "createItem", "deleteItem"].includes(method)) {
    warn(`unknown method "${method}" — ignoring`);
    return undefined;
  }

  const api = browser.BridgeParent;
  if (!api || typeof api[method] !== "function") {
    warn(`BridgeParent.${method} unavailable — is the experiment API loaded?`);
    return { ok: false, error: "BridgeParent experiment API unavailable" };
  }

  log(`relaying ${method} to experiment API`);
  try {
    return method === "listCalendars"
      ? await api.listCalendars()
      : await api[method](message.item || {});
  } catch (err) {
    warn(`${method} threw:`, err);
    return { ok: false, error: String(err) };
  }
}

// KeywordCal talks to us via runtime.sendMessage(bridgeId, ...) which
// arrives on BOTH listeners below depending on how Thunderbird routes
// same-origin cross-extension messages. Handle both identically.
browser.runtime.onMessageExternal.addListener((message, sender) =>
  handle(message, sender)
);
browser.runtime.onMessage.addListener((message, sender) =>
  handle(message, sender)
);

log("background script loaded; waiting for KeywordCal");
