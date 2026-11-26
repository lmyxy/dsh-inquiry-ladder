// The inquiry ladder: which cognitive operator a layer uses, how a layer is
// judged, and when the branch stops. Everything here is a pure function so the
// rules can be unit-tested without a model.

/** Ordered ladder. Index = the layer this operator belongs to. */
export const OPERATORS = [
  {
    id: 'orient',
    layer: 0,
    zh: '定位',
    en: 'Orient',
    aim: '它在哪个问题谱系里，作者承诺了什么',
  },
  {
    id: 'decompose',
    layer: 1,
    zh: '拆解',
    en: 'Decompose',
    aim: '论证由哪几条断言撑起来，哪条是支柱',
  },
  {
    id: 'premise',
    layer: 2,
    zh: '前提',
    en: 'Premise',
    aim: '结论默认了什么没有说出口的东西',
  },
  {
    id: 'evidence',
    layer: 3,
    zh: '证据',
    en: 'Evidence',
    aim: '证据是否真的支持结论：基线、消融、构念效度',
  },
  {
    id: 'boundary',
    layer: 4,
    zh: '边界',
    en: 'Boundary',
    aim: '什么条件下失效，构造一个让它退化的场景',
  },
  {
    id: 'rival',
    layer: 5,
    zh: '替代',
    en: 'Rival',
    aim: '还有什么机制能产生同样的现象，怎么区分',
  },
  {
    id: 'predict',
    layer: 6,
    zh: '预测',
    en: 'Predict',
    aim: '若主张为真，应观察到什么尚未被观察到的现象',
  },
  {
    id: 'transfer',
    layer: 7,
    zh: '迁移',
    en: 'Transfer',
    aim: '抽出的机制能搬到哪里，换掉核心假设会得到什么',
  },
];

const BY_ID = new Map(OPERATORS.map((operator) => [operator.id, operator]));

/** Operators that may be requested explicitly, or chosen by the ladder itself. */
export const OPERATOR_IDS = OPERATORS.map((operator) => operator.id);

export function operatorById(id) {
  return BY_ID.get(String(id ?? '').trim().toLowerCase());
}

export function operatorForLayer(layer) {
  return OPERATORS[Math.min(Math.max(Number(layer) || 0, 0), OPERATORS.length - 1)];
}

export function label(operator) {
  return `${operator.zh} ${operator.en}`;
}

/**
 * Choose one operator for the next layer.
 * - an explicit request wins, unless it is the operator the branch just used;
 * - otherwise take the operator the critic proposed, if legal;
 * - otherwise the next rung of the ladder.
 * @param options - `requested` operator id, `criticCandidates` ids, `history` used ids.
 * @returns the chosen operator, plus whether the request had to be bent.
 */
export function chooseOperator({ requested, criticCandidates = [], history = [], depth = 1 } = {}) {
  const used = new Set(history);
  const legal = (id) => {
    const operator = operatorById(id);
    if (operator === undefined) return undefined;
    if (used.has(operator.id) && operator.id !== 'boundary') return undefined;
    return operator;
  };

  const explicit = legal(requested);
  if (explicit !== undefined) return { operator: explicit, bent: false };

  for (const candidate of criticCandidates) {
    const operator = legal(candidate);
    if (operator !== undefined) return { operator, bent: false };
  }

  const natural = operatorForLayer(depth);
  if (!used.has(natural.id)) return { operator: natural, bent: false };

  // The rung was already used on this branch: climb to the first unused one.
  const start = OPERATORS.indexOf(natural);
  for (let step = 1; step <= OPERATORS.length; step += 1) {
    const candidate = OPERATORS[(start + step) % OPERATORS.length];
    if (!used.has(candidate.id)) return { operator: candidate, bent: true };
  }
  return { operator: natural, bent: true };
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'is', 'are', 'was', 'were', 'be', 'been',
  'that', 'this', 'these', 'those', 'it', 'its', 'as', 'at', 'by', 'for', 'from', 'on',
  'with', 'without', 'which', 'what', 'how', 'why', 'when', 'does', 'do', 'did', 'can',
  'could', 'should', 'would', 'not', 'no', 'than', 'then', 'there', 'their', 'they',
  '的', '了', '是', '在', '和', '与', '或', '这', '那', '有', '无', '对', '为', '把', '被',
  '吗', '呢', '如何', '什么', '为什么', '是否', '一个', '这个', '那个',
]);

export function tokens(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const out = [];
  for (const word of words) {
    if (/^\p{Script=Han}+$/u.test(word) && word.length > 1) {
      // Chinese has no spaces: compare character bigrams instead of whole clauses.
      for (let index = 0; index < word.length - 1; index += 1) out.push(word.slice(index, index + 2));
    } else if (word.length > 1 && !STOPWORDS.has(word)) {
      out.push(word);
    }
  }
  return out;
}

/**
 * Overlap coefficient over content tokens: shared / min(|a|, |b|). Chosen over
 * Jaccard because a re-worded question is usually a superset of the original,
 * and the job here is to catch restatements, not to measure symmetric distance.
 */
export function similarity(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/** Whether a candidate question repeats one already asked on this branch. */
export function isRepeat(question, asked, threshold = 0.72) {
  return asked.some((previous) => similarity(question, previous) >= threshold);
}

const ANCHOR_PATTERN = /["“”「」『』][^"“”「」『』]{4,}["“”「」『』]|§|p\.?\s?\d|第\s?\d+\s?[节章页]|\[\d+\]/u;

/** Whether a question carries a quotable anchor into the source material. */
export function hasAnchor(question) {
  return ANCHOR_PATTERN.test(String(question ?? ''));
}

/**
 * Judge one layer from the critic's report and the remaining budget.
 * @param input - the critic output, ladder settings, and consumed budget.
 * @returns `{ action, reason }` where action is `pass`, `continue`, or `stop`.
 */
export function decide({ critique, depth, settings, usage }) {
  const verdict = String(critique?.verdict ?? '').toLowerCase();
  const residual = Array.isArray(critique?.residual) ? critique.residual.filter(Boolean) : [];
  const weakPoints = Array.isArray(critique?.weakPoints) ? critique.weakPoints.filter(Boolean) : [];
  const hasRival = Boolean(String(critique?.alternative ?? '').trim() || String(critique?.counterexample ?? '').trim());

  if (usage.calls >= settings.maxCalls) return { action: 'stop', reason: '调用预算用尽' };
  if (usage.tokens >= settings.maxTokens) return { action: 'stop', reason: 'token 预算用尽' };

  if (!hasRival && settings.strictAnchors) {
    // Rule 5: no alternative explanation or counterexample means the layer did
    // not earn the right to advance; spend one more probe on the same rung.
    return { action: 'continue', reason: '审辨者未给出替代解释或反例，本层不推进' };
  }

  if (verdict === 'needs_more' || residual.length > 0) {
    if (depth >= settings.maxDepth) return { action: 'stop', reason: '达到深度上限，仍有残留疑问' };
    return { action: 'continue', reason: `仍有 ${residual.length || 1} 个残留疑问` };
  }

  if (weakPoints.length > 0 && depth < settings.maxDepth) {
    return { action: 'continue', reason: '弱点尚未被追问' };
  }

  return { action: 'pass', reason: '本层收敛' };
}

/** Budget snapshot after adding one call's usage. */
export function bumpUsage(usage, callUsage) {
  return {
    calls: (usage.calls ?? 0) + 1,
    tokens: (usage.tokens ?? 0) + ((callUsage?.inputTokens ?? 0) + (callUsage?.outputTokens ?? 0)),
  };
}

/** Normalise a model-produced question into the stored shape. */
export function normalizeQuestion(raw) {
  const question = String(raw?.question ?? raw?.q ?? '').trim();
  const subQuestions = (Array.isArray(raw?.subQuestions) ? raw.subQuestions : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 4);
  return {
    question,
    subQuestions,
    why: String(raw?.why ?? raw?.why_now ?? '').trim(),
    anchors: (Array.isArray(raw?.anchors) ? raw.anchors : [])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .slice(0, 4),
  };
}

/** Normalise the critic output. */
export function normalizeCritique(raw) {  const weakPoints = (Array.isArray(raw?.weakPoints) ? raw.weakPoints : [])
    .map((item) => {
      if (typeof item === 'string') return { point: item.trim(), why: '', needs: '' };
      return {
        point: String(item?.point ?? item?.weakness ?? '').trim(),
        why: String(item?.why ?? '').trim(),
        needs: String(item?.needs ?? item?.evidence ?? '').trim(),
      };
    })
    .filter((item) => item.point !== '')
    .slice(0, 6);
  return {
    weakPoints,
    alternative: String(raw?.alternative ?? '').trim(),
    counterexample: String(raw?.counterexample ?? '').trim(),
    verdict: String(raw?.verdict ?? '').toLowerCase() === 'pass' ? 'pass' : 'needs_more',
    residual: (Array.isArray(raw?.residual) ? raw.residual : [])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .slice(0, 5),
    nextCandidates: (Array.isArray(raw?.nextCandidates) ? raw.nextCandidates : [])
      .map((item) => String(item ?? '').trim().toLowerCase())
      .filter((item) => BY_ID.has(item))
      .slice(0, 3),
  };
}

/** Kinds of research problem the miner may report. */
export const PROBLEM_KINDS = [
  { id: 'mechanism', zh: '机制未解释', hint: '现象被观察到，但为什么成立没人说得清' },
  { id: 'deployment', zh: '部署假设不成立', hint: '论文的假设在真实环境/规模/成本下会破' },
  { id: 'eval', zh: '评测盲区', hint: '指标或基线漏掉了某个真实目标' },
  { id: 'data', zh: '数据缺口', hint: '缺一类数据，导致这个问题无法被回答' },
  { id: 'transfer', zh: '可迁移未做', hint: '机制成立但没人搬到另一个问题域' },
  { id: 'assumption', zh: '前提脆弱', hint: '结论吊在一个没人检验的前提上' },
];

const KIND_IDS = new Set(PROBLEM_KINDS.map((kind) => kind.id));

export function problemKindLabel(id) {
  return PROBLEM_KINDS.find((kind) => kind.id === id)?.zh ?? String(id ?? '');
}

const BANNED = /更好的可解释性|更高效的算法|更大规模的?数据|更多标注|更强的模型|值得进一步研究/u;

/**
 * Normalise the mined research problems: whitelist kinds, drop empty or
 * slogan-shaped entries, and collapse near-duplicates.
 */
export function normalizeProblems(raw) {
  const list = Array.isArray(raw?.problems) ? raw.problems : Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const title = String(item?.title ?? item?.problem ?? '').trim();
    if (title === '') continue;
    const substance = [item?.statement, item?.whyReal, item?.evidence].map((part) => String(part ?? '')).join('').length;
    if (BANNED.test(title) && substance < 30) continue;
    if (out.some((existing) => similarity(existing.title, title) >= 0.7)) continue;
    out.push({
      title,
      kind: KIND_IDS.has(String(item?.kind ?? '').trim()) ? String(item.kind).trim() : 'assumption',
      statement: String(item?.statement ?? '').trim(),
      whyReal: String(item?.whyReal ?? item?.why ?? '').trim(),
      evidence: String(item?.evidence ?? '').trim(),
      novelty: String(item?.novelty ?? '').trim(),
      firstStep: String(item?.firstStep ?? item?.experiment ?? '').trim(),
      risk: String(item?.risk ?? '').trim(),
      difficulty: ['low', 'medium', 'high'].includes(String(item?.difficulty ?? '').trim())
        ? String(item.difficulty).trim()
        : 'medium',
    });
  }
  return out.slice(0, 6);
}
