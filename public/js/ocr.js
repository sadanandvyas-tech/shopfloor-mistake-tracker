/**
 * ocr.js
 *
 * Wraps Tesseract.js to extract text from an uploaded image, then runs each
 * detected word through the local Dictionary for spelling suggestions.
 *
 * Public API:
 *   OCR.analyze(imageSource) -> Promise<{ text, words, misspellings }>
 *     - imageSource: File | Blob | data URL | HTMLImageElement | HTMLCanvasElement
 *     - words: array of unique alphabetic tokens detected in the image
 *     - misspellings: [{ word, suggestions }]  — only words that:
 *           (a) look like real words (length, vowel, no repetitive pattern),
 *           (b) are NOT in the dictionary even after suffix-stripping,
 *           (c) have a confident correction in the dictionary.
 *       Tokens that fail any of those checks are dropped (treated as OCR
 *       garbage rather than misspellings).
 */

(function (global) {
  // Minimum token length to consider; below this we assume OCR fragmented
  // a longer word into pieces (e.g., "issued" -> "iss" + "ued").
  const MIN_LEN = 4;

  async function analyze(imageSource, onProgress) {
    if (!global.Tesseract) {
      throw new Error("Tesseract.js failed to load. Check your internet connection.");
    }

    const result = await global.Tesseract.recognize(imageSource, "eng", {
      logger: m => {
        if (typeof onProgress === "function") onProgress(m);
      }
    });

    const text = (result && result.data && result.data.text) || "";
    const tokens = extractWords(text);
    const uniqueWords = [...new Set(tokens.map(t => t.toLowerCase()))];

    const misspellings = [];
    for (const word of uniqueWords) {
      if (!looksLikeWord(word)) continue;
      // Skip words already in the dictionary (or a likely inflected form of one).
      if (global.Dictionary.hasInflected(word)) continue;
      const suggestions = global.Dictionary.suggest(word, 3);
      // Only flag the word if we have a confident, similar correction;
      // this filters out OCR garbage that has no plausible match.
      if (suggestions.length > 0) {
        misspellings.push({ word, suggestions });
      }
    }

    return { text, words: uniqueWords, misspellings };
  }

  function extractWords(text) {
    if (!text) return [];
    // Match runs of letters; we keep ASCII for portability — Tesseract eng
    // output is overwhelmingly ASCII even for accented characters in input.
    const matches = text.match(/[A-Za-z][A-Za-z'-]*/g);
    return matches || [];
  }

  /**
   * Heuristic: does this token look like a real English word?
   * Filters out short fragments and noisy OCR output.
   */
  function looksLikeWord(token) {
    if (!token) return false;
    const w = token.toLowerCase();
    if (w.length < MIN_LEN) return false;
    if (/^\d+$/.test(w)) return false;
    if (!/[aeiouy]/.test(w)) return false;          // must contain a vowel
    // Reject "qqqq", "iisss", "----": any single character making up
    // more than half of the token.
    const counts = {};
    for (const c of w) counts[c] = (counts[c] || 0) + 1;
    const maxCount = Math.max.apply(null, Object.values(counts));
    if (maxCount > w.length * 0.55) return false;
    // Reject sequences with too many non-letter chars (apostrophes/hyphens).
    if ((w.match(/[^a-z]/g) || []).length > 1) return false;
    return true;
  }

  global.OCR = { analyze, extractWords, looksLikeWord };
})(window);
