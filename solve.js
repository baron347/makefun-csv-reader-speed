// Fast drop-in for csv-reader 1.0.0 (make.fun): run(input) returns exactly
// csv-reader's reading of {text, header} as {columns, rows, errors}.
//
// Same policy as the reference (see the kit's vendor/csv-reader/index.js):
// a U+FEFF at the very start is dropped; a record ends at LF or CRLF and an
// empty line is no record; outside quotes a CR not followed by LF is dropped
// (stray_cr); a field opening with a quote runs to the next quote that is not
// doubled, "" inside it is one quote, CRLF/lone CR inside it reads as LF;
// what follows its closing quote up to the next comma or line break is
// appended as it stands (quote_junk when the field ends); a quote that never
// closes is a literal character and the text after it is read again as
// unquoted (unterminated_quote); a quote inside an unquoted field is a
// literal character; fields stay strings; columns is the first record when
// header is true, else null; rows are padded (short_row, fields: count) or
// cut (long_row, extra: cut fields) to the first record's width; each error
// is {code, line, row} in the order met, line the 1-based line its record
// starts on, row its index in rows (null for the header).
//
// Speed: one pass with charCodeAt, slice-based fields (a plain field costs
// one slice, no per-character concatenation), indexOf to jump to the next
// quote in quoted fields, and slow paths (parts array + join, CR/LF
// conversion) only when a field actually needs them. No state is kept
// between calls; each case is answered alone.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  // Shared result of the field readers below: {value, ended, added}.
  // `added` counts the characters the unquoted scan kept (a dropped stray
  // CR does not count); only the quote_junk check reads it.
  const U = { v: '', e: END, a: 0 };

  // A quoted segment with every CRLF and lone CR read as LF; `line` moves
  // past each one. Segments without CR or LF come back untouched.
  function convSeg(seg) {
    if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) return seg;
    let out = '';
    let s = 0;
    for (let i = 0; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      if (c === 13) {
        out += seg.slice(s, i) + '\n';
        line++;
        if (seg.charCodeAt(i + 1) === 10) i++;
        s = i + 1;
      } else if (c === 10) {
        out += seg.slice(s, i) + '\n';
        line++;
        s = i + 1;
      }
    }
    return s === 0 ? seg : out + seg.slice(s);
  }

  // Reads an unquoted field from `pos`, onto `initParts` (null, or string
  // pieces already accumulated for this field). Sets U.
  function readUnq(initParts) {
    let parts = initParts;
    let start = pos;
    let added = 0;
    for (let i = pos; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        // Comma: the record goes on.
        if (parts === null) U.v = text.slice(start, i);
        else { parts.push(text.slice(start, i)); U.v = parts.join(''); }
        U.a = added + (i - start);
        U.e = COMMA;
        pos = i + 1;
        return;
      }
      if (c === 10) {
        if (parts === null) U.v = text.slice(start, i);
        else { parts.push(text.slice(start, i)); U.v = parts.join(''); }
        U.a = added + (i - start);
        U.e = LINE_BREAK;
        pos = i + 1;
        line++;
        return;
      }
      if (c === 13) {
        if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
          if (parts === null) U.v = text.slice(start, i);
          else { parts.push(text.slice(start, i)); U.v = parts.join(''); }
          U.a = added + (i - start);
          U.e = LINE_BREAK;
          pos = i + 2;
          line++;
          return;
        }
        // A CR not followed by LF is dropped (stray_cr).
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        parts.push(text.slice(start, i));
        added += i - start;
        start = i + 1;
      }
    }
    if (parts === null) U.v = text.slice(start, n);
    else { parts.push(text.slice(start, n)); U.v = parts.join(''); }
    U.a = added + (n - start);
    U.e = END;
    pos = n;
  }

  // Reads a quoted field whose opening quote is at `pos`. Sets U.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos++;
    let parts = null;
    let segStart = pos;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnq(['"']);
        return;
      }
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote inside the field.
        const seg = convSeg(text.slice(segStart, q));
        if (parts === null) parts = [];
        parts.push(seg);
        parts.push('"');
        pos = q + 2;
        segStart = pos;
        continue;
      }
      // The closing quote.
      const seg = convSeg(text.slice(segStart, q));
      let value;
      if (parts === null) value = seg;
      else { parts.push(seg); value = parts.join(''); }
      pos = q + 1;
      if (pos >= n) {
        U.v = value;
        U.e = END;
        U.a = 0;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos++;
        U.v = value;
        U.e = COMMA;
        U.a = 0;
        return;
      }
      if (c === 10) {
        pos++;
        line++;
        U.v = value;
        U.e = LINE_BREAK;
        U.a = 0;
        return;
      }
      if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
        U.v = value;
        U.e = LINE_BREAK;
        U.a = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to
      // the next comma or line break.
      readUnq(value === '' ? null : [value]);
      if (U.a > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended;
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted();
      } else {
        quoted = false;
        readUnq(null);
      }
      fields.push(U.v);
      ended = U.e;
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
