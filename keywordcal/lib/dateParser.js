/**
 * DateParser - Extracts dates from text using regex and heuristics.
 */
"use strict";

const DateParser = {
  /**
   * Extract the first date matching the given regex pattern.
   */
  extract(text, pattern) {
    if (!pattern) return this._heuristicExtract(text);

    try {
      const match = text.match(new RegExp(pattern, "i"));
      if (match) {
        const parsed = new Date(match[0]);
        if (!isNaN(parsed.getTime())) return parsed;
      }
    } catch {
      console.warn(`[KeywordCal] Invalid date pattern: ${pattern}`);
    }
    return null;
  },

  /**
   * Fallback heuristic: look for common date formats.
   */
  _heuristicExtract(text) {
    const patterns = [
      /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/,           // MM/DD/YYYY
      /\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/,             // YYYY-MM-DD
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i,
      /\btomorrow\b/i,
      /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    ];

    for (const p of patterns) {
      const match = text.match(p);
      if (match) {
        if (/tomorrow/i.test(match[0])) {
          const d = new Date();
          d.setDate(d.getDate() + 1);
          d.setHours(9, 0, 0, 0);
          return d;
        }
        if (/next\s+/i.test(match[0])) {
          return this._nextWeekday(match[0]);
        }
        const parsed = new Date(match[0]);
        if (!isNaN(parsed.getTime())) return parsed;
      }
    }
    return null;
  },

  _nextWeekday(text) {
    const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    const target = days.findIndex((d) => text.toLowerCase().includes(d));
    if (target === -1) return null;

    const now = new Date();
    const diff = (target - now.getDay() + 7) % 7 || 7;
    const d = new Date(now);
    d.setDate(d.getDate() + diff);
    d.setHours(9, 0, 0, 0);
    return d;
  },
};
