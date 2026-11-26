// Ledger persistence. The session log holds what the model saw (the bounded
// layer summaries); this directory is the engine's resume cache, exactly like
// paper-miner's extraction cache.
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';

export class StateError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'StateError';
    this.code = code;
    this.hint = hint;
  }
}

export function ledgerRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'inquiry');
}

const ID_PATTERN = /^inq_[a-z0-9_]{6,64}$/u;

export function isInquiryId(value) {
  return ID_PATTERN.test(String(value ?? '').trim());
}

export function newInquiryId(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const tail = Math.random().toString(36).slice(2, 6);
  return `inq_${stamp}_${tail}`;
}

function dirOf(id) {
  if (!isInquiryId(id)) {
    throw new StateError('BAD_INQUIRY_ID', `inquiry_id 不合法：${String(id)}`, '用 inquiry_open 返回的 id。');
  }
  return path.join(ledgerRoot(), id);
}

export async function writeState(state) {
  const dir = dirOf(state.id);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, 'state.json');
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  await rename(temp, target);
  return target;
}

export async function readState(id) {
  const dir = dirOf(id);
  try {
    const raw = await readFile(path.join(dir, 'state.json'), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new StateError(
        'INQUIRY_NOT_FOUND',
        `找不到追问记录 ${id}。`,
        '记录放在 ~/.dsh/inquiry 下；如果换机器或清过缓存，需要重新 inquiry_open。',
      );
    }
    throw error;
  }
}

export async function writeSource(id, text) {
  const dir = dirOf(id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'source.txt'), String(text ?? ''), 'utf8');
}

export async function listStates(limit = 20) {
  const root = ledgerRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isInquiryId(entry.name)) continue;
    const file = path.join(root, entry.name, 'state.json');
    try {
      const info = await stat(file);
      const raw = await readFile(file, 'utf8');
      const state = JSON.parse(raw);
      rows.push({
        id: entry.name,
        title: state?.brief?.title ?? '',
        layers: state?.layers?.length ?? 0,
        status: state?.status ?? 'open',
        updatedAt: info.mtime.toISOString(),
      });
    } catch {
      // skip a broken ledger entry rather than fail the listing
    }
  }
  rows.sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
  return rows.slice(0, Math.max(1, limit));
}
