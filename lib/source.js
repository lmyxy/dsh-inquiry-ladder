// Normalise whatever the caller handed us into one bounded piece of text.
// The engine never reads the filesystem later, so everything it needs to quote
// must already be in the stored source.
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}

export function expandPath(input, cwd) {
  let value = String(input).trim().replace(/^"(.*)"$/u, '$1');
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(1));
  }
  return path.isAbsolute(value) ? value : path.resolve(cwd ?? process.cwd(), value);
}

function titleFromText(text, fallback) {
  const lines = String(text).split(/\r?\n/u);
  for (const line of lines) {
    const candidate = line.trim().replace(/^#+\s*/u, '');
    if (candidate.length >= 4) return candidate.slice(0, 120);
  }
  return fallback;
}

/**
 * Resolve the tool arguments into `{ kind, title, text, truncated, note }`.
 * `args.text` wins; otherwise `args.path` (text-like files only) or `args.url`.
 */
export async function normalizeSource(args, { cwd, maxChars, web, signal } = {}) {
  const limit = Number.isFinite(maxChars) && maxChars > 4000 ? Math.floor(maxChars) : 48000;

  const clip = (text, kind, title) => {
    const raw = String(text ?? '').replace(/\r\n/gu, '\n').trim();
    if (raw.length < 200) {
      throw new SourceError('SOURCE_TOO_SHORT', `内容只有 ${raw.length} 个字符，不足以追问。请给出至少一段完整的论证。`);
    }
    const truncated = raw.length > limit;
    return {
      kind,
      title: title || titleFromText(raw, '(无标题内容)'),
      text: truncated ? raw.slice(0, limit) : raw,
      chars: Math.min(raw.length, limit),
      truncated,
      note: truncated ? `原文 ${raw.length} 字符，只保留了前 ${limit} 字符用于追问。` : '',
    };
  };

  if (typeof args.text === 'string' && args.text.trim() !== '') {
    return clip(args.text, 'text', String(args.title ?? '').trim());
  }

  if (typeof args.path === 'string' && args.path.trim() !== '') {
    const filePath = expandPath(args.path, cwd);
    if (/\.pdf$/iu.test(filePath)) {
      throw new SourceError(
        'PDF_NOT_READ_HERE',
        `这是 PDF：${filePath}。本插件不解析 PDF——先用 paper_brief（paper-miner）拿到论证骨架，再把文本作为 text 传给 inquiry_open。这样既省 token，也保证追问引用的是原文句子。`,
      );
    }
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      throw new SourceError('SOURCE_UNREADABLE', `读不到 ${filePath}：${String(error?.message ?? error)}`);
    }
    return clip(raw, 'path', String(args.title ?? '').trim() || path.basename(filePath));
  }

  if (typeof args.url === 'string' && args.url.trim() !== '') {
    const url = args.url.trim();
    if (web === undefined || typeof web.fetch !== 'function') {
      throw new SourceError('URL_UNAVAILABLE', '这个 profile 没有可用的 web 服务。请把正文抓下来放进 text 参数。');
    }
    let page;
    try {
      page = await web.fetch({ url }, signal);
    } catch (error) {
      throw new SourceError('URL_FETCH_FAILED', `抓取失败：${String(error?.message ?? error)}。请把正文放进 text 参数。`);
    }
    const text = page?.text ?? page?.content ?? page?.body ?? page?.markdown;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new SourceError('URL_EMPTY', '抓到的页面没有可读正文。请把正文放进 text 参数。');
    }
    return clip(text, 'url', String(args.title ?? '').trim() || url);
  }

  throw new SourceError('SOURCE_MISSING', '需要 text、path 或 url 之一。');
}
