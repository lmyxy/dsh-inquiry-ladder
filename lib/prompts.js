// System prompts for the four roles. Kept short on purpose: every token here is
// paid on every call, and the ladder's discipline comes from the schema plus the
// validators in ladder.js, not from prose length.

const LANGUAGE = {
  zh: '用简体中文写；被引用的原文保持原语言；专业术语保留英文原词。',
  en: 'Write in English; keep quoted source text in its original language.',
  auto: '用与源文本相同的语言写；引用保持原文。',
};

function languageLine(lang) {
  return LANGUAGE[lang] ?? LANGUAGE.zh;
}

const JSON_ONLY = '只输出一个 JSON 对象，不要解释、不要 Markdown 代码围栏。';

function stringifyBrief(brief) {
  return JSON.stringify({
    title: brief?.title ?? '',
    thesis: brief?.thesis ?? '',
    claims: (brief?.claims ?? []).slice(0, 6),
    evidence: (brief?.evidence ?? []).slice(0, 8),
    assumptions: (brief?.assumptions ?? []).slice(0, 5),
    quotes: (brief?.quotes ?? []).slice(0, 14).map((quote) => ({ id: quote.id, text: quote.text, loc: quote.loc })),
    open: (brief?.open ?? []).slice(0, 5),
  });
}

/** Pass 0: turn raw text into a quotable evidence skeleton. */
export function extractPrompt({ title, text, focus, lang }) {
  const system = [
    '你是严谨的论文审读者。你的任务不是总结，而是从材料里抽出「可以被追问」的证据骨架。',
    '规则：',
    '1. quotes 必须逐字摘录原文，每条 ≤60 字，附位置（章节名/页码/段落序号）；不得改写、不得拼接两句。',
    '2. claims 区分三类：作者声称的贡献、支撑性断言、隐含前提（作者没说但必须成立）。',
    '3. 数字必须带单位和对照（例："延迟降低 40%，对照 batch=1"）。',
    '4. 抽不出就留空数组，禁止编造。',
    JSON_ONLY,
    'schema: {"title":string,"thesis":string,"claims":[string],"evidence":[string],"assumptions":[string],"quotes":[{"id":"q1","text":string,"loc":string}],"open":[string]}',
    languageLine(lang),
  ].join('\n');

  const user = [
    title ? `材料标题：${title}` : '',
    focus ? `读者特别想追问的角度：${focus}` : '',
    '材料正文：',
    '<<<',
    text,
    '>>>',
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user };
}

/** Pass 1: the questioner raises the next layer's question. */
export function questionPrompt({ brief, history, operator, focus, lang, branches = 2 }) {
  const subCount = Math.min(Math.max(Number(branches) || 2, 1), 4);
  const system = [
    '你是苏格拉底式的提问者。你只问一个问题层级里的主问题（外加不超过 ' + subCount + ' 个子问题）。',
    `这一层必须使用的认知算子：${operator.zh} ${operator.en} —— ${operator.aim}。`,
    '硬规则：',
    '1. 问题必须锚定原文：在问题里用「」逐字引用一条 quote，并在括号里写它的 id，如（q3）。',
    '2. 问题必须由上一层答案的某一处薄弱点触发；在 why 里引用那处答案的原话（≤30 字）。',
    '3. 问题必须可回答或可证伪。禁止「这有什么意义/价值」式空问。',
    '4. 不要重复历史里已有的问法。',
    JSON_ONLY,
    'schema: {"question":string,"subQuestions":[string],"anchors":["q3"],"why":string}',
    languageLine(lang),
  ].join('\n');

  const user = [
    `证据骨架：${stringifyBrief(brief)}`,
    history.length > 0 ? `已完成的层：\n${history.join('\n')}` : '这是第一层。',
    focus ? `本轮额外关注：${focus}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { system, user };
}

/** Pass 2: the answerer attempts an evidence-graded answer. */
export function answerPrompt({ brief, layer, operator, lang }) {
  const system = [
    '你是应答者。针对给定问题给出你能给出的最好回答，并诚实标注证据强度。',
    '规则：',
    '1. 每条结论后用 [E1]–[E4] 标注：E1 原文实测数据；E2 原文推理或作者断言；E3 领域常识（未核）；E4 我的推测。',
    '   来源是原文某条 quote 时把锚点写进标记里，如 [E1 q3]；E3/E4 不挂锚点。',
    '2. 能答多少答多少；答不出的写进 unsure，不要编。',
    '3. answer 控制在 260 字以内，优先结论与区分度，不复述问题。',
    JSON_ONLY,
    'schema: {"answer":string,"unsure":[string]}',
    languageLine(lang),
  ].join('\n');

  const user = [
    `证据骨架：${stringifyBrief(brief)}`,
    `算子：${operator.zh} ${operator.en}`,
    `问题：${layer.question}`,
    layer.subQuestions.length > 0 ? `子问题：${layer.subQuestions.join('；')}` : '',
    layer.why ? `提问动机：${layer.why}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user };
}

/** Pass 3: the critic must find the weakness and at least one rival story. */
export function criticPrompt({ brief, layer, operator, lang }) {
  const system = [
    '你是审辨者，不是附和者。你的任务是让这个回答站不住，或者确认它暂时站得住。',
    '规则：',
    '1. weakPoints：回答里没有证据支撑、或证据不足以支撑结论的地方，每条写清需要什么才能确认。 检查证据标记是否真的挂在 quote 上；只写 [E1] 不指向 qN 的算弱点。',
    '2. alternative 或 counterexample 至少给一个（这是硬要求）：另一种能产生同样现象的机制，或一个让结论失效的场景。',
    '3. verdict：回答可接受且无新漏洞填 pass；仍有可追问处填 needs_more。',
    '4. residual：留给下一层追问的具体疑问，≤5 条，每条必须指向回答里的具体句子。',
    '5. nextCandidates 从这些里选：decompose, premise, evidence, boundary, rival, predict, transfer。',
    JSON_ONLY,
    'schema: {"weakPoints":[{"point":string,"why":string,"needs":string}],"alternative":string,"counterexample":string,"verdict":"pass|needs_more","residual":[string],"nextCandidates":[string]}',
    languageLine(lang),
  ].join('\n');

  const user = [
    `证据骨架：${stringifyBrief(brief)}`,
    `算子：${operator.zh} ${operator.en}`,
    `问题：${layer.question}`,
    `回答：${layer.answer}`,
    layer.unsure?.length ? `应答者承认答不出的部分：${layer.unsure.join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user };
}

/** Closing pass: the report's prose sections. */
export function synthesisPrompt({ state, lang }) {
  const system = [
    '你是这份追问报告的合写者。基于给定的层记录，写出三段判断，不要复述明细。',
    JSON_ONLY,
    'schema: {"verdict":string,"strongest":string,"unresolved":string,"nextAction":string}',
    'verdict：这份材料目前最站得住的一条结论；strongest：最有力的证据或最脆弱的环节（一句话点明）；unresolved：最值得继续追的一个问题；nextAction：一个 1 天内能做完的验证动作。',
    languageLine(lang),
  ].join('\n');

  const user = JSON.stringify({
    title: state.brief?.title ?? '',
    thesis: state.brief?.thesis ?? '',
    claims: state.brief?.claims ?? [],
    layers: (state.layers ?? []).map((layer) => ({
      operator: layer.operator,
      question: layer.question,
      answer: layer.answer,
      verdict: layer.critique?.verdict ?? '',
      residual: layer.critique?.residual ?? [],
    })),
  });

  return { system, user };
}

/** Repair pass when a role returned prose instead of JSON. */
export function repairPrompt({ broken, schema }) {
  return {
    system: '你刚才的输出不是合法 JSON。只输出符合 schema 的一个 JSON 对象，不要任何其他文字。',
    user: `schema: ${schema}\n---\n你的上一条输出：\n${String(broken).slice(0, 4000)}`,
  };
}
