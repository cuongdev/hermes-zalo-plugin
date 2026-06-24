// markdownToZalo.js
// Convert Markdown inline formatting to Zalo MessageContent styles array.
//
// Supported syntax:
//   **bold**       → Bold (b)
//   *italic*       → Italic (i)
//   __underline__  → Underline (u)
//   ~~strikethru~~ → StrikeThrough (s)
//   # heading      → Big (f_18)
//
// How it works:
// 1. Scan the text word-by-word to build a list of formatting spans.
// 2. Strip all markdown syntax chars to produce clean text.
// 3. Map each span's content range from original positions → clean positions.
// 4. Output clean text + styles array.

const TextStyle = {
  Bold: "b",
  Italic: "i",
  Underline: "u",
  StrikeThrough: "s",
  Red: "c_db342e",
  Orange: "c_f27806",
  Yellow: "c_f7b503",
  Green: "c_15a85f",
  Big: "f_18",
  Small: "f_13",
};

// Inline formatting rules: { open, close, style }
const FORMAT_RULES = [
  { open: "**", close: "**", style: TextStyle.Bold },
  { open: "__", close: "__", style: TextStyle.Underline },
  { open: "~~", close: "~~", style: TextStyle.StrikeThrough },
  { open: "*", close: "*", style: TextStyle.Italic },
];

// Color rules: {red:text} {orange:text} {yellow:text} {green:text}
const COLOR_RULES = [
  { open: "{red:", close: "}", style: TextStyle.Red },
  { open: "{orange:", close: "}", style: TextStyle.Orange },
  { open: "{yellow:", close: "}", style: TextStyle.Yellow },
  { open: "{green:", close: "}", style: TextStyle.Green },
];

/**
 * JS-style string length (surrogate pairs = 2).
 */
function jsStrLen(s) {
  let len = 0;
  for (const ch of s) {
    len += ch.charCodeAt(0) > 0xFFFF ? 2 : 1;
  }
  return len;
}

/**
 * Find all formatting spans in the text.
 * Returns spans sorted by contentStart.
 * Each span: { contentStart, contentEnd, style }
 * Positions are in the ORIGINAL text.
 */
function findSpans(text) {
  const allRules = [...FORMAT_RULES, ...COLOR_RULES];
  const spans = [];

  for (const rule of allRules) {
    const ol = rule.open.length;
    const cl = rule.close.length;
    let i = 0;
    while (i < text.length) {
      const oi = text.indexOf(rule.open, i);
      if (oi === -1) break;
      const ci = text.indexOf(rule.close, oi + ol);
      if (ci === -1) break;
      // Skip empty spans
      if (ci === oi + ol) {
        i = ci + cl;
        continue;
      }
      spans.push({
        contentStart: oi + ol,
        contentEnd: ci,
        style: rule.style,
      });
      i = ci + cl;
    }
  }

  // Heading: # at start-of-line
  const hdRe = /(^|\n)#+\s/g;
  let m;
  while ((m = hdRe.exec(text)) !== null) {
    const cs = m.index + m[0].length;
    const nl = text.indexOf("\n", cs);
    const ce = nl === -1 ? text.length : nl;
    if (ce > cs) {
      spans.push({ contentStart: cs, contentEnd: ce, style: TextStyle.Big });
    }
  }

  spans.sort((a, b) => a.contentStart - b.contentStart);
  return spans;
}

/**
 * Build a set of original-text character indices that are markdown syntax.
 */
function buildSyntaxSet(text) {
  const syntax = new Set();
  const allRules = [...FORMAT_RULES, ...COLOR_RULES];
  for (const rule of allRules) {
    const ol = rule.open.length;
    const cl = rule.close.length;
    let i = 0;
    while (i < text.length) {
      const oi = text.indexOf(rule.open, i);
      if (oi === -1) break;
      const ci = text.indexOf(rule.close, oi + ol);
      if (ci === -1) break;
      if (ci === oi + ol) {
        i = ci + cl;
        continue;
      }
      for (let j = 0; j < ol; j++) syntax.add(oi + j);
      for (let j = 0; j < cl; j++) syntax.add(ci + j);
      i = ci + cl;
    }
  }

  // Heading markers: # (and its following space) at start of line
  const hdRe = /(^|\n)#+\s/g;
  let m;
  while ((m = hdRe.exec(text)) !== null) {
    for (let j = 0; j < m[0].length; j++) syntax.add(m.index + j);
  }

  return syntax;
}

/**
 * Map a range from original text positions to clean text positions.
 * Range: [start, end) in original text (inclusive start, exclusive end).
 * Returns [cleanStart, cleanEnd) or null if the range maps to empty clean text.
 */
function mapRangeToClean(start, end, originalToClean) {
  // Find the first clean position >= start
  let cs = -1;
  for (let i = start; i < end; i++) {
    if (originalToClean.has(i)) {
      cs = originalToClean.get(i);
      break;
    }
  }
  if (cs === -1) return null;

  // Find the last clean position < end
  let ce = cs;
  for (let i = start; i < end; i++) {
    if (originalToClean.has(i)) {
      ce = originalToClean.get(i) + 1;
    }
  }

  return { start: cs, len: ce - cs };
}

/**
 * Parse markdown text, return clean text + styles array for Zalo.
 *
 * @param {string} md - Markdown text with inline formatting
 * @returns {{ text: string, styles: Array<{start:number, len:number, st:string}> }}
 */
function markdownToZalo(md) {
  if (!md) return { text: "", styles: [] };

  // Step 1: find markdown syntax positions
  const syntaxSet = buildSyntaxSet(md);

  // Step 2: build clean text and original→clean position map
  let cleanChars = [];
  const originalToClean = new Map(); // original index → clean index (for non-syntax chars)

  for (let i = 0; i < md.length; i++) {
    if (!syntaxSet.has(i)) {
      originalToClean.set(i, cleanChars.length);
      cleanChars.push(md[i]);
    }
  }
  const cleanText = cleanChars.join("");

  // Step 3: find spans in original text
  const spans = findSpans(md);

  // Step 4: map span content ranges to clean positions
  const styleEntries = [];
  for (const sp of spans) {
    const mapped = mapRangeToClean(sp.contentStart, sp.contentEnd, originalToClean);
    if (mapped && mapped.len > 0) {
      styleEntries.push({ start: mapped.start, len: mapped.len, st: sp.style });
    }
  }

  // Step 5: merge adjacent same-style entries
  styleEntries.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const e of styleEntries) {
    const last = merged[merged.length - 1];
    if (last && last.st === e.st && last.start + last.len === e.start) {
      last.len += e.len;
    } else {
      merged.push({ ...e });
    }
  }

  return { text: cleanText, styles: merged };
}

/**
 * Simple stripper (used as fallback).
 */
function stripMarkdown(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(^|\n)#\s/g, "$1");
}

// ── Tests ────────────────────────────────────────────────────────────────
function runTests() {
  const tests = [
    {
      name: "bold",
      input: "Hello **world**!",
      expect: { text: "Hello world!", styles: [{ start: 6, len: 5, st: "b" }] },
    },
    {
      name: "italic",
      input: "Hello *world*!",
      expect: { text: "Hello world!", styles: [{ start: 6, len: 5, st: "i" }] },
    },
    {
      name: "mixed",
      input: "**Bold** and *italic*",
      expect: {
        text: "Bold and italic",
        styles: [
          { start: 0, len: 4, st: "b" },
          { start: 9, len: 6, st: "i" },
        ],
      },
    },
    {
      name: "heading + bold",
      input: "# Top 5 AI\n**Claude** and **Cursor**",
      expect: {
        text: "Top 5 AI\nClaude and Cursor",
        styles: [
          { start: 0, len: 8, st: "f_18" },
          { start: 9, len: 6, st: "b" },
          { start: 20, len: 6, st: "b" },
        ],
      },
    },
    {
      name: "strike + underline",
      input: "~~strike~~ and __underline__",
      expect: {
        text: "strike and underline",
        styles: [
          { start: 0, len: 6, st: "s" },
          { start: 11, len: 9, st: "u" },
        ],
      },
    },
    {
      name: "no markdown",
      input: "plain text",
      expect: { text: "plain text", styles: [] },
    },
    {
      name: "emoji test",
      input: "🔥 **bold** 🦞",
      expect: { text: "🔥 bold 🦞", styles: [{ start: 4, len: 4, st: "b" }] },
    },
  ];

  let passed = 0;
  for (const t of tests) {
    const result = markdownToZalo(t.input);
    const ok =
      result.text === t.expect.text &&
      JSON.stringify(result.styles) === JSON.stringify(t.expect.styles);
    if (ok) {
      passed++;
    } else {
      console.log(`FAIL: ${t.name}`);
      console.log(`  input:  ${JSON.stringify(t.input)}`);
      console.log(`  got:    ${JSON.stringify(result)}`);
      console.log(`  expect: ${JSON.stringify(t.expect)}`);
    }
  }
  console.log(`Tests: ${passed}/${tests.length} passed`);
}

if (process.argv[1] && process.argv[1].includes("markdownToZalo")) {
  runTests();
}

export { markdownToZalo, TextStyle, jsStrLen, stripMarkdown };
