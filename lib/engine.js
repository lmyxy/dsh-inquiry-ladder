// The engine: model routing, one streaming call, and the three-role layer.
// Deliberately dependency-free — it consumes the raw chunk protocol instead of
// importing @deepseek-ai/dsh-llm, so the bundle resolves in any install shape.
import {
  chooseOperator,
  decide,
  hasAnchor,
  isRepeat,
  label,
  normalizeCritique,
  normalizeProblems,
  normalizeQuestion,
  operatorById,
} from './ladder.js';
import { answerPrompt, criticPrompt, extractPrompt, problemsPrompt, questionPrompt, repairPrompt, synthesisPrompt } from './prompts.js';

export class EngineError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.hint = hint;
  }
}

/** Read an optional Cordis service without throwing when it is absent. */
export function serviceOf(ctx, name) {
  try {
    const value = ctx.get(name);
    return value === undefined || value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Which route a role should use, in order: plugin config override for the role,
 * the calling agent's current selection, the profile default, then the first
 * advertised model.
 */
export function resolveModel(ctx, exec, settings, role) {
  const override = settings?.roles?.[role];
  if (override?.provider && override?.model) {
    return { provider: override.provider, model: override.model, reasoningEffort: override.reasoningEffort };
  }

  const fromAgent = exec?.agent?.model?.current?.();
  if (fromAgent?.provider && fromAgent?.model) {
    return { provider: fromAgent.provider, model: fromAgent.model, reasoningEffort: fromAgent.reasoningEffort };
  }

  const fromDefault = serviceOf(ctx, 'agentDefaultModel')?.currentSelection?.();
  if (fromDefault?.provider && fromDefault?.model) {
    return { provider: fromDefault.provider, model: fromDefault.model, reasoningEffort: fromDefault.reasoningEffort };
  }

  throw new EngineError(
    'NO_MODEL',
    '拿不到可用的模型路由。',
    '在输入框里选一个模型后重试；或在插件配置 roles.questioner / roles.answerer / roles.critic 里写死 provider 与 model。',
  );
}

/** Collect one streamed call into plain text, forwarding cancellation. */
export async function callModel(ctx, { provider, model, reasoningEffort, system, user, maxTokens, signal, sessionId }) {
  const llm = serviceOf(ctx, 'llm');
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new EngineError('LLM_UNAVAILABLE', '当前 profile 没有可用的 llm 服务。', '确认 @deepseek-ai/dsh-llm 与至少一个 provider 适配器已挂载。');
  }

  let text = '';
  let usage;
  let finish;

  const request = {
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    signal,
  };
  if (reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort;
  if (Number.isFinite(maxTokens) && maxTokens > 0) request.maxTokens = Math.floor(maxTokens);
  // Some provider routes reject a request that carries no session identity
  // (opencode answers 400 MissingSessionID), so the caller's session travels
  // with every auxiliary call.
  if (typeof sessionId === 'string' && sessionId !== '') request.sessionId = sessionId;

  for await (const chunk of llm.stream(request)) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'usage') usage = chunk.usage;
    else if (chunk.type === 'finish') finish = chunk.reason;
  }

  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    const failure = finish.failure ?? {};
    throw new EngineError(
      failure.code ?? (finish.kind === 'aborted' ? 'ABORTED' : 'LLM_ERROR'),
      `模型调用失败：${failure.message ?? finish.kind}`,
      failure.code === 'RATE_LIMIT' ? '稍等片刻再试；或把 maxDepth 调小。' : '',
    );
  }

  return { text: text.trim(), usage, finish };
}

/** Pull the first JSON object out of a model reply, tolerating fences and prose. */
export function parseJsonLoose(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return undefined;
  const unfenced = text
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const candidates = [unfenced];
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(unfenced.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value !== null && typeof value === 'object') return value;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

async function callStructured(ctx, route, { system, user, maxTokens, signal, schema, sessionId }) {
  const budget = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 1200;
  let calls = 0;
  let usage;

  const ask = async (systemText, userText, cap) => {
    const result = await callModel(ctx, { ...route, system: systemText, user: userText, maxTokens: cap, signal, sessionId });
    calls += 1;
    usage = mergeUsage(usage, result.usage);
    return result;
  };

  let first = await ask(system, user, budget);
  // A reasoning-heavy route can spend the whole output budget before emitting
  // any text; retry once with real headroom instead of repairing an empty reply.
  if (first.text === '' && first.finish?.kind === 'max-tokens') {
    first = await ask(system, user, budget * 4);
  }
  if (first.text === '') {
    throw new EngineError(
      'EMPTY_OUTPUT',
      first.finish?.kind === 'max-tokens' ? '模型输出被 maxTokens 截断，没有留下正文。' : '模型没有返回任何正文。',
      '给该角色换一个非推理模型，或在插件配置里调大对应 role 的预算。',
    );
  }
  const parsed = parseJsonLoose(first.text);
  if (parsed !== undefined) return { value: parsed, usage, calls };

  const repair = repairPrompt({ broken: first.text, schema });
  const second = await ask(repair.system, repair.user, budget * 2);
  const repaired = parseJsonLoose(second.text);
  if (repaired !== undefined) return { value: repaired, usage, calls };

  throw new EngineError('BAD_JSON', '模型两次都没有返回合法 JSON。', '重试本层；若持续失败，说明该模型不擅长结构化输出，给 roles 换一个模型。');
}

/** Pass 0: build the quotable evidence skeleton. */
export async function extractBrief(ctx, { route, source, focus, lang, signal, sessionId }) {
  const { system, user } = extractPrompt({ title: source.title, text: source.text, focus, lang });
  const { value, usage, calls } = await callStructured(ctx, route, {
    system,
    user,
    maxTokens: 5000,
    signal,
    sessionId,
    schema: '{"title":string,"thesis":string,"claims":[string],"evidence":[string],"assumptions":[string],"quotes":[{"id":"q1","text":string,"loc":string}],"open":[string]}',
  });

  const quotes = (Array.isArray(value.quotes) ? value.quotes : [])
    .map((quote, index) => ({
      id: String(quote?.id ?? `q${index + 1}`).trim() || `q${index + 1}`,
      text: String(quote?.text ?? '').trim(),
      loc: String(quote?.loc ?? '').trim(),
    }))
    .filter((quote) => quote.text !== '')
    .slice(0, 14);

  // A filename is not a title: when the model echoes one, fall back to the
  // document's own first meaningful line.
  const echoed = String(value.title ?? '').trim();
  const fromModel = /\.[a-z0-9]{1,5}$/iu.test(echoed) ? '' : echoed;
  const firstLine = String(source?.text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^#+\s*/u, ''))
    .find((line) => line.length >= 4) ?? '';
  const brief = {
    title: fromModel || firstLine.slice(0, 120),
    thesis: String(value.thesis ?? '').trim(),
    claims: (Array.isArray(value.claims) ? value.claims : []).map(String).filter(Boolean).slice(0, 6),
    evidence: (Array.isArray(value.evidence) ? value.evidence : []).map(String).filter(Boolean).slice(0, 8),
    assumptions: (Array.isArray(value.assumptions) ? value.assumptions : []).map(String).filter(Boolean).slice(0, 5),
    quotes,
    open: (Array.isArray(value.open) ? value.open : []).map(String).filter(Boolean).slice(0, 5),
    limitations: (Array.isArray(value.limitations) ? value.limitations : []).map(String).filter(Boolean).slice(0, 5),
    futureWork: (Array.isArray(value.futureWork) ? value.futureWork : []).map(String).filter(Boolean).slice(0, 5),
  };

  return { brief, usage, calls };
}

function historyDigest(layers) {
  return (layers ?? []).map((layer) => {
    const op = operatorById(layer.operator);
    const verdict = layer.critique?.verdict ?? '';
    return `L${layer.index} ${op ? label(op) : layer.operator} · ${String(layer.question).slice(0, 160)} → ${layer.answer.slice(0, 120)} …[${verdict}]`;
  });
}

/**
 * One layer: questioner → answerer → critic, then the ladder decides.
 * @returns the stored layer plus the decision and the token cost.
 */
export async function runLayer(ctx, { routes, settings, state, requestedOperator, focus, signal, sessionId }) {
  const depth = (state.layers?.length ?? 0) + 1;
  const history = (state.layers ?? []).map((layer) => layer.operator);
  const asked = (state.layers ?? []).map((layer) => layer.question);
  const candidates = state.layers?.at(-1)?.critique?.nextCandidates ?? [];
  const { operator } = chooseOperator({ requested: requestedOperator, criticCandidates: candidates, history, depth });

  const questionRoute = routes.questioner;
  const answerRoute = routes.answerer;
  const criticRoute = routes.critic;

  const qPrompt = questionPrompt({ brief: state.brief, history: historyDigest(state.layers), operator, focus, lang: settings.lang, branches: settings.branches });
  const asked0 = await callStructured(ctx, questionRoute, {
    system: qPrompt.system,
    user: qPrompt.user,
    maxTokens: 2200,
    signal,
    sessionId,
    schema: '{"question":string,"subQuestions":[string],"anchors":[string],"why":string}',
  });

  let question = normalizeQuestion(asked0.value);
  let calls = asked0.calls;
  let usage = asked0.usage;

  if (question.question === '') throw new EngineError('EMPTY_QUESTION', '提问者没有给出问题。', '重试本层。');
  if (!hasAnchor(question.question) && settings.strictAnchors) {
    // One corrective attempt, then accept with a recorded flag rather than fail.
    const again = await callStructured(ctx, questionRoute, {
      system: `${qPrompt.system}\n注意：上一条问题缺少原文锚点。必须在问题里用「」逐字引用一条 quote 并标注其 id。`,
      user: qPrompt.user,
      maxTokens: 2200,
      signal,
      sessionId,
      schema: '{"question":string,"subQuestions":[string],"anchors":[string],"why":string}',
    });
    const retry = normalizeQuestion(again.value);
    calls += again.calls;
    usage = mergeUsage(usage, again.usage);
    if (retry.question !== '' && hasAnchor(retry.question)) question = retry;
  }

  const repeated = isRepeat(question.question, asked);

  const aPrompt = answerPrompt({ brief: state.brief, layer: question, operator, lang: settings.lang });
  const answered = await callStructured(ctx, answerRoute, {
    system: aPrompt.system,
    user: aPrompt.user,
    maxTokens: 2600,
    signal,
    sessionId,
    schema: '{"answer":string,"unsure":[string]}',
  });
  calls += answered.calls;
  usage = mergeUsage(usage, answered.usage);

  const answer = String(answered.value.answer ?? '').trim();
  if (answer === '') throw new EngineError('EMPTY_ANSWER', '应答者没有给出回答。', '重试本层。');

  const cPrompt = criticPrompt({ brief: state.brief, layer: { ...question, answer, unsure: answered.value.unsure }, operator, lang: settings.lang });
  const critiqued = await callStructured(ctx, criticRoute, {
    system: cPrompt.system,
    user: cPrompt.user,
    maxTokens: 2200,
    signal,
    sessionId,
    schema: '{"weakPoints":[{"point":string,"why":string,"needs":string}],"alternative":string,"counterexample":string,"verdict":"pass|needs_more","residual":[string],"nextCandidates":[string]}',
  });
  calls += critiqued.calls;
  usage = mergeUsage(usage, critiqued.usage);
  const critique = normalizeCritique(critiqued.value);

  const nextUsage = {
    calls: (state.usage?.calls ?? 0) + calls,
    tokens: (state.usage?.tokens ?? 0) + ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
  };
  const decision = decide({ critique, depth, settings, usage: nextUsage });

  return {
    layer: {
      index: depth,
      operator: operator.id,
      question: question.question,
      subQuestions: question.subQuestions,
      anchors: question.anchors,
      why: question.why,
      repeated,
      answer,
      unsure: (Array.isArray(answered.value.unsure) ? answered.value.unsure : []).map(String).filter(Boolean).slice(0, 4),
      critique,
      decision,
      calls,
      tokens: usage,
    },
    usage: nextUsage,
  };
}

function mergeUsage(left, right) {
  return {
    inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0),
    outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0),
  };
}

/** Closing prose for the report. */
export async function synthesize(ctx, { route, state, lang, signal, sessionId }) {
  const { system, user } = synthesisPrompt({ state, lang });
  const result = await callModel(ctx, { ...route, system, user, maxTokens: 1600, signal, sessionId });
  const parsed = parseJsonLoose(result.text);
  return {
    value: parsed ?? { verdict: result.text.slice(0, 600) },
    usage: result.usage,
  };
}


/**
 * Mine real research problems out of the document plus whatever the ladder has
 * already exposed. One call; the value is in refusing generic answers.
 */
export async function mineProblems(ctx, { route, state, focus, top, lang, signal, sessionId }) {
  const { system, user } = problemsPrompt({ state, focus, top, lang });
  const { value, usage, calls } = await callStructured(ctx, route, {
    system,
    user,
    maxTokens: 4000,
    signal,
    sessionId,
    schema: '{"problems":[{"title":string,"kind":string,"statement":string,"whyReal":string,"evidence":string,"novelty":string,"firstStep":string,"risk":string,"difficulty":string}]}',
  });
  const limit = Number.isFinite(top) && top > 0 ? Math.min(Math.round(top), 6) : 4;
  return { problems: normalizeProblems(value).slice(0, limit), usage, calls };
}
