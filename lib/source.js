// Normalise whatever the caller handed us into one bounded piece of text.
// The engine never reads the filesystem later, so everything it needs to quote
// must already be in the stored source.
import os from 'node:os';
import path from 'node:path';
import { ExtractError, extractText } from './extract.js';

export class SourceError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.hint = hint;
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
 * Resolve the tool arguments into `{ kind, title, text, chars, truncated, note, format }`.
 * `args.text` wins; otherwise `args.path` (any supported document) or `args.url`.
 */
export async function normalizeSource(args, { cwd, maxChars, web, signal, settings } = {}) {
  const limit = Number.isFinite(maxChars) && maxChars > 4000 ? Math.floor(maxChars) : 48000;

  const clip = (text, kind, title, extra = {}) => {
    const raw = String(text ?? '').replace(/\r\n/gu, '\n').trim();
    if (raw.length < 200) {
      throw new SourceError(
        'SOURCE_TOO_SHORT',
        `从${kind === 'file' ? '文件' : '内容'}里只抽到 ${raw.length} 个字符，不足以追问。`,
        '确认文件不是扫描件/图片，或直接把正文作为 text 传入。',
      );
    }
    const truncated = raw.length > limit;
    return {
      kind,
      title: title || titleFromText(raw, '(无标题内容)'),
      text: truncated ? raw.slice(0, limit) : raw,
      chars: Math.min(raw.length, limit),
      truncated,
      format: extra.format ?? kind,
      engine: extra.engine,
      note: [extra.note, truncated ? `原文 ${raw.length} 字符，只保留了前 ${limit} 字符用于追问。` : ''].filter(Boolean).join('；'),
    };
  };

  if (typeof args.text === 'string' && args.text.trim() !== '') {
    return clip(args.text, 'text', String(args.title ?? '').trim(), { format: 'text' });
  }

  if (typeof args.path === 'string' && args.path.trim() !== '') {
    const filePath = expandPath(args.path, cwd);
    let extracted;
    try {
      extracted = await extractText(filePath, { settings: settings ?? {}, signal });
    } catch (error) {
      if (error instanceof ExtractError) {
        throw new SourceError(error.code, error.message, error.hint);
      }
      throw new SourceError('SOURCE_UNREADABLE', `读不了 ${filePath}：${String(error?.message ?? error)}`);
    }
    const fallbackTitle = path.basename(filePath);
    return clip(extracted.text, 'file', String(args.title ?? '').trim() || fallbackTitle, {
      format: extracted.format,
      engine: extracted.engine,
      note: extracted.note,
    });
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
    return clip(text, 'url', String(args.title ?? '').trim() || url, { format: 'url' });
  }

  throw new SourceError('SOURCE_MISSING', '需要 text、path 或 url 之一。');
}
