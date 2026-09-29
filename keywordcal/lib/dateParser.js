/**
 * DateParser - Extracts dates from text using regex and heuristics.
 */
"use strict";

const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

function parseYearless(token, year) {
  const numeric = /^(\d{1,2})[/-](\d{1,2})$/.exec(token);
  if (numeric) {
    const date = new Date(year, Number(numeric[1]) - 1, Number(numeric[2]));
    if (date.getFullYear() !== year || date.getMonth() !== Number(numeric[1]) - 1 ||
        date.getDate() !== Number(numeric[2])) return null;
    return date;
  }
  const normalized = token.replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  const date = new Date(`${normalized}, ${year}`);
  return isNaN(date.getTime()) ? null : date;
}

const DateParser = {
  /** Return the selected date and enough provenance to decide whether to review it. */
  async extract(text, pattern, { messageDate = new Date(), yearPolicy = "message-year" } = {}) {
    if (!text) return null;
    if (!pattern) return this._heuristicExtract(text, { messageDate, yearPolicy });

    try {
      const match = await RegexMatcher.exec(pattern, text);
      if (match) {
        const token = (match[1] || match[0]).trim();
        const parsed = this._fromToken(token, { messageDate, yearPolicy });
        if (parsed) {
          const heuristic = this._heuristicExtract(text, { messageDate, yearPolicy });
          const candidateCount = Math.max(1, heuristic?.candidateCount || 0);
          return {
            ...parsed,
            token,
            source: "pattern",
            candidateCount,
            uncertain: parsed.yearInferred || candidateCount > 1,
          };
        }
        console.warn(`[KeywordCal] Date pattern matched "${token}" but it is not a parseable date.`);
      }
    } catch (error) {
      console.warn(`[KeywordCal] Date pattern could not be evaluated: ${error.message}`);
    }
    return this._heuristicExtract(text, { messageDate, yearPolicy });
  },

  /** Parse one token, retaining whether its year came from policy. */
  _fromToken(token, { messageDate = new Date(), yearPolicy = "message-year" } = {}) {
    if (/\btomorrow\b/i.test(token)) {
      return { date: this._at9am(1, messageDate), yearInferred: false };
    }
    const rel = /\b(this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(token);
    if (rel) {
      return {
        date: this._weekdayOf(rel[2], /\bnext\b/i.test(token) ? "next" : "this", messageDate),
        yearInferred: false,
      };
    }

    const hasYear = /\b\d{4}\b/.test(token) ||
      /\d{1,2}[/-]\d{1,2}[/-]\d{2}\b/.test(token) ||
      /\b\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+\.?[,]?\s+\d{2}\b/i.test(token) ||
      /\b[a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{2}\b/i.test(token);
    if (hasYear) {
      const date = new Date(token.replace(/(\d)(st|nd|rd|th)\b/gi, "$1"));
      return isNaN(date.getTime()) ? null : { date, yearInferred: false };
    }

    const reference = yearPolicy === "upcoming" ? new Date() : new Date(messageDate);
    let date = parseYearless(token, reference.getFullYear());
    if (!date) return null;
    if (yearPolicy === "upcoming") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (date < today) date = parseYearless(token, date.getFullYear() + 1);
      if (!date) return null;
    }
    return { date, yearInferred: true };
  },

  /** Find distinct candidate dates and select the first one in the text. */
  _heuristicExtract(text, options) {
    const candidates = new Map();
    const searchableText = text.split("");
    const addCandidate = (token, index) => {
      const parsed = this._fromToken(token, options);
      if (parsed) {
        candidates.set(parsed.date.toDateString(), { ...parsed, token, index });
      }
    };

    const namedRange = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*[-\u2013\u2014]\s*(\d{1,2})(?:st|nd|rd|th)?/gi;
    for (const match of text.matchAll(namedRange)) {
      const month = match[1];
      const addRange = (first, last, index, rangeText) => {
        addCandidate(`${month} ${first}`, index);
        addCandidate(`${month} ${last}`, index + rangeText.lastIndexOf(String(last)));
      };
      addRange(match[2], match[3], match.index, match[0]);

      let rangeEnd = match.index + match[0].length;
      while (true) {
        const repeatedRange = /^\s*,\s*(?:and\s+)?(\d{1,2})(?:st|nd|rd|th)?\s*[-\u2013\u2014]\s*(\d{1,2})(?:st|nd|rd|th)?/i.exec(text.slice(rangeEnd));
        if (!repeatedRange) break;
        const rangeIndex = rangeEnd + repeatedRange.index;
        addRange(repeatedRange[1], repeatedRange[2], rangeIndex, repeatedRange[0]);
        rangeEnd += repeatedRange[0].length;
      }
      for (let index = match.index; index < rangeEnd; index += 1) searchableText[index] = " ";
    }

    const patterns = [
      /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/gi,
      /(?<![\d/-])\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g,
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}\b/gi,
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/gi,
      /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:,?\s+\d{2,4})?\b/gi,
      /\b(?:this|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
      /\btomorrow\b/gi,
    ];

    const remainingText = searchableText.join("");
    for (const pattern of patterns) {
      for (const match of remainingText.matchAll(pattern)) {
        addCandidate(match[0], match.index);
      }
    }
    const ordered = [...candidates.values()].sort((a, b) => a.index - b.index);
    if (!ordered.length) return null;
    const selected = ordered[0];
    return {
      date: selected.date,
      token: selected.token,
      source: "heuristic",
      yearInferred: selected.yearInferred,
      candidateCount: ordered.length,
      uncertain: selected.yearInferred || ordered.length > 1,
    };
  },

  /** Tomorrow (or +N days) at 09:00 relative to the message date. */
  _at9am(daysAhead, baseDate = new Date()) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + daysAhead);
    d.setHours(9, 0, 0, 0);
    return d;
  },

  /** Upcoming `name` weekday; "next" skips same-day matches. */
  _weekdayOf(name, mode, baseDate = new Date()) {
    const target = WEEKDAYS.indexOf(name.toLowerCase());
    if (target === -1) return null;
    const now = new Date(baseDate);
    let diff = (target - now.getDay() + 7) % 7;
    if (mode === "next" && diff === 0) diff = 7;
    return this._at9am(diff, baseDate);
  },
};
