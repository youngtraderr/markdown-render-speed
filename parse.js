// parse.js — a dependency-free Markdown renderer whose parse(markdown) returns the same HTML that
// marked 18.1.3 renders with its default options (GFM on, breaks off, pedantic off, async off).
// Written from scratch: a line-oriented block scanner, an inline scanner with a CommonMark
// delimiter stack, and a direct HTML writer.

/* ---------------------------------------------------------------- escaping */

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escChar = (c) => HTML_ESC[c];

const reNeedsEsc = /[&<>"']/;
const reNeedsEscNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const reEscNoEncodeAll = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape for element content and attributes. With `smart`, a bare '&' is escaped too; without it,
// an entity reference already spelled out is left alone.
function esc(str, smart) {
  if (smart) {
    if (!reNeedsEsc.test(str)) return str;
    return str.replace(/[&<>"']/g, escChar);
  }
  if (!reNeedsEscNoEncode.test(str)) return str;
  return str.replace(reEscNoEncodeAll, escChar);
}

// Numeric character references decode; named ones and stray ampersands stay as written.
const reNumRef = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const reNumRefG = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumRefs(text) {
  if (!reNumRef.test(text)) return text;
  return text.replace(reNumRefG, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

function urlEncode(href) {
  let out;
  try { out = encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
  return out;
}

const reAnyPunct = /\\([!-/:-@[-`{-~])/g;
const unescapePunct = (s) => (s.indexOf('\\') < 0 ? s : s.replace(reAnyPunct, '$1'));

/* ---------------------------------------------------------------- predicates */

const reBlankLine = /^[ \t]*$/;
const reNonSpace = /[^ ]/;
const reIsPunct = /[\p{P}\p{S}]/u;
const reAlphaNum = /[\p{L}\p{N}]/u;

const reHeading = /^ {0,3}(#{1,6})(?=\s|$)(.*)$/;
const reHr = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const reFence = /^ {0,3}(`{3,}(?=[^`\n]*$)|~{3,})(.*)$/;
const reFenceClose = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const reBlockquote = /^ {0,3}>/;
const reSetext = /^ {0,3}(=+|-+)[ \t]*$/;
const reListItem = /^( {0,3})([*+-]|(\d{1,9})([.)]))((?:[ \t]+.*)|)$/;
const reIndentCode = /^(?:(?: {0,3}\t)|(?: {4}))/;
const reDelimRow = /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)*[ \t]*:?-+:?[ \t]*\|?$/;

const HTML_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const reHtmlType1 = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i;
const reHtmlComment = /^ {0,3}<!--/;
const reHtmlPI = /^ {0,3}<\?/;
const reHtmlDecl = /^ {0,3}<![A-Za-z]/;
const reHtmlCdata = /^ {0,3}<!\[CDATA\[/;
const reHtmlTagStart = new RegExp('^ {0,3}</?(?:' + HTML_TAGS + ')(?:[ \\t]+|/?>|$)', 'i');
// A complete open or close tag alone on its line (HTML block type 7).
const reHtmlAnyTagLine = /^ {0,3}(?:<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*?\s*\/?>)[ \t]*$/;
const reHtmlBlockStart = new RegExp(
  '^ {0,3}(?:<(?:script|pre|style|textarea)(?:\\s|>|$)|<!--|<\\?|<![A-Za-z]|<!\\[CDATA\\[|</?(?:' +
  HTML_TAGS + ')(?:[ \\t]+|/?>|$))', 'i');

const reHtmlInline = new RegExp(
  '^(?:<!--(?:-?>|[\\s\\S]*?-->)' +
  '|<\\?[\\s\\S]*?\\?>' +
  '|<![a-zA-Z]+\\s[\\s\\S]*?>' +
  '|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>' +
  '|</[a-zA-Z][a-zA-Z0-9-]*\\s*>' +
  '|<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s"\'=<>`]+))?)*?\\s*/?>' +
  ')');

const reDefStart = /^ {0,3}\[((?:[^\\\[\]]|\\[\s\S])+)\]:/;

/* ---------------------------------------------------------------- line helpers */

function splitLines(src) {
  const lines = [];
  let start = 0;
  for (;;) {
    const nl = src.indexOf('\n', start);
    if (nl < 0) { lines.push([start, src.length]); break; }
    lines.push([start, nl]);
    start = nl + 1;
    if (start >= src.length) break;
  }
  return lines;
}

// Drop all trailing blank lines; a single trailing newline survives when it was the only one.
function trimBlankTail(text) {
  const parts = text.split('\n');
  let end = parts.length - 1;
  while (end >= 0 && reBlankLine.test(parts[end])) end--;
  if (parts.length - end <= 2) return text;
  return parts.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function splitRow(row, width) {
  const marked = row.replace(/\|/g, (pipe, idx, str) => {
    let n = 0;
    let p = idx;
    while (--p >= 0 && str[p] === '\\') n++;
    return n % 2 === 1 ? '|' : ' |';
  });
  let cells = marked.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (width) {
    if (cells.length > width) cells = cells.slice(0, width);
    else while (cells.length < width) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

/* ---------------------------------------------------------------- block scanning */

class BlockScanner {
  constructor(src, links) {
    this.src = src;
    this.links = links;
    this.lines = splitLines(src);
  }

  line(i) { return this.src.slice(this.lines[i][0], this.lines[i][1]); }

  // Can line `i` interrupt a paragraph?
  interrupts(i) {
    const t = this.line(i);
    if (reBlankLine.test(t)) return true;
    if (reHeading.test(t)) return true;
    if (reHr.test(t)) return true;
    if (reFence.test(t)) return true;
    if (reBlockquote.test(t)) return true;
    if (reHtmlBlockStart.test(t)) return true;
    if (reListItem.test(t)) return true;
    return false;
  }

  // Does the line's content open a block that can hold lazy continuations?
  opensParagraph(t) {
    if (reBlankLine.test(t)) return false;
    if (reHeading.test(t) || reHr.test(t) || reFence.test(t)) return false;
    if (reBlockquote.test(t) || reHtmlBlockStart.test(t) || reIndentCode.test(t)) return false;
    if (reListItem.test(t)) return false;
    if (reDefStart.test(t)) return false;
    return true;
  }

  scan(i, end, out) {
    let pendingBlanks = 0;
    while (i < end) {
      const text = this.line(i);
      if (reBlankLine.test(text)) { i++; pendingBlanks++; continue; }
      if (pendingBlanks) {
        if (out.length) out.push({ type: 'space', raw: '\n'.repeat(pendingBlanks) });
        pendingBlanks = 0;
      }

      // indented code
      if (reIndentCode.test(text)) {
        const buf = [];
        let j = i;
        let lastNonBlank = i;
        while (j < end) {
          const t = this.line(j);
          if (reBlankLine.test(t)) {
            if (t.length === 0) { buf.push(''); j++; continue; }
            buf.push(t.replace(/^(?: {0,3}\t| {1,4})/, ''));
            j++;
            lastNonBlank = j;
            continue;
          }
          if (!reIndentCode.test(t)) break;
          buf.push(t.replace(/^(?: {0,3}\t| {1,4})/, ''));
          j++;
          lastNonBlank = j;
        }
        while (buf.length && buf[buf.length - 1] === '') buf.pop();
        out.push({ type: 'code', text: buf.length ? buf.join('\n') + '\n' : '', lang: null });
        i = lastNonBlank;
        continue;
      }

      // fenced code
      let m = reFence.exec(text);
      if (m) {
        const fenceChar = m[1][0];
        const fenceLen = m[1].length;
        const fenceIndentStr = /^ */.exec(text)[0];
        const indent = fenceIndentStr.length;
        const info = m[2].trim();
        const buf = [];
        let j = i + 1;
        for (; j < end; j++) {
          const t = this.line(j);
          const cm = reFenceClose.exec(t);
          if (cm && cm[1][0] === fenceChar && cm[1].length >= fenceLen) { j++; break; }
          // Remove up to as many leading spaces as the opening fence had (marked's indentCodeCompensation).
          if (indent) {
            let lead = 0;
            while (lead < t.length && lead < indent && t[lead] === ' ') lead++;
            buf.push(t.slice(lead));
          } else buf.push(t);
        }
        const lang = info ? info.split(/[ \t]/)[0].replace(reAnyPunct, '$1') : null;
        out.push({ type: 'code', text: buf.length ? buf.join('\n') + '\n' : '', lang: lang || null });
        i = j;
        continue;
      }

      // ATX heading
      m = reHeading.exec(text);
      if (m) {
        let body = m[2].trim();
        if (/#$/.test(body)) {
          let k = body.length;
          while (k > 0 && body[k - 1] === '#') k--;
          const stripped = body.slice(0, k);
          if (!stripped || /[ \t]$/.test(stripped)) body = stripped.trim();
        }
        out.push({ type: 'heading', depth: m[1].length, text: body });
        i++;
        continue;
      }

      // thematic break
      if (reHr.test(text)) { out.push({ type: 'hr' }); i++; continue; }

      // blockquote
      if (reBlockquote.test(text)) {
        const res = this.scanBlockquote(i, end);
        out.push(res.token);
        i = res.next;
        continue;
      }

      // list
      m = reListItem.exec(text);
      if (m) {
        const res = this.scanList(i, end, m);
        out.push(res.token);
        i = res.next;
        continue;
      }

      // HTML block
      if (reHtmlBlockStart.test(text) || reHtmlAnyTagLine.test(text)) {
        const res = this.scanHtml(i, end);
        if (res) { out.push(res.token); i = res.next; continue; }
      }

      // link reference definition
      if (reDefStart.test(text)) {
        const def = this.scanDef(i, end);
        if (def) {
          if (!this.links[def.tag]) this.links[def.tag] = { href: def.href, title: def.title };
          i = def.next;
          continue;
        }
      }

      // table (GFM)
      if (i + 1 < end) {
        const table = this.scanTable(i, end);
        if (table) { out.push(table.token); i = table.next; continue; }
      }

      // paragraph, possibly promoted to a setext heading
      {
        const buf = [text];
        let j = i + 1;
        let depth = 0;
        while (j < end) {
          const t = this.line(j);
          if (reBlankLine.test(t)) break;
          const sm = reSetext.exec(t);
          if (sm) { depth = sm[1][0] === '=' ? 1 : 2; break; }
          if (this.interrupts(j)) break;
          buf.push(t);
          j++;
        }
        const body = buf.join('\n');
        if (depth) {
          out.push({ type: 'heading', depth, text: body.trim() });
          i = j + 1;
        } else {
          out.push({ type: 'paragraph', text: body });
          i = j;
        }
        continue;
      }
    }
    return out;
  }

  scanBlockquote(i, end) {
    // Phase 1: collect the raw marker lines the way marked's blockquote tokenizer does — a
    // `>`-marked line always continues, and a lazy line continues while the quote is mid-paragraph.
    const rawLines = [];
    let j = i;
    let inParagraph = false;
    for (; j < end; j++) {
      const t = this.line(j);
      const isBq = reBlockquote.test(t);
      if (isBq) {
        rawLines.push(t);
        const bodyText = demarkBlockquote(t);
        inParagraph = this.opensParagraph(bodyText);
      } else if (inParagraph && !reBlankLine.test(t) && !this.interrupts(j)) {
        rawLines.push(t);
      } else break;
    }
    // Phase 2: strip markers.
    // If the block is NOT in a paragraph (meaning it contains blocks), we must treat lines as block content.
    // However, for compatibility, we just demark everything.
    const body = rawLines.map((t) => {
      if (!reBlockquote.test(t)) return t;
      return demarkBlockquote(t);
    });
    // marked rewrites setext underlines when they are inside blockquotes.
    for (let b = 1; b < body.length; b++) {
      if (reSetext.test(body[b])) body[b] = '    ' + body[b].replace(/^ {0,3}/, '');
    }
    const sub = new BlockScanner(body.join('\n'), this.links);
    const tokens = [];
    sub.scan(0, sub.lines.length, tokens);
    return { token: { type: 'blockquote', tokens }, next: j };
  }

  scanDef(i, end) {
    // marked's def rule, verbatim: label, then href (angle or bare), then an optional title that
    // must be quoted and may contain newlines, and it must be followed by a blank line or EOF.
    const parts = [this.line(i)];
    let used = 1;
    while (used < 4 && i + used < end) {
      parts.push(this.line(i + used));
      used++;
    }
    const re = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?!\n[ \t]*\n)(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
    for (let n = used; n >= 1; n--) {
      const chunk = parts.slice(0, n).join('\n') + '\n';
      const m = re.exec(chunk);
      if (!m) continue;
      const tag = normalizeLabel(m[1]);
      if (!tag) continue;
      // How many source lines the match actually covered: one per newline it consumed.
      let consumed = 0;
      for (let c = 0; c < m[0].length; c++) if (m[0][c] === '\n') consumed++;
      if (consumed < 1) consumed = 1;
      let href = m[2];
      if (href[0] === '<') href = href.slice(1, -1);
      let title = null;
      if (m[3] !== undefined) title = unescapePunct(m[3].slice(1, -1));
      return { tag, href: unescapePunct(href), title, next: i + consumed };
    }
    return null;
  }

  scanHtml(i, end) {
    const first = this.line(i);
    const lines = this.lines;
    const startOff = lines[i][0];
    // raw text span for lines [i, last]
    const endOff = (last) => {
      let k = last + 1;
      while (k < lines.length && this.line(k) === '') k++;
      return k < lines.length ? lines[k][0] : this.src.length;
    };
    const finish = (last) => ({
      token: { type: 'html', text: trimBlankTail(this.src.slice(startOff, endOff(last))) },
      next: last + 1,
    });
    const untilContains = (needle, ci) => {
      for (let j = i; j < end; j++) {
        const t = this.line(j);
        const hay = ci ? t.toLowerCase() : t;
        if (hay.indexOf(needle) >= 0) return j;
      }
      return end - 1;
    };
    const type1 = reHtmlType1.exec(first);
    if (type1) return finish(untilContains('</' + type1[1].toLowerCase() + '>', true));
    if (reHtmlComment.test(first)) return finish(untilContains('-->', false));
    if (reHtmlPI.test(first)) return finish(untilContains('?>', false));
    if (reHtmlCdata.test(first)) return finish(untilContains(']]>', false));
    if (reHtmlDecl.test(first)) return finish(untilContains('>', false));
    // types 6 and 7 end at a blank line
    let j = i;
    for (; j < end; j++) if (reBlankLine.test(this.line(j))) break;
    return finish(j - 1);
  }

  scanTable(i, end) {
    const headRow = this.line(i);
    const delim = this.line(i + 1);
    if (!reDelimRow.test(delim)) return null;
    if (!/[|:]/.test(delim)) return null;
    if (headRow.indexOf('|') < 0) return null;
    const header = splitRow(headRow, 0);
    const alignRow = delim.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    if (header.length !== alignRow.length) return null;
    const align = alignRow.map((c) => {
      const s = c.trim();
      if (/^ *-+: *$/.test(s)) return 'right';
      if (/^ *:-+: *$/.test(s)) return 'center';
      if (/^ *:-+ *$/.test(s)) return 'left';
      return null;
    });
    const rows = [];
    let j = i + 2;
    for (; j < end; j++) {
      const t = this.line(j);
      if (reBlankLine.test(t)) break;
      if (reHeading.test(t) || reHr.test(t) || reBlockquote.test(t)) break;
      if (reFence.test(t) || reIndentCode.test(t)) break;
      if (reHtmlBlockStart.test(t)) break;
      rows.push(splitRow(t, header.length));
    }
    return { token: { type: 'table', header, align, rows }, next: j };
  }

  scanList(i, end, firstMatch) {
    const ordered = firstMatch[2] !== '*' && firstMatch[2] !== '+' && firstMatch[2] !== '-';
    const markerChar = ordered ? firstMatch[4] : firstMatch[2];
    const start = ordered ? parseInt(firstMatch[3], 10) : 0;
    const items = [];
    let loose = false;
    let j = i;

    while (j < end) {
      const t = this.line(j);
      const m = reListItem.exec(t);
      if (!m) break;
      const isOrdered = m[2] !== '*' && m[2] !== '+' && m[2] !== '-';
      if (isOrdered !== ordered) break;
      if ((isOrdered ? m[4] : m[2]) !== markerChar) break;
      if (reHr.test(t)) break;

      const markerLen = m[2].length;
      const indent = m[1].length;
      const after = m[5];
      // marked: if after is empty, the item is empty (or a block).
      // If there is content, calculate padding based on tabs-to-spaces.
      const expanded = expandTabsFrom(after, indent + markerLen);
      const lead = expanded.length - expanded.replace(/^[ \t]+/, '').length;
      let pad = lead > 4 ? 1 : lead;
      if (after.trim() === '') pad = 1;
      const contentCol = indent + markerLen + pad;
      const firstLine = expanded.slice(Math.min(expanded.length, pad));

      const itemBody = [firstLine];
      let k = j + 1;
      let lastWasBlank = false;
      let innerBlank = false;
      let endedOnBlank = false;
      let prevContent = firstLine;

      for (; k < end; k++) {
        const u = this.line(k);
        const ze = expandTabsFrom(u, 0);
        const leadZ = ze.length - ze.replace(/^[ \t]+/, '').length;
        if (ze.length === 0) {
          itemBody.push('');
          lastWasBlank = true;
          prevContent = '';
          continue;
        }
        if (leadZ >= contentCol || ze.trim() === '') {
          if (lastWasBlank) innerBlank = true;
          itemBody.push(ze.slice(contentCol));
          lastWasBlank = false;
          prevContent = ze.slice(contentCol);
          continue;
        }
        if (!lastWasBlank) {
          // A line that cannot start a block continues the item's paragraph lazily.
          // marked check for block continuation: must NOT match any block rule.
          if (reListItem.test(u) || reHr.test(u) || reFence.test(u) || reHeading.test(u) ||
              reHtmlBlockStart.test(u) || reBlockquote.test(u)) {
            endedOnBlank = false;
            break;
          }
          itemBody.push(u.replace(/^ {0,3}/, ''));
          prevContent = u;
          continue;
        }
        endedOnBlank = true;
        break;
      }

      while (itemBody.length && itemBody[itemBody.length - 1] === '') itemBody.pop();
      items.push(itemBody.join('\n'));
      if (innerBlank) loose = true;
      j = k;

      if (j >= end) break;
      const nextLine = this.line(j);
      const nm = reListItem.exec(nextLine);
      if (!nm || reHr.test(nextLine)) break;
      const nOrdered = nm[2] !== '*' && nm[2] !== '+' && nm[2] !== '-';
      if (nOrdered !== ordered) break;
      if ((nOrdered ? nm[4] : nm[2]) !== markerChar) break;
      if (endedOnBlank) loose = true;
    }

    const tokens = items.map((body) => this.itemTokens(body));

    for (let idx = 0; idx < tokens.length; idx++) {
      const tm = /^\[([ xX])\][ \t]+/.exec(items[idx]);
      if (!tm) continue;
      const box = { type: 'checkbox', checked: tm[1] !== ' ' };
      const cleaned = items[idx].replace(/^\[[ xX]\][ \t]+/, '');
      const rebuilt = this.itemTokens(cleaned);
      if (rebuilt.length && (rebuilt[0].type === 'paragraph' || rebuilt[0].type === 'text')) {
        rebuilt[0].box = box;
      } else {
        rebuilt.unshift({ type: 'paragraph', text: '', box });
      }
      tokens[idx] = rebuilt;
    }

    if (loose) {
      for (const inner of tokens) {
        for (const tok of inner) if (tok.type === 'text') tok.type = 'paragraph';
      }
    }

    return { token: { type: 'list', ordered, start, loose, items: tokens }, next: j };
  }

  itemTokens(body) {
    const sub = new BlockScanner(body, this.links);
    const inner = [];
    sub.scan(0, sub.lines.length, inner);
    return inner;
  }
}

// Strip a blockquote marker and one column of following whitespace, expanding tabs by the
// marker's own width (marked's blockquoteMarkerWhitespace + J).
function demarkBlockquote(t) {
  const m = /^( {0,3}>)([ \t]+|)/.exec(t);
  if (!m) return t;
  const markerCol = m[1].length;
  const rest = t.slice(m[0].length);
  if (!m[2]) return rest;
  // Expand the whitespace run against the marker column, then drop exactly one column.
  const wsExpanded = expandTabsFrom(m[2], markerCol);
  const drop = 1;
  const remaining = wsExpanded.slice(drop);
  return remaining + rest;
}

/* ---------------------------------------------------------------- width helpers */

function indentWidth(str, base) {  let col = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - ((base + col) % 4);
    else break;
  }
  return col;
}

// Expand tabs to spaces starting from column `base` (marked's J helper).
function expandTabsFrom(str, base) {
  if (str.indexOf('\t') < 0) return str;
  let col = base;
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else { out += ch; col++; }
  }
  return out;
}

// Remove up to `cols` columns of leading whitespace; a tab that overruns leaves padding spaces.
function stripIndent(str, cols) {
  let col = 0;
  let i = 0;
  while (i < str.length && col < cols) {
    const ch = str[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w > cols) return ' '.repeat(col + w - cols) + str.slice(i + 1);
      col += w; i++;
    } else break;
  }
  return str.slice(i);
}

/* ---------------------------------------------------------------- inline scanning */

const reEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/;
const reAutolinkUrl = /^<[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*>/;
const reAutolinkEmail = /^<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+>/;
const reProtocol = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP])$/;
const reEmailAddr = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const reUrlStart = /^(?:(?:(?:mailto|xmpp):[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?:\/[A-Za-z0-9@.]+)?)|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/[^\s<]*|www\.[^\s<]*|[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/;
const reUrlBackpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// The matching ']' for the '[' at `open`, honouring escapes, nesting and code spans.
function findCloseBracket(s, open) {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      let n = 0;
      while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      const close = s.indexOf(fence, i + n);
      if (close >= 0) { i = close + n; continue; }
      i += n;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

class InlineScanner {
  constructor(src, links) {
    this.src = src;
    this.links = links;
    this.pos = 0;
  }

  run() {
    const src = this.src;
    const nodes = [];
    let buf = '';
    const flush = () => {
      if (buf) { nodes.push({ type: 'text', text: buf }); buf = ''; }
    };

    while (this.pos < src.length) {
      const rest = src.slice(this.pos);
      const ch = rest[0];

      if (ch === '\\') {
        const m = reEscape.exec(rest);
        if (m) {
          flush();
          nodes.push({ type: 'escape', text: m[1] });
          this.pos += m[0].length;
          continue;
        }
        const hard = /^\\\n(?!\s*$)[ \t]*/.exec(rest);
        if (hard) {
          flush();
          nodes.push({ type: 'br' });
          this.pos += hard[0].length;
          continue;
        }
        buf += '\\';
        this.pos++;
        continue;
      }

      if (ch === '`') {
        const m = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest);
        if (m) {
          flush();
          let body = m[2].replace(/\n/g, ' ');
          if (/[^ ]/.test(body) && body[0] === ' ' && body[body.length - 1] === ' ') body = body.slice(1, -1);
          nodes.push({ type: 'codespan', text: body });
          this.pos += m[0].length;
          continue;
        }
        const run = /^`+/.exec(rest)[0];
        buf += run;
        this.pos += run.length;
        continue;
      }

      if (ch === '<') {
        let auto = reAutolinkUrl.exec(rest);
        const isEmail = !auto;
        if (!auto) auto = reAutolinkEmail.exec(rest);
        if (auto) {
          flush();
          const label = auto[0].slice(1, -1);
          nodes.push({
            type: 'link',
            href: isEmail ? 'mailto:' + label : label,
            title: null,
            autolink: true,
            children: [{ type: 'text', text: label }],
          });
          this.pos += auto[0].length;
          continue;
        }
        const tag = reHtmlInline.exec(rest);
        if (tag) {
          flush();
          nodes.push({ type: 'html', text: tag[0] });
          this.pos += tag[0].length;
          continue;
        }
      }

      if (ch === '!' && rest[1] === '[') {
        const link = this.tryLink(true);
        if (link) { flush(); nodes.push(link); continue; }
      }

      if (ch === '[') {
        const link = this.tryLink(false);
        if (link) { flush(); nodes.push(link); continue; }
      }

      if (ch === '*' || ch === '_') {
        let len = 0;
        while (rest[len] === ch) len++;
        const before = this.pos > 0 ? src[this.pos - 1] : '\n';
        const afterChar = src[this.pos + len];
        const beforeWs = /\s/.test(before);
        const beforePunct = reIsPunct.test(before);
        const afterWs = afterChar === undefined || /\s/.test(afterChar);
        const afterPunct = afterChar !== undefined && reIsPunct.test(afterChar);
        const leftFlank = !afterWs && (!afterPunct || beforeWs || beforePunct);
        const rightFlank = !beforeWs && (!beforePunct || afterWs || afterPunct);
        let canOpen;
        let canClose;
        if (ch === '_') {
          canOpen = leftFlank && (!rightFlank || beforePunct);
          canClose = rightFlank && (!leftFlank || afterPunct);
        } else {
          canOpen = leftFlank;
          canClose = rightFlank;
        }
        flush();
        nodes.push({ type: 'delim', ch, count: len, orig: len, canOpen, canClose });
        this.pos += len;
        continue;
      }

      if (ch === '~') {
        const node = this.tryDel();
        if (node) { flush(); nodes.push(node); continue; }
      }

      if (ch === '\n') {
        // Two or more trailing spaces (or a backslash) hard-break, unless only whitespace follows.
        const trail = /[ \t]+$/.exec(buf);
        const hardSpaces = trail !== null && trail[0].length >= 2;
        if (hardSpaces && /[^ \t\n]/.test(src.slice(this.pos + 1))) {
          buf = buf.slice(0, buf.length - trail[0].length);
          flush();
          nodes.push({ type: 'br' });
          this.pos++;
          while (src[this.pos] === ' ' || src[this.pos] === '\t') this.pos++;
          continue;
        }
        buf += '\n';
        this.pos++;
        continue;
      }

      const url = this.tryUrl(rest);
      if (url) { flush(); nodes.push(url); continue; }

      buf += ch;
      this.pos++;
    }
    flush();

    if (nodes.length > 1) processEmphasis(nodes);
    return nodes;
  }

  tryDel() {
    const src = this.src;
    const start = this.pos;
    let len = 0;
    while (src[start + len] === '~') len++;
    if (len > 2) { this.pos += len; return { type: 'text', text: '~'.repeat(len) }; }
    const before = start > 0 ? src[start - 1] : '\n';
    const afterChar = src[start + len];
    const beforeWs = /\s/.test(before);
    const beforePunct = reIsPunct.test(before);
    const afterWs = afterChar === undefined || /\s/.test(afterChar);
    const afterPunct = afterChar !== undefined && reIsPunct.test(afterChar);
    const leftFlank = !afterWs && (!afterPunct || beforeWs || beforePunct);
    const rightFlank = !beforeWs && (!beforePunct || afterWs || afterPunct);
    if (leftFlank && !rightFlank) {
      let i = start + len;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`') {
          let n = 0;
          while (src[i + n] === '`') n++;
          const fence = '`'.repeat(n);
          const close = src.indexOf(fence, i + n);
          if (close >= 0) { i = close + n; continue; }
          i += n;
          continue;
        }
        if (c !== '~') { i++; continue; }
        let n = 0;
        while (src[i + n] === '~') n++;
        const cBefore = src[i - 1];
        const cAfter = src[i + n];
        const cbWs = /\s/.test(cBefore);
        const cbPunct = reIsPunct.test(cBefore);
        const caWs = cAfter === undefined || /\s/.test(cAfter);
        const caPunct = cAfter !== undefined && reIsPunct.test(cAfter);
        const rf = !cbWs && (!cbPunct || caWs || caPunct);
        if (rf && n === len) {
          const inner = src.slice(start + len, i);
          if (!inner || /\s$/.test(inner)) { i += n; continue; }
          const children = new InlineScanner(inner, this.links).run();
          this.pos = i + n;
          return { type: 'del', children };
        }
        i += n;
      }
    }
    this.pos += len;
    return { type: 'text', text: '~'.repeat(len) };
  }

  tryUrl(rest) {
    const first = rest[0];
    if (!/[A-Za-z0-9._+-]/.test(first)) return null;
    if (this.pos > 0) {
      const prev = this.src[this.pos - 1];
      if (/[A-Za-z0-9]/.test(prev)) return null;
    }
    const m = reUrlStart.exec(rest);
    if (!m) return null;
    let raw = m[0];
    if (/^(?:mailto|xmpp):/i.test(raw)) {
      if (!reEmailAddr.test(raw)) return null;
    } else if (/^www\./i.test(raw) || /^[a-zA-Z]+:\/\//.test(raw)) {
      if (!/^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//.test(raw) && !/^www\./i.test(raw)) return null;
      let prevRaw;
      do {
        prevRaw = raw;
        const bp = reUrlBackpedal.exec(raw);
        raw = bp ? bp[0] : '';
      } while (raw !== prevRaw);
      if (!raw || raw.length < 5) return null;
    } else if (!reEmailAddr.test(raw)) {
      return null;
    }
    const label = raw;
    let href;
    if (/^(?:mailto|xmpp):/i.test(raw)) href = raw;
    else if (raw.indexOf('@') >= 0 && !/^[a-zA-Z]+:\/\//.test(raw) && !/^www\./i.test(raw)) href = 'mailto:' + raw;
    else if (/^www\./i.test(raw)) href = 'http://' + raw;
    else href = raw;
    this.pos += raw.length;
    return { type: 'link', href, title: null, autolink: true, children: [{ type: 'text', text: label }] };
  }

  tryLink(isImage) {
    const src = this.src;
    const start = this.pos;
    const open = isImage ? start + 1 : start;
    const close = findCloseBracket(src, open);
    if (close < 0) return null;
    const label = src.slice(open + 1, close);
    const after = src.slice(close + 1);

    if (after[0] === '(') {
      const dest = this.parseDest(after);
      if (dest) {
        const children = new InlineScanner(label, this.links).run();
        if (!isImage && hasLink(children)) return null;
        this.pos = close + 1 + dest.length;
        return {
          type: isImage ? 'image' : 'link', href: dest.href, title: dest.title,
          children, labelText: label,
        };
      }
    }

    let refLabel = null;
    let consumed = 0;
    const full = /^\[((?:[^\\\[\]]|\\[\s\S])*)\]/.exec(after);
    if (full) { refLabel = full[1]; consumed = full[0].length; }
    else if (after[0] === '[') { refLabel = label; consumed = 2; }
    else if (after[0] !== '(') { refLabel = label; consumed = 0; }
    if (refLabel !== null) {
      const key = normalizeLabel(refLabel === '' ? label : refLabel);
      const link = this.links[key];
      if (link) {
        const children = new InlineScanner(label, this.links).run();
        if (!isImage && hasLink(children)) return null;
        this.pos = close + 1 + consumed;
        return {
          type: isImage ? 'image' : 'link', href: link.href,
          title: link.title, children, labelText: label,
        };
      }
    }
    return null;
  }

  // "(dest 'title')" at the start of `str`; returns {href, title, length} or null.
  parseDest(str) {
    let i = skipWs(str, 1);
    let href;
    if (str[i] === '<') {
      let j = i + 1;
      let raw = '';
      let closed = false;
      while (j < str.length) {
        const c = str[j];
        if (c === '\\' && j + 1 < str.length && str[j + 1] !== '\n') { raw += str[j + 1]; j += 2; continue; }
        if (c === '>') { closed = true; break; }
        if (c === '<' || c === '\n') return null;
        raw += c;
        j++;
      }
      if (!closed) return null;
      href = raw;
      i = j + 1;
    } else {
      let depth = 0;
      const from = i;
      while (i < str.length) {
        const c = str[i];
        if (c === '\\' && i + 1 < str.length) { i += 2; continue; }
        if (c === '(') { depth++; i++; continue; }
        if (c === ')') {
          if (depth === 0) break;
          depth--; i++; continue;
        }
        if (c === ' ' || c === '\t' || c === '\n') break;
        i++;
      }
      href = str.slice(from, i);
    }
    let j = skipWs(str, i);
    if (str[j] === '"' || str[j] === "'" || str[j] === '(') {
      const openCh = str[j];
      const closeCh = openCh === '(' ? ')' : openCh;
      let k = j + 1;
      let raw = '';
      let closed = false;
      while (k < str.length) {
        const c = str[k];
        if (c === '\\' && k + 1 < str.length) { raw += str[k + 1]; k += 2; continue; }
        if (c === closeCh) { closed = true; break; }
        if (openCh === '(' && c === '(') return null;
        raw += c;
        k++;
      }
      if (!closed) return null;
      const after = skipWs(str, k + 1);
      if (str[after] !== ')') return null;
      return { href: unescapePunct(href), title: raw, length: after + 1 };
    }
    if (str[j] !== ')') return null;
    return { href: unescapePunct(href), title: null, length: j + 1 };
  }
}

function skipWs(str, i) {
  while (i < str.length && (str[i] === ' ' || str[i] === '\t')) i++;
  if (str[i] === '\n') {
    i++;
    while (i < str.length && (str[i] === ' ' || str[i] === '\t')) i++;
  }
  return i;
}

function hasLink(nodes) {
  for (const n of nodes) {
    if (n.type === 'link') return true;
    if (n.children && hasLink(n.children)) return true;
  }
  return false;
}

// CommonMark's delimiter-stack emphasis over a flat node list, applied recursively to children.
function processEmphasis(nodes) {
  let ci = 0;
  while (ci < nodes.length) {
    const closer = nodes[ci];
    if (closer.type !== 'delim' || !closer.canClose || closer.count === 0) { ci++; continue; }
    const ch = closer.ch;
    let oi = -1;
    for (let k = ci - 1; k >= 0; k--) {
      const cand = nodes[k];
      if (cand.type !== 'delim' || cand.ch !== ch || !cand.canOpen || cand.count === 0) continue;
      const sum = cand.count + closer.count;
      if ((cand.canClose || closer.canOpen) && sum % 3 === 0 && (cand.count % 3 !== 0 || closer.count % 3 !== 0)) continue;
      oi = k;
      break;
    }
    if (oi < 0) { ci++; continue; }
    const opener = nodes[oi];
    const use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    opener.count -= use;
    closer.count -= use;
    const inner = nodes.splice(oi + 1, ci - oi - 1);
    processEmphasis(inner);
    nodes.splice(oi + 1, 0, { type: use === 2 ? 'strong' : 'em', children: inner });
    ci = oi + 2;
    if (opener.count === 0) { nodes.splice(oi, 1); ci--; }
    if (closer.count === 0) nodes.splice(ci, 1);
  }
  for (let k = nodes.length - 1; k >= 0; k--) {
    if (nodes[k].type === 'delim') delimToText(nodes, k);
  }
}

function delimToText(nodes, k) {
  const n = nodes[k];
  if (k > 0 && nodes[k - 1].type === 'text') {
    nodes[k - 1].text += n.ch.repeat(n.count);
    nodes.splice(k, 1);
  } else {
    nodes[k] = { type: 'text', text: n.ch.repeat(n.count) };
  }
}

/* ---------------------------------------------------------------- rendering */

function renderInline(nodes, forAlt) {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const tok = nodes[i];
    switch (tok.type) {
      case 'text': out += forAlt ? tok.text : esc(decodeNumRefs(tok.text), false); break;
      case 'escape': out += forAlt ? tok.text : esc(tok.text, false); break;
      case 'html': out += forAlt ? '' : tok.text; break;
      case 'codespan': out += forAlt ? tok.text : '<code>' + esc(tok.text, true) + '</code>'; break;
      case 'br': out += forAlt ? '' : '<br>'; break;
      case 'em':
        out += forAlt ? renderInline(tok.children, true) : '<em>' + renderInline(tok.children, false) + '</em>';
        break;
      case 'strong':
        out += forAlt ? renderInline(tok.children, true) : '<strong>' + renderInline(tok.children, false) + '</strong>';
        break;
      case 'del':
        out += forAlt ? renderInline(tok.children, true) : '<del>' + renderInline(tok.children, false) + '</del>';
        break;
      case 'checkbox': out += forAlt ? '' : checkboxHtml(tok); break;
      case 'link': {
        const inner = renderInline(tok.children, forAlt);
        if (forAlt) { out += inner; break; }
        const href = urlEncode(tok.href);
        if (href === null) { out += inner; break; }
        let html = '<a href="' + esc(href, tok.autolink === true) + '"';
        if (tok.title) html += ' title="' + esc(tok.title, false) + '"';
        out += html + '>' + inner + '</a>';
        break;
      }
      case 'image': {
        const alt = renderInline(tok.children, true);
        if (forAlt) { out += alt; break; }
        const src = urlEncode(tok.href);
        if (src === null) { out += esc(alt, false); break; }
        let html = '<img src="' + esc(src, true) + '" alt="' + esc(alt, false) + '"';
        if (tok.title) html += ' title="' + esc(tok.title, false) + '"';
        out += html + '>';
        break;
      }
      default: break;
    }
  }
  return out;
}

function checkboxHtml(tok) {
  return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderBlocks(tokens, links, tight) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'paragraph': {
        const body = (tok.box ? checkboxHtml(tok.box) : '') + inlineHtml(tok.text, links);
        out += tight ? body : '<p>' + body + '</p>\n';
        break;
      }
      case 'text': out += inlineHtml(tok.text, links); break;
      case 'heading':
        out += '<h' + tok.depth + '>' + inlineHtml(tok.text, links) + '</h' + tok.depth + '>\n';
        break;
      case 'hr': out += '<hr>\n'; break;
      case 'code': {
        const lang = tok.lang ? tok.lang.match(/^[^ \t]*/)[0] : '';
        const body = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        out += lang
          ? '<pre><code class="language-' + esc(lang, false) + '">' + esc(body, true) + '</code></pre>\n'
          : '<pre><code>' + esc(body, true) + '</code></pre>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(tok.tokens, links, false) + '</blockquote>\n';
        break;
      case 'html': out += tok.text; break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        out += '<' + tag + (tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '') + '>\n';
        for (const item of tok.items) out += '<li>' + renderBlocks(item, links, !tok.loose) + '</li>\n';
        out += '</' + tag + '>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < tok.header.length; c++) {
          const a = tok.align[c] ? ' align="' + tok.align[c] + '"' : '';
          out += '<th' + a + '>' + inlineHtml(tok.header[c], links) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (tok.rows.length) {
          out += '<tbody>';
          for (const row of tok.rows) {
            out += '<tr>\n';
            for (let c = 0; c < row.length; c++) {
              const a = tok.align[c] ? ' align="' + tok.align[c] + '"' : '';
              out += '<td' + a + '>' + inlineHtml(row[c], links) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
      default: break;
    }
  }
  return out;
}

function inlineHtml(src, links) {
  if (src === '') return '';
  return renderInline(new InlineScanner(src, links).run(), false);
}

/* ---------------------------------------------------------------- entry point */

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  if (src === '') return '';
  const links = Object.create(null);
  const scanner = new BlockScanner(src, links);
  const tokens = [];
  scanner.scan(0, scanner.lines.length, tokens);
  return renderBlocks(tokens, links, false);
}

export default parse;
