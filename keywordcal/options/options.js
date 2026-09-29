/**
 * KeywordCal - Options UI logic
 * Rule management interface backed by RuleStore (browser.storage.local).
 */
"use strict";

// Keep the toolbar badge fresh: this page writes rules, and in MV2 each
// document has its own globals, so call the background script after every
// storage mutation.
async function refreshBadge() {
  try {
    await browser.runtime.sendMessage({ type: "keywordcal:refreshBadge" });
  } catch (e) {
    /* background may be momentarily unavailable — best-effort */
  }
}

const elements = {
  ruleList: document.getElementById("rule-list"),
  emptyHint: document.getElementById("empty-hint"),
  addRuleBtn: document.getElementById("add-rule"),
  restoreDefaultsBtn: document.getElementById("restore-defaults"),
  editorSection: document.getElementById("editor-section"),
  editorTitle: document.getElementById("editor-title"),
  form: document.getElementById("rule-form"),
  name: document.getElementById("rule-name"),
  enabled: document.getElementById("rule-enabled"),
  matchType: document.getElementById("match-type"),
  condBody: document.querySelector("#conditions-table tbody"),
  addCondBtn: document.getElementById("add-condition"),
  actionsContainer: document.getElementById("actions-container"),
  addActionBtn: document.getElementById("add-action"),
  stopProcessing: document.getElementById("stop-processing"),
  cancelBtn: document.getElementById("cancel-edit"),
  condTemplate: document.getElementById("condition-row"),
  actionTemplate: document.getElementById("action-row"),
};

let editingRuleId = null; // null = creating a new rule

// ---------- Rule list rendering ----------

async function renderRuleList() {
  const rules = await RuleStore.getAllRules();
  elements.ruleList.innerHTML = "";
  elements.emptyHint.classList.toggle("hidden", rules.length > 0);

  for (const rule of rules) {
    const li = document.createElement("li");
    if (!rule.enabled) li.classList.add("disabled");

    const name = document.createElement("span");
    name.className = "rule-name";
    name.textContent = rule.name || "(unnamed rule)";

    const meta = document.createElement("span");
    meta.className = "rule-meta";
    meta.textContent =
      `${rule.conditions.length} condition(s), ${rule.actions.length} action(s)` +
      (rule.lastTriggered ? ` · last: ${new Date(rule.lastTriggered).toLocaleString()}` : "");

    const toggleBtn = makeButton(rule.enabled ? "Disable" : "Enable", "small secondary", async () => {
      await RuleStore.updateRule({ id: rule.id, enabled: !rule.enabled });
      await refreshBadge();
      renderRuleList();
    });

    const editBtn = makeButton("Edit", "small secondary", () => openEditor(rule));
    const delBtn = makeButton("Delete", "small danger", async () => {
      if (confirm(`Delete rule "${rule.name}"?`)) {
        await RuleStore.deleteRule(rule.id);
        await refreshBadge();
        renderRuleList();
      }
    });

    li.append(name, meta, toggleBtn, editBtn, delBtn);
    elements.ruleList.appendChild(li);
  }
}

function makeButton(label, className, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

// ---------- Condition / action rows ----------

function addConditionRow(cond = {}) {
  const row = elements.condTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector(".cond-field").value = cond.field || "subject";
  row.querySelector(".cond-operator").value = cond.operator || "contains";
  row.querySelector(".cond-value").value = cond.value || "";
  row.querySelector(".remove-condition").addEventListener("click", () => row.remove());
  elements.condBody.appendChild(row);
}

function addActionRow(action = {}) {
  const block = elements.actionTemplate.content.firstElementChild.cloneNode(true);
  block.querySelector(".action-type").value = action.type || "createEvent";
  block.querySelector(".action-title-template").value = action.titleTemplate ?? "{subject}";
  block.querySelector(".action-desc-template").value = action.descriptionTemplate ?? "{sender}";
  block.querySelector(".action-date-source").value = action.dateSource || "extract";
  block.querySelector(".action-date-pattern").value = action.datePattern || "";
  block.querySelector(".action-fixed-offset").value = action.fixedOffsetDays ?? 0;
  block.querySelector(".action-duration").value = action.durationMinutes ?? 60;
  block.querySelector(".action-reminders").value = (action.reminderMinutes || []).join(", ");
  const calSelect = block.querySelector(".action-calendar");
  const calManual = block.querySelector(".action-calendar-manual");
  const wantedCal = action.calendarId || "default";
  if (wantedCal !== "default" && !knownCalendars.some((c) => c.id === wantedCal)) {
    calManual.value = wantedCal; // custom name/id typed by the user
  }
  fillCalendarSelect(calSelect, wantedCal);
  syncCalendarControl(block);
  calManual.addEventListener("input", () => syncCalendarControl(block));
  block.querySelector(".action-category").value = action.category || "";
  block.querySelector(".remove-action").addEventListener("click", () => block.remove());
  elements.actionsContainer.appendChild(block);
}

function collectConditions() {
  return [...elements.condBody.querySelectorAll("tr")].map((row) => ({
    field: row.querySelector(".cond-field").value,
    operator: row.querySelector(".cond-operator").value,
    value: row.querySelector(".cond-value").value,
  }));
}

function collectActions() {
  return [...elements.actionsContainer.querySelectorAll(".action-block")].map((block) => {
    const dateSource = block.querySelector(".action-date-source").value;
    const fixedOffset = parseInt(block.querySelector(".action-fixed-offset").value, 10);
    return {
      type: block.querySelector(".action-type").value,
      titleTemplate: block.querySelector(".action-title-template").value,
      descriptionTemplate: block.querySelector(".action-desc-template").value,
      dateSource,
      datePattern: block.querySelector(".action-date-pattern").value || undefined,
      fixedOffsetDays: dateSource === "fixed" && Number.isFinite(fixedOffset) ? fixedOffset : undefined,
      durationMinutes: Number(block.querySelector(".action-duration").value) || 0,
      reminderMinutes: block
        .querySelector(".action-reminders").value
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n)),
      calendarId: getBlockCalendarId(block),
      category: block.querySelector(".action-category").value || undefined,
    };
  });
}

// ---------- Editor ----------

// Calendar picker: populated from the Calendar Bridge when available.
let knownCalendars = []; // [{ id, name }]

async function refreshCalendarList() {
  try {
    const res = await browser.runtime.sendMessage({ type: "keywordcal:listCalendars" });
    knownCalendars = (res && res.calendars) || [];
  } catch (e) {
    knownCalendars = [];
  }
}

function fillCalendarSelect(select, current) {
  select.innerHTML = "";
  const mk = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  };
  mk("default", "Default calendar");
  for (const c of knownCalendars) mk(c.id, `${c.name}${c.canWrite === false ? " (read-only)" : ""}`);
  if (current && current !== "default" && !knownCalendars.some((c) => c.id === current)) {
    mk(current, `${current} (custom)`);
  }
  select.value = [...select.options].some((o) => o.value === current) ? current : "default";
}

function syncCalendarControl(block) {
  const sel = block.querySelector(".action-calendar");
  const manual = block.querySelector(".action-calendar-manual");
  const useManual = manual.value.trim() !== "";
  sel.disabled = useManual;
  if (useManual) sel.selectedIndex = 0;
}

function getBlockCalendarId(block) {
  const manual = block.querySelector(".action-calendar-manual").value.trim();
  return manual || block.querySelector(".action-calendar").value || "default";
}

function openEditor(rule = null) {
  editingRuleId = rule ? rule.id : null;
  elements.editorTitle.textContent = rule ? `Edit Rule: ${rule.name}` : "New Rule";
  elements.name.value = rule ? rule.name : "";
  elements.enabled.checked = rule ? rule.enabled : true;
  elements.matchType.value = rule ? rule.matchType : "all";
  elements.stopProcessing.checked = rule ? !!rule.stopProcessing : false;

  elements.condBody.innerHTML = "";
  elements.actionsContainer.innerHTML = "";

  if (rule && rule.conditions.length) {
    rule.conditions.forEach(addConditionRow);
  } else {
    addConditionRow();
  }
  if (rule && rule.actions.length) {
    rule.actions.forEach(addActionRow);
  } else {
    addActionRow();
  }

  elements.editorSection.classList.remove("hidden");
  elements.editorSection.scrollIntoView({ behavior: "smooth" });
}

function closeEditor() {
  editingRuleId = null;
  elements.editorSection.classList.add("hidden");
}

async function saveRule(event) {
  event.preventDefault();

  const conditions = collectConditions().filter((c) => c.value.trim() !== "");
  const actions = collectActions();

  if (conditions.length === 0) {
    alert("A rule needs at least one condition with a value.");
    return;
  }
  if (actions.length === 0) {
    alert("A rule needs at least one action.");
    return;
  }

  const ruleData = {
    name: elements.name.value.trim(),
    enabled: elements.enabled.checked,
    matchType: elements.matchType.value,
    conditions,
    actions,
    stopProcessing: elements.stopProcessing.checked,
  };

  if (editingRuleId) {
    await RuleStore.updateRule({ id: editingRuleId, ...ruleData });
  } else {
    await RuleStore.addRule(ruleData);
  }

  await refreshBadge();
  closeEditor();
  renderRuleList();
}

// ---------- Wire up ----------

async function init() {
  await refreshCalendarList(); // populate picker before first render
  renderRuleList();
}

elements.addRuleBtn.addEventListener("click", () => openEditor());
elements.cancelBtn.addEventListener("click", closeEditor);
elements.form.addEventListener("submit", saveRule);
elements.addCondBtn.addEventListener("click", () => addConditionRow());
elements.addActionBtn.addEventListener("click", () => addActionRow());
elements.restoreDefaultsBtn.addEventListener("click", async () => {
  if (confirm("Add the four example rules to your rule list?")) {
    await RuleStore.seedDefaults(true);
    await refreshBadge();
    renderRuleList();
  }
});

init();
