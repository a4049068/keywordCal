/**
 * TemplateResolver - Replaces {variables} in action templates.
 */
"use strict";

const TemplateResolver = {
  resolve(template, msg) {
    if (!template) return "";
    const vars = {
      subject: msg.subject || "",
      sender: msg.sender || "",
      date: msg.date ? msg.date.toISOString().split("T")[0] : "",
      body_excerpt: (msg.body || "").slice(0, 500),
      keyword: msg.keyword || "",
    };
    // Use a replacer FUNCTION so "$&"/"$1"-style sequences inside message
    // text are inserted literally instead of being interpreted as
    // replacement patterns.
    return template.replace(/\{(\w+)\}/gi, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name.toLowerCase())
        ? vars[name.toLowerCase()]
        : whole // leave unknown placeholders visible rather than deleting them
    );
  },
};
