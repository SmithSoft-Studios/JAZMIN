// A small PDF writer for a document's page, stored in the .jzm beside the page that uses it (no library, about 5 KB).
// It draws text in the standard Helvetica fonts, which every PDF reader has (so no font is embedded), lines and boxes,
// on as many pages as needed, and makes the file in the page: jazmin.download() then saves it, with no print dialog.
// Text uses the PDF's WinAnsi characters: Latin letters (accented ones too), digits, punctuation, €, – and —; any other
// character prints as '?'. Positions are in points (1/72 inch) from the top left of the page.
(function () {
  'use strict';
  // Glyph widths (thousandths of the font size) of characters 32 to 126, from Adobe's Helvetica font metrics.
  const REGULAR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
    556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
    833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
    556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260,
    334, 584];
  const BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556,
    333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389,
    584];
  // Characters outside Latin-1 that WinAnsi has, by code point.
  const WIN_ANSI = { 0x20ac: 0x80, 0x201a: 0x82, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94,
    0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99 };

  const encode = (text) => {
    const bytes = [];
    for (const ch of String(text)) {
      const c = ch.codePointAt(0);
      bytes.push(c >= 32 && c <= 126 ? c : c === 0xa0 ? 32 : WIN_ANSI[c] || (c >= 0xa1 && c <= 0xff ? c : 63));
    }
    return bytes;
  };
  const advance = (bytes, bold) => bytes.reduce((w, b) => w + (b >= 32 && b <= 126 ? (bold ? BOLD : REGULAR)[b - 32] : 556), 0);
  const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  const num = (v) => String(Math.round(v * 100) / 100);
  const rgb = (color) => {
    const h = color.replace('#', '');
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [0, 2, 4].map((i) => num(parseInt(full.slice(i, i + 2), 16) / 255)).join(' ');
  };

  class MiniPdf {
    /** A4 portrait unless told otherwise; the title shows in PDF readers' window and file properties. */
    constructor({ width = 595.28, height = 841.89, title = '' } = {}) {
      this.width = width;
      this.height = height;
      this.title = title;
      this.pages = [];
      this.addPage();
    }

    addPage() {
      this.ops = [];
      this.pages.push(this.ops);
      return this;
    }

    /** How wide a text is, in points. */
    textWidth(text, size = 10, bold = false) {
      return (advance(encode(text), bold) * size) / 1000;
    }

    /** Text with its baseline at y; align 'left' (x is its start), 'right' (x is its end) or 'center'. */
    text(x, y, text, { size = 10, bold = false, color = '#000', align = 'left' } = {}) {
      const bytes = encode(text);
      const w = (advance(bytes, bold) * size) / 1000;
      const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
      this.ops.push(`BT ${rgb(color)} rg /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(left)} ${num(this.height - y)} Td <${hex(bytes)}> Tj ET`);
      return this;
    }

    line(x1, y1, x2, y2, { color = '#000', width = 1 } = {}) {
      this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`);
      return this;
    }

    /** A box with its top left corner at (x, y): filled, outlined or both, with rounded corners when radius > 0. */
    rect(x, y, w, h, { fill, stroke, width = 1, radius = 0 } = {}) {
      const r = Math.min(radius, w / 2, h / 2);
      const top = this.height - y;
      const bottom = top - h;
      let path;
      if (r <= 0) {
        path = `${num(x)} ${num(bottom)} ${num(w)} ${num(h)} re`;
      } else {
        const k = r * 0.5523; // a quarter circle as a Bézier curve
        const [l, rt] = [x, x + w];
        path = [
          `${num(l + r)} ${num(bottom)} m`, `${num(rt - r)} ${num(bottom)} l`,
          `${num(rt - r + k)} ${num(bottom)} ${num(rt)} ${num(bottom + r - k)} ${num(rt)} ${num(bottom + r)} c`,
          `${num(rt)} ${num(top - r)} l`, `${num(rt)} ${num(top - r + k)} ${num(rt - r + k)} ${num(top)} ${num(rt - r)} ${num(top)} c`,
          `${num(l + r)} ${num(top)} l`, `${num(l + r - k)} ${num(top)} ${num(l)} ${num(top - r + k)} ${num(l)} ${num(top - r)} c`,
          `${num(l)} ${num(bottom + r)} l`, `${num(l)} ${num(bottom + r - k)} ${num(l + r - k)} ${num(bottom)} ${num(l + r)} ${num(bottom)} c`, 'h',
        ].join(' ');
      }
      const paint = fill && stroke ? 'B' : fill ? 'f' : 'S';
      this.ops.push(`${fill ? `${rgb(fill)} rg ` : ''}${stroke ? `${rgb(stroke)} RG ${num(width)} w ` : ''}${path} ${paint}`);
      return this;
    }

    /** The finished file, as a Blob of type application/pdf. Each page's drawing is compressed where the browser can. */
    async blob() {
      const encoder = new TextEncoder();
      const parts = [];
      const offsets = [];
      let length = 0;
      const add = (part) => {
        const bytes = typeof part === 'string' ? encoder.encode(part) : part;
        parts.push(bytes);
        length += bytes.length;
      };
      const object = (id, ...body) => {
        offsets[id] = length;
        add(`${id} 0 obj\n`);
        body.forEach(add);
        add('\nendobj\n');
      };
      const deflate = async (bytes) => (typeof CompressionStream === 'function'
        ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer())
        : null);

      add('%PDF-1.4\n');
      add(new Uint8Array([37, 226, 227, 207, 211, 10])); // a comment with high bytes: the file is binary
      const pageIds = this.pages.map((_, i) => 6 + i * 2);
      object(1, '<< /Type /Catalog /Pages 2 0 R >>');
      object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
      object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const title = Array.from({ length: this.title.length }, (_, i) => this.title.charCodeAt(i).toString(16).padStart(4, '0')).join(''); // UTF-16
      const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      object(5, `<< /Title <feff${title}> /Producer (JAZMIN document) /CreationDate (D:${now}Z) >>`);
      for (const [i, ops] of this.pages.entries()) {
        const content = encoder.encode(ops.join('\n'));
        const packed = await deflate(content);
        object(pageIds[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] `
          + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`);
        object(pageIds[i] + 1, packed ? `<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n` : `<< /Length ${content.length} >>\nstream\n`,
          packed || content, '\nendstream');
      }
      const xref = length;
      const count = pageIds.length * 2 + 6;
      add(`xref\n0 ${count}\n0000000000 65535 f \n`);
      for (let id = 1; id < count; id++) add(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
      add(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
      return new Blob(parts, { type: 'application/pdf' });
    }
  }

  (typeof window !== 'undefined' ? window : globalThis).MiniPdf = MiniPdf;
}());
