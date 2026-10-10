import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';

// The from-disk sample's PDF writer (examples/from-disk/documents/report/pdf.js), which the report stores in its file
// and runs in the viewer's sandbox to save itself as a PDF.
await import('../examples/from-disk/documents/report/pdf.js');
const { MiniPdf } = globalThis;

const bytesOf = async (pdf) => Buffer.from(await (await pdf.blob()).arrayBuffer());
/** Each page's drawing, inflated. */
const streams = (bytes) => [...bytes.toString('latin1').matchAll(/<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g)]
  .map((m) => zlib.inflateSync(bytes.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1]))).toString('latin1'));

test('sample PDF writer: a well-formed file whose cross-reference table points at every object', async () => {
  const pdf = new MiniPdf({ title: 'Sales report – 2026' });
  pdf.text(40, 60, 'Harbour & Co.', { size: 14, bold: true, color: '#2456c9' });
  pdf.rect(40, 80, 200, 50, { fill: '#f4f6fa', stroke: '#e1e5ec', radius: 8 }).rect(40, 140, 10, 10, { fill: '#000' });
  pdf.line(40, 160, 555, 160);
  pdf.addPage().text(40, 60, 'Second page');
  const bytes = await bytesOf(pdf);
  const file = bytes.toString('latin1');
  assert.ok(file.startsWith('%PDF-1.4\n'));
  const xref = Number(file.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
  assert.ok(file.startsWith('xref\n0 10\n', xref));
  const offsets = file.slice(xref).split('\n').filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
  assert.equal(offsets.length, 9); // catalog, pages, two fonts, info, and two pages with a drawing each
  offsets.forEach((offset, i) => assert.ok(file.startsWith(`${i + 1} 0 obj\n`, offset), `object ${i + 1}`));
  assert.match(file, /\/Kids \[6 0 R 8 0 R\] \/Count 2/);
  assert.match(file, /\/MediaBox \[0 0 595\.28 841\.89\]/);
  // The title in UTF-16, so any character shows in a PDF reader's window.
  const utf16 = Array.from('Sales report – 2026', (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  assert.ok(file.includes(`/Title <feff${utf16}>`));

  const [first, second] = streams(bytes);
  // Text: colour, the bold font, size, position from the bottom left, the characters in hex.
  assert.match(first, /^BT 0\.14 0\.34 0\.79 rg \/F2 14 Tf 40 781\.89 Td <486172626f7572202620436f2e> Tj ET$/m);
  assert.match(first, / c h B$/m); // the rounded box, filled and outlined
  assert.match(first, /^0 0 0 rg 40 691\.89 10 10 re f$/m); // the square one, filled
  assert.match(first, /^0 0 0 RG 1 w 40 681\.89 m 555 681\.89 l S$/m);
  assert.match(second, /<5365636f6e642070616765> Tj/);
});

test('sample PDF writer: WinAnsi characters, Helvetica widths, right-aligned text', async () => {
  const pdf = new MiniPdf();
  assert.equal(pdf.textWidth('R 1,000', 10), 35.02); // 722 + 278 + 556 + 278 + 3 × 556 thousandths, at 10 points
  assert.equal((pdf.textWidth('i', 10, true) - pdf.textWidth('i', 10)).toFixed(2), '0.56'); // bold i is wider
  pdf.text(555, 100, 'R 1,000', { align: 'right' }).text(40, 120, 'Café € – ✓');
  const [drawing] = streams(await bytesOf(pdf));
  assert.match(drawing, / 519\.98 741\.89 Td /); // 555 - 35.02
  assert.match(drawing, /<436166e920802096203f> Tj/); // é e9, € 80, – 96; ✓ has no WinAnsi character: '?'
});
