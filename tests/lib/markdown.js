/* ============================================================
   Markdown scanning helpers.

   Everything here is fence-aware: a `](#/slug)` inside a code block
   is sample text, not a link the reader can click, and a `## ` line
   inside a shell transcript is a comment, not a heading. Getting
   this wrong in either direction makes the link and heading tests
   useless, so fences are tracked explicitly rather than regexed away.
   ============================================================ */

"use strict";

const { slugify } = require("./repo");

/* Split into lines tagged with whether they sit inside a fenced block.
   Handles ``` and ~~~ fences of any length, and the ```` ```` fences the
   README-style nested examples use. */
function scanLines(md) {
  const out = [];
  let fence = null;              // the exact opening marker, e.g. "```" or "````"
  for (const line of md.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      /* a closing fence is the same char, at least as long, and bare */
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) {
        out.push({ line, inFence: true, fenceInfo: null });
        fence = null;
        continue;
      }
      out.push({ line, inFence: true, fenceInfo: null });
      continue;
    }
    if (m) {
      fence = m[1];
      out.push({ line, inFence: true, fenceInfo: m[2].trim() });
      continue;
    }
    out.push({ line, inFence: false, fenceInfo: null });
  }
  return out;
}

/* All fenced blocks as { info, body, startLine } (1-based startLine of the
   opening fence). */
function fencedBlocks(md) {
  const blocks = [];
  let cur = null, fence = null;
  const lines = md.split("\n");
  lines.forEach((line, i) => {
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) {
        blocks.push(cur);
        cur = null; fence = null;
        return;
      }
      cur.body.push(line);
      return;
    }
    if (m) {
      fence = m[1];
      cur = { info: m[2].trim(), body: [], startLine: i + 1 };
    }
  });
  if (cur) blocks.push({ ...cur, unterminated: true });
  return blocks.map(b => ({ ...b, body: b.body.join("\n") }));
}

/* Prose text only: fences stripped. Used for link scanning. */
function proseLines(md) {
  return scanLines(md)
    .map((l, i) => ({ ...l, n: i + 1 }))
    .filter(l => !l.inFence);
}

/* ---------------- headings ---------------- */

/* What the browser's `h.textContent` would be for a markdown heading.
   marked renders inline markup to elements; textContent then flattens it
   back to bare text, so we undo the same constructs. Order matters:
   images before links, code spans before emphasis. */
function inlineText(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")     // images -> alt (dropped by textContent, but harmless)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")      // links  -> label
    .replace(/`+([^`]*)`+/g, "$1")                // code spans
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(^|\W)_([^_]+)_(\W|$)/g, "$1$2$3")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1"); // escaped punctuation
}

/* Every ATX heading outside a fence, as { level, text, n } (1-based line). */
function headings(md) {
  return scanLines(md)
    .map((l, i) => ({ ...l, n: i + 1 }))
    .filter(l => !l.inFence)
    .map(l => {
      const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l.line);
      return m ? { level: m[1].length, text: inlineText(m[2]).trim(), n: l.n } : null;
    })
    .filter(Boolean);
}

/* The heading ids the engine would mint for this chapter body.

   Both engines decorate h2/h3/h4 only, in document order, de-duplicating
   with a "-x" suffix. course.js additionally restricts to *direct children*
   of .article-body, which for authored markdown is every heading (a quiz's
   own <h3> is injected by the engine, not authored) — so the same walk
   serves both. */
function headingIds(md) {
  const used = new Set();
  const ids = new Map();          // id -> heading text
  for (const h of headings(md)) {
    if (h.level < 2 || h.level > 4) continue;
    let id = slugify(h.text);
    while (used.has(id)) id += "-x";
    used.add(id);
    ids.set(id, h.text);
  }
  return ids;
}

/* ---------------- links ---------------- */

/* Every markdown link/image target outside a fence, as
   { target, n, raw }. Reference-style links are not used in this repo;
   if one ever appears the assets test will flag its missing target. */
function links(md) {
  const out = [];
  for (const l of proseLines(md)) {
    const re = /!?\[(?:[^\]\[]|\[[^\]]*\])*\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(l.line))) out.push({ target: m[1], n: l.n, raw: m[0] });
  }
  /* html <img src> / <a href> written directly in the markdown */
  const htmlRe = /<(?:img|a|source)\b[^>]*?\s(?:src|href)="([^"]+)"/gi;
  let hm;
  for (const l of proseLines(md)) {
    htmlRe.lastIndex = 0;
    while ((hm = htmlRe.exec(l.line))) out.push({ target: hm[1], n: l.n, raw: hm[0] });
  }
  return out;
}

module.exports = { scanLines, fencedBlocks, proseLines, headings, headingIds, links, inlineText };
