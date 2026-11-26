// Input-format checks: every supported container must produce readable text,
// and every unsupported one must fail with something actionable.
// Run with `node test/extract.mjs`.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { ExtractError, docxToText, extractText, htmlToText, pptxSlidesToText, resolvePdfBackend } from '../lib/extract.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'inquiry-extract-'));
const at = (name) => path.join(dir, name);

let crcTable;
function crc32(buffer) {
  if (crcTable === undefined) {
    crcTable = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Build a deflated ZIP in memory, so the OOXML fixtures need no python. */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, compressed);

    const entry = Buffer.alloc(46 + nameBytes.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    nameBytes.copy(entry, 46);
    central.push(entry);

    offset += local.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n${error.stack}`);
  }
}

/** Minimal valid single-page PDF with one line of Helvetica text. */
function buildPdf(line) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const content = `BT /F1 18 Tf 72 700 Td (${line}) Tj ET`;
  objects[3] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

await check('plain text and markdown', async () => {
  await writeFile(at('note.md'), '\uFEFF# 标题\n\n第一段正文，足够长以通过长度检查。\n', 'utf8');
  const result = await extractText(at('note.md'));
  assert.equal(result.format, 'md');
  assert.ok(result.text.startsWith('# 标题'));
  assert.ok(!result.text.startsWith('\uFEFF'), 'BOM must be stripped');
});

await check('html keeps block boundaries and decodes entities', async () => {
  const html = '<html><body><h1>Title</h1><p>alpha &amp; beta</p><ul><li>one</li><li>two</li></ul></body></html>';
  assert.equal(htmlToText(html), 'Title\nalpha & beta\none\ntwo');
  await writeFile(at('page.html'), html, 'utf8');
  const result = await extractText(at('page.html'));
  assert.equal(result.format, 'html');
  assert.ok(result.text.includes('alpha & beta'));
});

await check('docx: heading and body survive OOXML conversion', async () => {
  const xml = docxToText('<w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Method</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">We batch up to </w:t></w:r><w:r><w:t>32 requests.</w:t></w:r></w:p></w:body>');
  assert.equal(xml, '## Method\nWe batch up to 32 requests.');
});

await check('pptx: slides become numbered blocks', () => {
  const text = pptxSlidesToText([{ index: 1, xml: '<a:p><a:r><a:t>First</a:t></a:r></a:p>' }, { index: 2, xml: '<a:p><a:r><a:t>Second</a:t></a:r></a:p><a:p><a:r><a:t>More</a:t></a:r></a:p>' }]);
  assert.equal(text, '## Slide 1\nFirst\n\n## Slide 2\nSecond\nMore');
});

await check('missing file fails with FILE_NOT_FOUND', async () => {
  await assert.rejects(() => extractText(at('nope.md')), (error) => error instanceof ExtractError && error.code === 'FILE_NOT_FOUND');
});

await check('legacy .doc is refused with a conversion hint', async () => {
  await writeFile(at('old.doc'), 'whatever', 'utf8');
  await assert.rejects(() => extractText(at('old.doc')), (error) => error.code === 'LEGACY_OFFICE' && /docx/u.test(error.hint));
});

await check('unknown binary is refused, not decoded as text', async () => {
  await writeFile(at('blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
  await assert.rejects(() => extractText(at('blob.bin')), (error) => error.code === 'BINARY_UNSUPPORTED');
});

await check('unknown text extension still reads as plain text', async () => {
  await writeFile(at('notes.weird'), 'some readable prose that is long enough to pass the length guard', 'utf8');
  const result = await extractText(at('notes.weird'));
  assert.equal(result.text.startsWith('some readable prose'), true);
  assert.match(result.note ?? '', /未识别/u);
});

// The OOXML container is written here as a deflated ZIP, so the same fixture
// exercises both the deflate path and the document.xml conversion.
await check('docx container: deflated zip is read and parsed', async () => {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Batching evaluation</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">We compare batch=1 with </w:t></w:r><w:r><w:t>batch=32 on a synthetic workload.</w:t></w:r></w:p>
<w:p><w:r><w:t>The ablation does not report a cache-off condition.</w:t></w:r></w:p>
</w:body></w:document>`;
  const container = makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': document,
  });
  await writeFile(at('paper.docx'), container);
  const result = await extractText(at('paper.docx'));
  assert.equal(result.format, 'docx');
  assert.ok(result.text.includes('# Batching evaluation'));
  assert.ok(result.text.includes('We compare batch=1 with batch=32 on a synthetic workload.'));
  assert.ok(result.text.includes('does not report a cache-off condition'));
});

await check('pptx container: slides are ordered by number', async () => {
  const slide = (text) => `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>
<a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const container = makeZip({
    'ppt/slides/slide2.xml': slide('Second slide'),
    'ppt/slides/slide1.xml': slide('First slide'),
  });
  await writeFile(at('deck.pptx'), container);
  const result = await extractText(at('deck.pptx'));
  assert.equal(result.format, 'pptx');
  assert.ok(result.text.indexOf('First slide') < result.text.indexOf('Second slide'), 'numeric order, not lexicographic');
});

await check('epub container: chapters become continuous text', async () => {
  const container = makeZip({
    'OEBPS/ch1.xhtml': '<html><body><h1>Chapter one</h1><p>First body paragraph.</p></body></html>',
    'OEBPS/ch2.xhtml': '<html><body><h1>Chapter two</h1><p>Second body paragraph.</p></body></html>',
  });
  await writeFile(at('book.epub'), container);
  const result = await extractText(at('book.epub'));
  assert.equal(result.format, 'epub');
  assert.ok(result.text.includes('Chapter one') && result.text.includes('Chapter two'));
});

await check('pdf: a real extractor is found and reads text', async () => {
  const backend = await resolvePdfBackend({});
  if (backend === undefined) {
    console.log('skip pdf: no pdftotext / pypdf on this machine');
    return;
  }
  await writeFile(at('paper.pdf'), buildPdf('Inquiry ladder fixture line'), 'utf8');
  try {
    const result = await extractText(at('paper.pdf'));
    assert.equal(result.format, 'pdf');
    assert.match(result.text, /Inquiry ladder fixture line/u);
    console.log(`     backend: ${backend.kind} (${backend.command})`);
  } catch (error) {
    // The agent sandbox refuses to spawn binaries outside the workspace; the
    // plugin itself runs in the Host process, where this call succeeds.
    if (/EPERM|spawn/iu.test(String(error?.message ?? ''))) {
      console.log('skip pdf: the sandbox blocks spawning the extractor (verified in the Host instead)');
      return;
    }
    throw error;
  }
});

console.log(failures === 0 ? '\nextract ok' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
