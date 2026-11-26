// Minimal ZIP reader for OOXML and EPUB containers. Dependency-free so the
// bundle resolves without installing anything: read the end-of-central-directory
// record, then inflate the entries we ask for.
import { readFile } from 'node:fs/promises';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflate = promisify(inflateRaw);

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

function findEocd(buffer) {
  const start = Math.max(0, buffer.length - 0x10000 - 22);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset;
  }
  return -1;
}

/** Read one archive's central directory and return `{ name -> entry }`. */
export function readZipDirectory(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new ZipError('ZIP_NOT_ARCHIVE', '不是有效的 ZIP 容器（找不到中央目录）。');
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new ZipError('ZIP_BROKEN_DIRECTORY', 'ZIP 中央目录损坏，无法逐条读取。');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Inflate one entry, or return it as-is when stored. */
export async function readZipEntry(buffer, entry) {
  const at = entry.localOffset;
  if (buffer.readUInt32LE(at) !== LOCAL_SIG) {
    throw new ZipError('ZIP_BROKEN_ENTRY', `ZIP 条目头损坏：${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new ZipError('ZIP_UNSUPPORTED_METHOD', `不支持的 ZIP 压缩方式 ${entry.method}（${entry.name}）。`);
  return inflate(data);
}

/** Convenience: open a file, return `{ directory, readText(name), names }`. */
export async function openZip(filePath) {
  const buffer = await readFile(filePath);
  const directory = readZipDirectory(buffer);
  return {
    names: [...directory.keys()],
    has: (name) => directory.has(name),
    async readText(name) {
      const entry = directory.get(name);
      if (entry === undefined) return undefined;
      const bytes = await readZipEntry(buffer, entry);
      return bytes.toString('utf8');
    },
    async match(pattern) {
      return [...directory.keys()].filter((name) => pattern.test(name));
    },
  };
}
