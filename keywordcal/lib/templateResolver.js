/**
 * TemplateResolver - Replaces {variables} in action templates.
 */
"use strict";

const TemplateResolver = {
  resolve(template, msg) {
    if (!template) return "";
    return template
      .replace(/\{subject\}/gi, msg.subject)
      .replace(/\{sender\}/gi, msg.sender)
      .replace(/\{date\}/gi, msg.date.toISOString().split("T")[0])
      .replace(/\{body_excerpt\}/gi, msg.body.slice(0, 500))
      .replace(/\{keyword\}/gi, msg.keyword || ""); // Populated by rule engine if needed
  },
};
