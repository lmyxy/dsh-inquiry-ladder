// inquiry-ladder: layered Socratic inquiry over a paper or any long content.
//
// The Host runs the ladder itself — questioner, answerer, critic — so five
// layers cost the conversation roughly 2k tokens instead of 30k. Each layer's
// question is triggered by a weakness in the previous layer's answer, which is
// what makes the questioning progressive rather than a list.
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { OPERATOR_IDS, operatorById, label } from './lib/ladder.js';
import { EngineError, extractBrief, mineProblems, resolveModel, runLayer, synthesize } from './lib/engine.js';
import { SourceError, normalizeSource } from './lib/source.js';
import { StateError, newInquiryId, readState, writeSource, writeState } from './lib/state.js';
import { renderLayer, renderLayerDigest, renderProblemsText, renderReport, renderTree } from './lib/report.js';
import { params } from './lib/params.js';

export const name = 'inquiry-ladder';
export const inject = ['tools'];

const SKILL_DIR = fileURLToPath(new URL('./skills/', import.meta.url));
const DEFAULTS = {
  maxDepth: 5,
  branches: 2,
  maxCalls: 20,
  maxTokens: 150000,
  maxSourceChars: 48000,
  autoMax: 3,
  lang: 'zh',
  strictAnchors: true,
  reportDir: 'inquiry',
  roles: {},
  pdfTool: '',
  pythonPath: '',
};

const defineTool = (definition) => definition;

function settings(config) {
  const source = config ?? {};
  const clamp = (value, low, high, fallback) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), low), high) : fallback;
  const roles = source.roles !== null && typeof source.roles === 'object' ? source.roles : {};
  const pick = (role) => {
    const entry = roles[role];
    if (entry === null || typeof entry !== 'object') return undefined;
    if (typeof entry.provider !== 'string' || typeof entry.model !== 'string') return undefined;
    return {
      provider: entry.provider,
      model: entry.model,
      reasoningEffort: typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort : undefined,
    };
  };
  return {
    maxDepth: clamp(source.maxDepth, 1, 7, DEFAULTS.maxDepth),
    branches: clamp(source.branches, 1, 4, DEFAULTS.branches),
    maxCalls: clamp(source.maxCalls, 4, 120, DEFAULTS.maxCalls),
    maxTokens: clamp(source.maxTokens, 20000, 1000000, DEFAULTS.maxTokens),
    maxSourceChars: clamp(source.maxSourceChars, 8000, 400000, DEFAULTS.maxSourceChars),
    autoMax: clamp(source.autoMax, 1, 6, DEFAULTS.autoMax),
    lang: ['zh', 'en', 'auto'].includes(source.lang) ? source.lang : DEFAULTS.lang,
    strictAnchors: source.strictAnchors !== false,
    reportDir: typeof source.reportDir === 'string' && source.reportDir.trim() !== '' ? source.reportDir.trim() : DEFAULTS.reportDir,
    roles: { questioner: pick('questioner'), answerer: pick('answerer'), critic: pick('critic') },
    pdfTool: typeof source.pdfTool === 'string' ? source.pdfTool.trim() : '',
    pythonPath: typeof source.pythonPath === 'string' ? source.pythonPath.trim() : '',
  };
}

function routesFor(ctx, exec, resolved) {
  return {
    questioner: resolveModel(ctx, exec, resolved, 'questioner'),
    answerer: resolveModel(ctx, exec, resolved, 'answerer'),
    critic: resolveModel(ctx, exec, resolved, 'critic'),
  };
}

function sessionIdOf(exec) {
  const id = exec?.agent?.session?.header?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

function failureText(error) {
  if (error instanceof SourceError || error instanceof StateError) {
    return error.hint ? `${error.message}\n\n${error.hint}` : error.message;
  }
  if (error instanceof EngineError) {
    const head = `[${error.code}] ${error.message}`;
    return error.hint ? `${head}\n\n${error.hint}` : head;
  }
  return `追问引擎出错：${String(error?.message ?? error)}`;
}

function slug(text) {
  // A paper's first sentence is a bad filename: cut at the sentence boundary and
  // keep the name short enough to survive Windows path limits.
  const head = String(text ?? '').split(/[.。!?！？\n]/u)[0] ?? '';
  const base = head
    .replace(/[\\/:*?"<>|]/gu, ' ')
    .replace(/\s+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replace(/-+$/u, '');
  return base === '' ? 'inquiry' : base;
}

const OUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

const INQUIRY_ID = {
  type: 'string',
  required: true,
  description: 'inquiry_open 返回的 id，形如 inq_20261126_130102_ab12。',
};

export function apply(ctx, config) {
  const resolved = settings(config);

  ctx.tools.register(defineTool({
    name: 'inquiry_open',
    description: 'Start a layered inquiry over a paper, report, or any document: extracts a quotable evidence skeleton (thesis, claims, evidence, hidden assumptions, stated limitations, verbatim quotes) and returns three entry points worth probing. Accepts plain text, .md/.txt/.html, .docx, .pptx, .epub, .pdf, or a URL. Costs about one model call.',
    parameters: params({
      text: { type: 'string', description: '正文。与 path / url 三选一；长文会被截断并说明。' },
      path: { type: 'string', description: '本地文档：md/txt/html/docx/pptx/epub/pdf 等，按扩展名自动抽取正文。' },
      url: { type: 'string', description: '网页地址；需要 profile 里有 web 服务。' },
      title: { type: 'string', description: '材料标题，缺省时从正文首行推断。' },
      focus: { type: 'string', description: '你特别想追问的角度，例如「它的评测是否公平」。' },
      depth: { type: 'number', description: '本次追问的深度上限 1–7，默认取插件配置（5）。' },
    }),
    output: OUT,
    presentCall: (args) => ({
      card: 'generic',
      kind: 'read',
      title: `建立追问：${String(args?.title ?? args?.path ?? args?.url ?? args?.text ?? '').slice(0, 40) || '内容'}`,
      rawInput: args?.focus ? `focus: ${args.focus}` : undefined,
    }),
    async execute(args, exec) {
      const depth = typeof args.depth === 'number' && args.depth >= 1 ? Math.min(Math.round(args.depth), 7) : resolved.maxDepth;
      const runSettings = { ...resolved, maxDepth: depth };
      try {
        const routes = routesFor(ctx, exec, runSettings);
        const source = await normalizeSource(args, { cwd: cwdOf(exec), maxChars: runSettings.maxSourceChars, web: serviceWeb(ctx), signal: exec?.signal, settings: runSettings });

        const extracted = await extractBrief(ctx, { route: routes.questioner, source, focus: args.focus, lang: runSettings.lang, signal: exec?.signal, sessionId: sessionIdOf(exec) });
        const state = {
          id: newInquiryId(),
          createdAt: new Date().toISOString(),
          source: { kind: source.kind, title: source.title, chars: source.chars, truncated: source.truncated, note: source.note },
          settings: runSettings,
          brief: extracted.brief,
          layers: [],
          usage: {
            calls: extracted.calls,
            tokens: (extracted.usage?.inputTokens ?? 0) + (extracted.usage?.outputTokens ?? 0),
          },
          status: 'open',
        };
        await writeSource(state.id, source.text);
        await writeState(state);

        return { text: renderOpenResult(state, extracted.usage, extracted.calls) };
      } catch (error) {
        return { text: failureText(error) };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'inquiry_probe',
    description: 'Advance a layered inquiry by one layer: a questioner raises a question anchored in the source and triggered by a weakness in the previous answer, an answerer answers it with evidence grades, and a critic attacks it with at least one alternative explanation. Use auto=true to keep going until the branch converges or the budget runs out.',
    parameters: params({
      inquiry_id: INQUIRY_ID,
      operator: { type: 'string', enum: OPERATOR_IDS, description: '强制本层算子；缺省由阶梯与审辨者的建议决定。' },
      focus: { type: 'string', description: '本轮盯住的一个具体点。' },
      auto: { type: 'boolean', description: '连续推进，直到收敛、达到深度上限或预算用尽（单次最多 3 层）。' },
    }),
    output: OUT,
    presentCall: (args) => ({
      card: 'generic',
      kind: 'search',
      title: `追问一层${args?.operator ? `（${operatorName(args.operator)}）` : ''}`,
      rawInput: args?.focus ? `focus: ${args.focus}` : undefined,
    }),
    async execute(args, exec) {
      try {
        const state = await readState(args.inquiry_id);
        if (state.status === 'closed') {
          return { text: `这个追问已经收敛（status: closed）。需要继续时重新 inquiry_open 开一条新线，或直接看 inquiry_report。` };
        }
        const runSettings = state.settings ?? resolved;
        const routes = routesFor(ctx, exec, runSettings);
        const wanted = typeof args.operator === 'string' ? operatorById(args.operator)?.id : undefined;
        const maxRounds = args.auto === true ? Math.min(runSettings.autoMax ?? 3, runSettings.maxDepth) : 1;

        const digests = [];
        let lastDecision;
        for (let round = 0; round < maxRounds; round += 1) {
          if ((state.layers?.length ?? 0) >= (runSettings.maxDepth ?? 5)) break;
          const result = await runLayer(ctx, {
            routes,
            settings: runSettings,
            state,
            requestedOperator: round === 0 ? wanted : undefined,
            focus: args.focus,
            signal: exec?.signal,
            sessionId: sessionIdOf(exec),
          });
          state.layers.push(result.layer);
          state.usage = result.usage;
          lastDecision = result.layer.decision;
          digests.push(renderLayerDigest(state, result.layer));
          if (lastDecision?.action === 'stop') break;
        }

        if (lastDecision?.action === 'stop' || (state.layers?.length ?? 0) >= (runSettings.maxDepth ?? 5)) {
          state.status = 'closed';
        }
        await writeState(state);

        const tail = [];
        tail.push('');
        tail.push(`TOTAL ${state.usage.calls} calls · ${state.usage.tokens} tok · ${state.layers.length}/${runSettings.maxDepth} 层`);
        if (state.status === 'closed') {
          tail.push('这条主线已收敛。下一步：inquiry_report 出报告；或换个角度重新 inquiry_open。');
        } else {
          tail.push('继续：inquiry_probe 再推一层；或 inquiry_report 先出报告。');
        }
        return { text: `${digests.join('\n\n')}\n${tail.join('\n')}` };
      } catch (error) {
        return { text: failureText(error) };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'inquiry_view',
    description: 'Show an inquiry: the whole question tree by default, or one layer unabridged. Free — no model call.',
    parameters: params({
      inquiry_id: INQUIRY_ID,
      layer: { type: 'number', description: '层号（从 1 开始）。给出时返回该层完整记录。' },
    }),
    output: OUT,
    async execute(args) {
      try {
        const state = await readState(args.inquiry_id);
        if (typeof args.layer === 'number') {
          const layer = (state.layers ?? []).find((item) => item.index === Math.round(args.layer));
          if (layer === undefined) {
            return { text: `没有第 ${args.layer} 层。现有：${(state.layers ?? []).map((item) => item.index).join(', ') || '（空）'}` };
          }
          return { text: renderLayer(layer) };
        }
        return { text: renderTree(state) };
      } catch (error) {
        return { text: failureText(error) };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'inquiry_problems',
    description: 'Mine real, actionable research problems out of the document and the ladder so far: each one anchored in a quote or an exposed weakness, with what makes it a real problem, whether the author already raised it, a minimal experiment to start, and the main risk. Refuses slogan answers.',
    parameters: params({
      inquiry_id: INQUIRY_ID,
      focus: { type: 'string', description: '优先挖哪个方向，例如「部署成本」「评测协议」。' },
      top: { type: 'number', description: '要几条，1–6，默认 4。' },
      refresh: { type: 'boolean', description: '已经有结果时重新挖一遍。' },
    }),
    output: OUT,
    presentCall: (args) => ({ card: 'generic', kind: 'search', title: `提炼科研问题${args?.focus ? `（${args.focus}）` : ''}` }),
    async execute(args, exec) {
      try {
        const state = await readState(args.inquiry_id);
        const runSettings = state.settings ?? resolved;
        if ((state.problems ?? []).length > 0 && args.refresh !== true) {
          return { text: `${renderProblemsText(state)}\n\n（已有结果；要重挖加 refresh: true）` };
        }
        const routes = routesFor(ctx, exec, runSettings);
        const top = typeof args.top === 'number' ? args.top : 4;
        const mined = await mineProblems(ctx, {
          route: routes.critic,
          state,
          focus: args.focus,
          top,
          lang: runSettings.lang,
          signal: exec?.signal,
          sessionId: sessionIdOf(exec),
        });
        if (mined.problems.length === 0) {
          return { text: '这一轮没有挖出合格的问题（模型只给了空话，或材料太薄）。换一个更具体的 focus 再试一次。' };
        }
        state.problems = mined.problems;
        state.usage = {
          calls: (state.usage?.calls ?? 0) + mined.calls,
          tokens: (state.usage?.tokens ?? 0) + ((mined.usage?.inputTokens ?? 0) + (mined.usage?.outputTokens ?? 0)),
        };
        await writeState(state);
        return { text: renderProblemsText(state) };
      } catch (error) {
        return { text: failureText(error) };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'inquiry_report',
    description: 'Write the inquiry to a Markdown report in the workspace (question tree, every layer, aggregated weaknesses, open questions) and return the path plus a one-paragraph verdict. Costs one model call.',
    parameters: params({
      inquiry_id: INQUIRY_ID,
      path: { type: 'string', description: '报告目标路径；缺省写入 <工作区>/inquiry/<标题>.md。' },
    }),
    output: OUT,
    presentCall: () => ({ card: 'generic', kind: 'edit', title: '生成追问报告' }),
    async execute(args, exec) {
      try {
        const state = await readState(args.inquiry_id);
        const runSettings = state.settings ?? resolved;
        const routes = routesFor(ctx, exec, runSettings);

        if ((state.layers ?? []).length === 0 && (state.problems ?? []).length === 0) {
          return { text: '还没有任何内容：先用 inquiry_probe 推进一层，或 inquiry_problems 先挖一轮科研问题。' };
        }

        // The report always carries research problems: mine them when the caller
        // did not, so a report is never just a critique without an exit.
        if ((state.problems ?? []).length === 0) {
          try {
            const mined = await mineProblems(ctx, { route: routes.critic, state, lang: runSettings.lang, top: 4, signal: exec?.signal, sessionId: sessionIdOf(exec) });
            state.problems = mined.problems;
            state.usage = {
              calls: (state.usage?.calls ?? 0) + mined.calls,
              tokens: (state.usage?.tokens ?? 0) + ((mined.usage?.inputTokens ?? 0) + (mined.usage?.outputTokens ?? 0)),
            };
          } catch (error) {
            state.problemError = failureText(error);
          }
        }

        if ((state.layers ?? []).length > 0) {
          try {
            const synthesized = await synthesize(ctx, { route: routes.critic, state, lang: runSettings.lang, signal: exec?.signal, sessionId: sessionIdOf(exec) });
            state.summary = synthesized.value;
            state.usage = {
              calls: (state.usage?.calls ?? 0) + 1,
              tokens: (state.usage?.tokens ?? 0) + ((synthesized.usage?.inputTokens ?? 0) + (synthesized.usage?.outputTokens ?? 0)),
            };
          } catch (error) {
            state.summary = { verdict: `（合成段落失败：${failureText(error)}）` };
          }
        }

        state.status = 'closed';
        await writeState(state);

        const cwd = cwdOf(exec);
        const target = typeof args.path === 'string' && args.path.trim() !== ''
          ? path.resolve(cwd, args.path.trim())
          : path.join(cwd, runSettings.reportDir ?? 'inquiry', `${slug(state.brief?.title)}-${state.id.slice(-4)}.md`);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, renderReport(state), 'utf8');

        const head = [
          `REPORT ${target}`,
          `LAYERS ${state.layers.length} · PROBLEMS ${state.problems?.length ?? 0} · CALLS ${state.usage.calls} · TOKENS ${state.usage.tokens}`,
          '',
          state.summary?.verdict ? `结论 ${state.summary.verdict}` : '',
          state.summary?.unresolved ? `仍在追 ${state.summary.unresolved}` : '',
          ...(state.problems ?? []).slice(0, 2).map((problem, index) => `科研问题 ${index + 1} ${problem.title}`),
          (state.problems ?? []).length > 2 ? `（共 ${state.problems.length} 条，其余在报告里）` : '',
          state.problemError ? `问题提炼失败：${state.problemError}` : '',
        ].filter(Boolean);
        return { text: head.join('\n') };
      } catch (error) {
        return { text: failureText(error) };
      }
    },
  }));

  installSkill(ctx);
}

function operatorName(id) {
  const operator = operatorById(id);
  return operator ? label(operator) : String(id ?? '');
}

function serviceWeb(ctx) {
  try {
    const value = ctx.get('web');
    return value === undefined || value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

function renderOpenResult(state, usage, calls) {
  const brief = state.brief ?? {};
  const lines = [];
  lines.push(`INQUIRY ${state.id} · L0 定位 · ${calls ?? 1} call · ${(usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)} tok`);
  const origin = [state.source?.format ?? state.source?.kind ?? 'text', state.source?.engine].filter(Boolean).join(' via ');
  lines.push(`SOURCE ${origin} · ${state.source?.chars ?? 0} 字符${state.source?.truncated ? '（已截断）' : ''}`);
  if (state.source?.note) lines.push(`NOTE ${state.source.note}`);
  lines.push('');
  lines.push(`TITLE ${brief.title || state.source?.title || '(未命名)'}`);
  if (brief.thesis) lines.push(`THESIS ${brief.thesis}`);
  if (brief.claims?.length) {
    lines.push('');
    lines.push('CLAIMS');
    brief.claims.forEach((claim, index) => lines.push(`  ${index + 1}. ${claim}`));
  }
  if (brief.assumptions?.length) {
    lines.push('');
    lines.push('隐含前提');
    brief.assumptions.forEach((item) => lines.push(`  - ${item}`));
  }
  if (brief.quotes?.length) {
    lines.push('');
    lines.push('锚点（追问时会引用）');
    brief.quotes.slice(0, 8).forEach((quote) => lines.push(`  ${quote.id}${quote.loc ? ` (${quote.loc})` : ''} 「${quote.text}」`));
    if (brief.quotes.length > 8) lines.push(`  …共 ${brief.quotes.length} 条，其余在报告里`);
  }
  lines.push('');
  lines.push('值得追问的入口');
  const open = (brief.open?.length ? brief.open : brief.claims ?? []).slice(0, 3);
  open.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`));
  lines.push('');
  lines.push('NEXT inquiry_probe inquiry_id=' + state.id + '（默认 L1 拆解；也可用 operator 指定 premise / evidence / boundary）');
  return lines.join('\n');
}

function installSkill(scope) {
  const registerOn = async (sub) => {
    const registry = sub.get('skills');
    if (registry === undefined || typeof registry.register !== 'function') return;
    const raw = await readFile(path.join(SKILL_DIR, 'deep-inquiry', 'SKILL.md'), 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
    const description = frontmatter === null
      ? '分层追问一篇论文或任意长文：每层问题由上一层答案的弱点触发。'
      : (/description:\s*(.+)/u.exec(frontmatter[1])?.[1] ?? '分层追问一篇论文或任意长文。').trim();
    const content = (frontmatter === null ? raw : raw.slice(frontmatter[0].length)).trim();
    registry.register({ name: 'deep-inquiry', description, content });
  };
  try {
    if (typeof scope.inject === 'function') {
      scope.inject(['skills'], (sub) => {
        registerOn(sub).catch((error) => {
          scope.logger?.warn?.(`inquiry-ladder: skill registration skipped: ${String(error?.message ?? error)}`);
        });
      });
    }
  } catch (error) {
    scope.logger?.warn?.(`inquiry-ladder: skill injection unavailable: ${String(error?.message ?? error)}`);
  }
}
