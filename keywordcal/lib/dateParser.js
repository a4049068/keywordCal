/**
 * DateParser - Extracts dates from text using regex and heuristics.
 */
"use strict";

/**
 * Interpret a numeric m/d/y token. JS `new Date("10/15")` silently returns
 * *today's year*, which would file events in the past — so we add one guard:
 * if no year was present and the resulting date is already behind us, assume
 * the user meant next year.
 */
function parseNumeric(token) {
  const withYear = /\d{4}/.test(token);
  let d = new Date(token);
  if (isNaN(d.getTime())) return null;
  if (!withYear) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    if (d < now) d.setFullYear(d.getFullYear() + 1);
  }
  return d;
}

const DateParser = {
  /**
   * Extract the first date matching the given regex pattern.
   */
  extract(text, pattern) {
    if (!text) return null;
    if (!pattern) return this._heuristicExtract(text);

    try {
      const re = new RegExp(pattern, "i");
      const match = text.match(re);
      if (match) {
        // Prefer the first capturing group (e.g. "(\d{1,2}[/-]\d{1,2})") over
        // the full match, which may carry surrounding words like "Deadline ".
        const token = (match[1] || match[0]).trim();
        if (/tomorrow/i.test(token)) {
          const d = new Date();
          d.setDate(d.getDate() + 1);
          d.setHours(9, 0, 0, 0);
          return d;
        }
        const rel = this._relative(token);
        if (rel) return rel;
        const parsed = parseNumeric(token);
        if (parsed) return parsed;
        console.warn(`[KeywordCal] Date pattern matched "${token}" but it is not a parseable date.`);
      }
    } catch {
      console.warn(`[KeywordCal] Invalid date pattern: ${pattern}`);
    }
    return this._heuristicExtract(text); // pattern didn't yield a date -> heuristics
  },

  /**
   * Fallback heuristic: look for common date formats.
   */
  _heuristicExtract(text) {
    const patterns = [
      /\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/,             // YYYY-MM-DD
      /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/,           // M/D/YYYY
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/i,
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i,
      /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:,?\s+\d{4})?\b/i,
      /\b(?:this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\btomorrow\b/i,
    ];

    for (const p of patterns) {
      const match = text.match(p);
      if (!match) continue;
      if (/tomorrow/i.test(match[0])) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        return d;
      }
      if (/(this|next)\s+/i.test(match[0])) {
        const rel = this._weekdayOf(match[0], /next/i.test(match[0]) ? "next" : "this");
        if (rel) return rel;
        continue;
      }
      const parsed = parseNumeric(match[0]);
      if (parsed) return parsed;
    }
    return null;
  },

  _relative(token) {
    if (/\btomorrow\b/i.test(token)) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    }
    if (/\b(this|next)\s+/.test(token)) {
      return this._weekdayOf(token, /\bnext\b/i.test(token) ? "next" : "this");
    }
    return null;
  },

  _weekdayOf(text, mode) {
    const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    const lower = text.toLowerCase();
    const target = days.findIndex((d) => lower.includes(d));
    if (target === -1) return null;

    const now = new Date();
    let diff = (target - now.getDay() + 7) % 7;
    if (mode === "next" && diff === 0) diff = 7;
    const d = new Date(now);
    d.setDate(d.getDate() + diff);
    d.setHours(9, 0, 0, 0);
    return d;
  },

};
