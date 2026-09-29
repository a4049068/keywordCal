/**
 * DateParser - Extracts dates from text using regex and heuristics.
 */
"use strict";

const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

/**
 * Interpret a numeric m/d/y token. JS `new Date("10/15")` silently returns
 * *today's year*, which would file events in the past — so if no year was
 * present and the result is already behind us, assume next year.
 */
function parseNumeric(token) {
  const d = new Date(token);
  if (isNaN(d.getTime())) return null;
  if (!/\d{4}/.test(token)) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    if (d < now) d.setFullYear(d.getFullYear() + 1);
  }
  return d;
}

const DateParser = {
  /** First date matching `pattern` (falls back to heuristics when absent). */
  extract(text, pattern) {
    if (!text) return null;
    if (!pattern) return this._heuristicExtract(text);

    try {
      const match = text.match(new RegExp(pattern, "i"));
      if (match) {
        // Prefer capture group 1 ("(\d+/\d+)") over the full match, which may
        // carry surrounding words like "Deadline ".
        const token = (match[1] || match[0]).trim();
        return this._fromToken(token) ||
          console.warn(`[KeywordCal] Date pattern matched "${token}" but it is not a parseable date.`) ||
          this._heuristicExtract(text);
      }
    } catch {
      console.warn(`[KeywordCal] Invalid date pattern: ${pattern}`);
    }
    return this._heuristicExtract(text);
  },

  /** Parse one natural-language date token; null when unparseable. */
  _fromToken(token) {
    if (/\btomorrow\b/i.test(token)) return this._at9am(1);
    const rel = /\b(this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(token);
    if (rel) return this._weekdayOf(rel[2], /\bnext\b/i.test(token) ? "next" : "this");
    return parseNumeric(token);
  },

  /** Scan for common formats, most explicit first. */
  _heuristicExtract(text) {
    const patterns = [
      /\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/,                          // YYYY-MM-DD
      /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/,                        // M/D/YYYY
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/i,
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i,
      /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:,?\s+\d{4})?\b/i,
      /\b(?:this|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\btomorrow\b/i,
    ];
    for (const p of patterns) {
      const match = text.match(p);
      if (!match) continue;
      const parsed = this._fromToken(match[0]);
      if (parsed) return parsed;
    }
    return null;
  },

  /** Tomorrow (or +N days) at 09:00 local. */
  _at9am(daysAhead) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(9, 0, 0, 0);
    return d;
  },

  /** Upcoming `name` weekday; "next" skips same-day matches. */
  _weekdayOf(name, mode) {
    const target = WEEKDAYS.indexOf(name.toLowerCase());
    if (target === -1) return null;
    const now = new Date();
    let diff = (target - now.getDay() + 7) % 7;
    if (mode === "next" && diff === 0) diff = 7;
    return this._at9am(diff);
  },
};
