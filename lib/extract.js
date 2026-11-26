// Turn one input file into plain text. Everything that is not plain text goes
// through a dependency-free path: OOXML and EPUB are ZIP + XML, HTML is tag
// stripping. PDF is the one format that needs a real parser, so it is delegated
// to whatever extractor this machine has (pdftotext, then python + pypdf) and the
// failure is actionable rather than silent.
import os from 'node:os';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { openZip } from './zip.js';

export class ExtractError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
    this.hint = hint;
  }
}

const PLAIN = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '.rst', '.org', '.log', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.tex', '.bib', '.srt', '.vtt']);
const MARKUP = new Set(['.html', '.htm', '.xhtml']);
const ZIPPY = new Set(['.docx', '.pptx', '.epub']);
const LEGACY = { '.doc': 'Word 97-2003', '.ppt': 'PowerPoint 97-2003', '.xls': 'Excel 97-2003', '.pages': 'Pages', '.key': 'Keynote' };

/** Approximate: is this buffer binary rather than text? */
function looksBinary(buffer) {
  const sample = buffer.subarray(0, 4096);
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** HTML / XHTML / EPUB chapter to readable text, keeping block boundaries. */
export function htmlToText(html) {
  const withoutCode = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ');
  const withBreaks = withoutCode
    .replace(/<\/(?:p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|figure|figcaption)>/giu, '\n')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/t[dh]>/giu, '\t');
  const stripped = withBreaks.replace(/<[^>]+>/gu, ' ');
  return decodeEntities(stripped)
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

/** WordprocessingML to Markdown-ish text, keeping headings and list marks. */
export function docxToText(xml) {
  const lines = [];
  for (const paragraph of String(xml ?? '').split(/<\/w:p>/u)) {
    const style = /<w:pStyle[^>]*w:val="(?:Heading|heading|Kapitel|Titre)(\d)"/u.exec(paragraph);
    const text = paragraph
      .replace(/<w:tab\s*\/>/gu, '\t')
      .replace(/<w:br\s*\/>/gu, '\n')
      .replace(/<w:cr\s*\/>/gu, '\n')
      .replace(/<[^>]+>/gu, '');
    const line = decodeEntities(text).trim();
    if (line === '') continue;
    lines.push(style ? `${'#'.repeat(Math.min(Number(style[1]), 6))} ${line}` : line);
  }
  return lines.join('\n');
}

/** PresentationML: one block per slide, one line per paragraph. */
export function pptxSlidesToText(slides) {
  const blocks = [];
  for (const { index, xml } of slides) {
    const paragraphs = String(xml ?? '')
      .split(/<\/a:p>/u)
      .map((paragraph) => decodeEntities(paragraph.replace(/<[^>]+>/gu, '')).trim())
      .filter(Boolean);
    if (paragraphs.length === 0) continue;
    blocks.push(`## Slide ${index}\n${paragraphs.join('\n')}`);
  }
  return blocks.join('\n\n');
}

function run(cmd, args, { signal, timeout = 120000, maxBuffer = 128 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { signal, timeout, maxBuffer, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = typeof stderr === 'string' ? stderr : '';
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function expandHome(value) {
  const text = String(value ?? '').trim();
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(1));
  return text;
}

const HOME = os.homedir();
const WIN = process.platform === 'win32';

/** Candidate pdftotext locations, most specific first. */
function pdftotextCandidates(configured) {
  const list = [];
  if (configured) list.push(expandHome(configured));
  list.push('pdftotext');
  if (WIN) {
    list.push('D:/app/texlive/2024/bin/windows/pdftotext.exe');
    list.push('C:/texlive/2024/bin/windows/pdftotext.exe');
    list.push(path.join(HOME, 'AppData/Local/Programs/MiKTeX/miktex/bin/x64/pdftotext.exe'));
    list.push('C:/Program Files/poppler/bin/pdftotext.exe');
    list.push('C:/Program Files/poppler/Library/bin/pdftotext.exe');
    list.push('C:/ProgramData/chocolatey/bin/pdftotext.exe');
  } else {
    list.push('/usr/bin/pdftotext');
    list.push('/usr/local/bin/pdftotext');
    list.push('/opt/homebrew/bin/pdftotext');
  }
  return list;
}

function pythonCandidates(configured) {
  const list = [];
  if (configured) list.push(expandHome(configured));
  list.push('python', 'python3', 'py');
  if (WIN) {
    list.push('D:/anaconda3/python.exe');
    list.push(path.join(HOME, 'anaconda3/python.exe'));
    list.push(path.join(HOME, 'miniconda3/python.exe'));
    list.push('C:/anaconda3/python.exe');
  } else {
    list.push('/usr/bin/python3', '/usr/local/bin/python3');
  }
  return list;
}

const PYPDF_SCRIPT = `import sys
try:
    from pypdf import PdfReader
except Exception:
    try:
        from PyPDF2 import PdfReader
    except Exception:
        sys.stderr.write('NOPYPDF')
        raise SystemExit(3)
reader = PdfReader(sys.argv[1])
pages = []
for page in reader.pages:
    try:
        pages.append(page.extract_text() or '')
    except Exception:
        pages.append('')
sys.stdout.write('\\n\\n'.join(pages))`;

let backendPromise;

/** Resolve (once) which PDF extractor this machine has. */
export async function resolvePdfBackend(settings = {}) {
  if (backendPromise === undefined) {
    backendPromise = (async () => {
      const configuredTool = typeof settings.pdfTool === 'string' ? settings.pdfTool.trim() : '';
      for (const candidate of pdftotextCandidates(configuredTool)) {
        if (candidate.includes('/') || candidate.includes('\\')) {
          if (await exists(candidate)) return { kind: 'pdftotext', command: candidate };
          continue;
        }
        try {
          await run(candidate, ['-v'], { timeout: 15000 });
          return { kind: 'pdftotext', command: candidate };
        } catch (error) {
          // `pdftotext -v` writes to stderr and exits non-zero on some builds, so
          // a well-formed version banner still means the binary works.
          if (typeof error?.stderr === 'string' && /pdftotext|poppler/iu.test(error.stderr)) {
            return { kind: 'pdftotext', command: candidate };
          }
        }
      }
      const configuredPython = typeof settings.pythonPath === 'string' ? settings.pythonPath.trim() : '';
      for (const candidate of pythonCandidates(configuredPython)) {
        if (candidate.includes('/') || candidate.includes('\\')) {
          if (!(await exists(candidate))) continue;
        }
        try {
          await run(candidate, ['-c', 'import sys; sys.exit(0)'], { timeout: 15000 });
        } catch {
          continue;
        }
        try {
          await run(candidate, ['-c', 'import pypdf'], { timeout: 20000 });
          return { kind: 'pypdf', command: candidate };
        } catch {
          try {
            await run(candidate, ['-c', 'import PyPDF2'], { timeout: 20000 });
            return { kind: 'pypdf', command: candidate };
          } catch {
            // keep looking: another interpreter may have pypdf installed
          }
        }
      }
      return undefined;
    })();
  }
  return backendPromise;
}

async function pdfToText(filePath, { settings, signal }) {
  const backend = await resolvePdfBackend(settings);
  if (backend === undefined) {
    throw new ExtractError(
      'PDF_NO_BACKEND',
      '这台机器上没有可用的 PDF 文本提取器。',
      [
        '三选一：',
        '1) 在插件配置里指定 pdfTool（pdftotext 的绝对路径）或 pythonPath（装了 pypdf 的解释器）；',
        '2) 先用 ops_read_pdf 读页、把文本作为 text 传入；',
        '3) 先用 paper_brief（paper-miner）把论文压成论证骨架，再作为 text 传入。',
      ].join('\n'),
    );
  }

  let text;
  try {
    if (backend.kind === 'pdftotext') {
      text = await run(backend.command, ['-layout', '-enc', 'UTF-8', '-q', filePath, '-'], { signal, timeout: 180000 });
    } else {
      text = await run(backend.command, ['-c', PYPDF_SCRIPT, filePath], {
        signal,
        timeout: 180000,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ExtractError('PDF_EXTRACT_FAILED', `PDF 提取失败（${backend.kind}）：${String(error?.stderr || error?.message || error).slice(0, 300)}`);
  }

  const cleaned = String(text ?? '').replace(/\u0000/gu, '').replace(/[ \t]+\n/gu, '\n').replace(/\n{4,}/gu, '\n\n\n').trim();
  const readable = cleaned.replace(/\s/gu, '').length;
  if (readable < 200) {
    throw new ExtractError(
      'PDF_EMPTY_TEXT',
      `PDF 里几乎没有可提取的文字（${readable} 个非空白字符）。`,
      '可能是扫描件或纯图片 PDF。用 OCR 转成文本，或直接提供正文。',
    );
  }
  return { text: cleaned, engine: backend.kind };
}

function zipEntryTitle(name) {
  return name.split('/').pop() ?? name;
}

/**
 * Extract one file to text.
 * @returns `{ text, format, engine, note }`
 */
export async function extractText(filePath, { settings = {}, signal } = {}) {
  const extension = path.extname(filePath).toLowerCase();

  if (!(await exists(filePath))) {
    throw new ExtractError('FILE_NOT_FOUND', `找不到文件：${filePath}`, '检查路径（相对于会话工作目录），或改用 text 直接给正文。');
  }

  if (LEGACY[extension] !== undefined) {
    throw new ExtractError(
      'LEGACY_OFFICE',
      `不支持 ${LEGACY[extension]} 的老二进制格式：${path.basename(filePath)}`,
      '用它另存为 .docx / .pptx 再传入；或把正文复制出来作为 text 传入。',
    );
  }

  if (extension === '.pdf') {
    const { text, engine } = await pdfToText(filePath, { settings, signal });
    return { text, format: 'pdf', engine };
  }

  if (ZIPPY.has(extension)) {
    const archive = await openZip(filePath);
    if (extension === '.docx') {
      const xml = await archive.readText('word/document.xml');
      if (xml === undefined) throw new ExtractError('DOCX_NO_BODY', '这个 .docx 里没有 word/document.xml，可能不是 Word 文档。');
      const text = docxToText(xml);
      if (text.trim() === '') throw new ExtractError('DOCX_EMPTY', '这个 .docx 抽不出正文（可能全是图片或文本框）。', '把正文复制出来作为 text 传入。');
      return { text, format: 'docx' };
    }
    if (extension === '.pptx') {
      const names = await archive.match(/^ppt\/slides\/slide\d+\.xml$/u);
      if (names.length === 0) throw new ExtractError('PPTX_NO_SLIDES', '这个 .pptx 里没有幻灯片内容。');
      const ordered = names
        .map((name) => ({ name, index: Number(/(\d+)\.xml$/u.exec(name)?.[1] ?? 0) }))
        .sort((left, right) => left.index - right.index);
      const slides = [];
      for (const slide of ordered) slides.push({ index: slide.index, xml: await archive.readText(slide.name) });
      const text = pptxSlidesToText(slides);
      if (text.trim() === '') throw new ExtractError('PPTX_EMPTY', '这个 .pptx 抽不出文字。', '把大纲复制出来作为 text 传入。');
      return { text, format: 'pptx' };
    }
    // EPUB: read the spine order when the OPF is present, otherwise every chapter.
    const chapters = await archive.match(/\.x?html?$/iu);
    if (chapters.length === 0) throw new ExtractError('EPUB_NO_CHAPTERS', '这个 .epub 里没有 HTML 章节。');
    chapters.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const parts = [];
    for (const chapter of chapters) {
      const html = await archive.readText(chapter);
      if (html === undefined) continue;
      const text = htmlToText(html);
      if (text !== '') parts.push(text);
    }
    const text = parts.join('\n\n');
    if (text.trim() === '') throw new ExtractError('EPUB_EMPTY', '这个 .epub 抽不出文字。');
    return { text, format: 'epub', note: `按文件名顺序拼接了 ${chapters.length} 个章节` };
  }

  const buffer = await readFile(filePath);
  if (looksBinary(buffer)) {
    throw new ExtractError(
      'BINARY_UNSUPPORTED',
      `这个文件看起来是二进制，不是可读文本：${path.basename(filePath)}`,
      '支持 md / txt / html / docx / pptx / epub / pdf；其它二进制格式请先转成文本。',
    );
  }
  const raw = buffer.toString('utf8').replace(/^\uFEFF/u, '');

  if (MARKUP.has(extension)) {
    return { text: htmlToText(raw), format: extension.slice(1) };
  }
  if (PLAIN.has(extension) || extension === '') {
    return { text: raw, format: extension === '' ? 'text' : extension.slice(1) };
  }
  // Unknown extension but readable text: accept it rather than fail, and say so.
  return { text: raw, format: extension.slice(1), note: `未识别的扩展名 ${extension || '(无)'}，按纯文本读取` };
}

export { zipEntryTitle };
