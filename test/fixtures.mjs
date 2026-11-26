// Build the two binary fixtures used by the Host-side check: a real .docx and a
// minimal .pdf. Neither needs an external dependency.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const dir = path.resolve(process.argv[2] ?? '.scratch/fixtures');
await mkdir(dir, { recursive: true });

let table;
function crc32(buffer) {
  if (table === undefined) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let v = i;
      for (let b = 0; b < 8; b += 1) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
      table[i] = v;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, packed);
    const entry = Buffer.alloc(46 + nameBytes.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    nameBytes.copy(entry, 46);
    central.push(entry);
    offset += local.length + packed.length;
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

function buildPdf(lines) {
  const content = lines.map((line, index) => `BT /F1 12 Tf 72 ${720 - index * 20} Td (${line}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
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

const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Batching latency study</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">We batch up to 32 requests per server and reduce p99 latency by 40% </w:t></w:r><w:r><w:t>compared with the batch=1 baseline.</w:t></w:r></w:p>
<w:p><w:r><w:t>All runs keep the cache warm and every client enables connection reuse.</w:t></w:r></w:p>
<w:p><w:r><w:t>The ablation only compares batch=1 with batch=32 and does not report a cache-off condition.</w:t></w:r></w:p>
<w:p><w:r><w:t>We argue the gain comes from amortising queueing overhead across the batch.</w:t></w:r></w:p>
</w:body></w:document>`;

await writeFile(path.join(dir, 'batching-paper.docx'), makeZip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'word/document.xml': document,
}));

await writeFile(path.join(dir, 'batching-paper.pdf'), buildPdf([
  'Batching latency study',
  'We batch up to 32 requests per server and reduce p99 latency by 40 percent',
  'compared with the batch=1 baseline. All runs keep the cache warm and every',
  'client enables connection reuse. The ablation only compares batch=1 with',
  'batch=32 and does not report a cache-off condition.',
]));

console.log('fixtures written to', dir);
