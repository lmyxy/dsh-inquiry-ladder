// Pure Markdown rendering. No I/O here: the same function is used for the tool
// result, the on-disk report, and the unit tests.
import { label, operatorById, problemKindLabel } from './ladder.js';

function opName(id) {
  const operator = operatorById(id);
  return operator ? label(operator) : String(id ?? '?');
}

function bullets(items, empty = '（无）') {
  const list = (items ?? []).filter(Boolean);
  if (list.length === 0) return empty;
  return list.map((item) => `- ${item}`).join('\n');
}

/** The indented question tree, one line per layer. */
export function renderTree(state) {
  const lines = [];
  lines.push(`# ${state?.brief?.title || '追问'}`);
  lines.push('');
  lines.push(`id ${state.id} · ${state.layers?.length ?? 0}/${state.settings?.maxDepth ?? '?'} 层 · ${state.usage?.calls ?? 0} 次调用 · ${state.usage?.tokens ?? 0} tok`);
  lines.push('');
  for (const layer of state.layers ?? []) {
    const indent = '  '.repeat(Math.max(0, layer.index - 1));
    const verdict = layer.critique?.verdict === 'pass' ? '收敛' : '待追';
    lines.push(`${indent}L${layer.index} ${opName(layer.operator)} · ${layer.question}  [${verdict}]`);
  }
  const residual = state.layers?.at(-1)?.critique?.residual ?? [];
  if (residual.length > 0) {
    lines.push('');
    lines.push('残留疑问：');
    for (const item of residual) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

/** One layer, unabridged. */
export function renderLayer(layer) {
  const lines = [];
  lines.push(`### L${layer.index} · ${opName(layer.operator)}`);
  lines.push('');
  lines.push(`**问** ${layer.question}`);
  if (layer.why) lines.push(`> 动机：${layer.why}`);
  if (layer.subQuestions?.length) {
    lines.push('');
    for (const sub of layer.subQuestions) lines.push(`- ${sub}`);
  }
  lines.push('');
  lines.push(`**答** ${layer.answer}`);
  if (layer.unsure?.length) lines.push(`> 答不出：${layer.unsure.join('；')}`);
  const critique = layer.critique ?? {};
  if (critique.weakPoints?.length) {
    lines.push('');
    lines.push('**弱点**');
    for (const point of critique.weakPoints) {
      const needs = point.needs ? `（需：${point.needs}）` : '';
      lines.push(`- ${point.point}${point.why ? ` —— ${point.why}` : ''}${needs}`);
    }
  }
  if (critique.alternative) lines.push(`\n**替代解释** ${critique.alternative}`);
  if (critique.counterexample) lines.push(`\n**反例场景** ${critique.counterexample}`);
  if (critique.residual?.length) {
    lines.push('');
    lines.push('**残留**');
    for (const item of critique.residual) lines.push(`- ${item}`);
  }
  lines.push('');
  lines.push(`> 裁决：${layer.decision?.reason ?? ''}（${critique.verdict === 'pass' ? 'pass' : 'needs_more'}）`);
  return lines.join('\n');
}

/** The full report written to disk. */
export function renderReport(state) {
  const brief = state.brief ?? {};
  const layers = state.layers ?? [];
  const weak = [];
  const residual = [];
  for (const layer of layers) {
    for (const point of layer.critique?.weakPoints ?? []) weak.push(`L${layer.index} · ${point.point}`);
    for (const item of layer.critique?.residual ?? []) residual.push(`L${layer.index} · ${item}`);
  }

  const lines = [];
  lines.push(`# 追问报告：${brief.title || '未命名材料'}`);
  lines.push('');
  lines.push(`- 追问 id：\`${state.id}\``);
  lines.push(`- 来源：${state.source?.kind ?? 'text'} · ${state.source?.chars ?? 0} 字符${state.source?.truncated ? '（已截断）' : ''}`);
  lines.push(`- 深度：${layers.length} 层 / 上限 ${state.settings?.maxDepth ?? '?'} · 调用 ${state.usage?.calls ?? 0} 次 · ${state.usage?.tokens ?? 0} tok`);
  if (state.createdAt) lines.push(`- 建立于：${state.createdAt}`);
  lines.push('');

  if (state.summary?.verdict) {
    lines.push('## 一句话结论');
    lines.push(state.summary.verdict);
    lines.push('');
  }

  lines.push('## 0 定位');
  if (brief.thesis) lines.push(`**核心主张** ${brief.thesis}`);
  lines.push('');
  lines.push('**作者声称 / 支撑断言**');
  lines.push(bullets(brief.claims));
  lines.push('');
  lines.push('**支撑证据**');
  lines.push(bullets(brief.evidence));
  lines.push('');
  lines.push('**隐含前提**');
  lines.push(bullets(brief.assumptions));
  lines.push('');

  if (brief.quotes?.length) {
    lines.push('## 原文锚点');
    for (const quote of brief.quotes) {
      lines.push(`- \`${quote.id}\`${quote.loc ? ` (${quote.loc})` : ''} 「${quote.text}」`);
    }
    lines.push('');
  }

  lines.push('## 1 问题树');
  lines.push('```text');
  lines.push(renderTree(state).split('\n').slice(3).join('\n').trim());
  lines.push('```');
  lines.push('');

  lines.push('## 2 分层追问');
  for (const layer of layers) {
    lines.push(renderLayer(layer));
    lines.push('');
  }

  lines.push('## 3 弱点与未证前提');
  lines.push(bullets(weak));
  lines.push('');

  lines.push('## 4 仍开放的追问');
  lines.push(bullets(residual, '（已收敛：所有分支都通过了审辨）'));
  const next = layers.at(-1)?.critique?.nextCandidates ?? [];
  if (next.length > 0) lines.push(`\n下一层候选算子：${next.map(opName).join(' / ')}`);
  lines.push('');

  lines.push('## 5 现实科研问题');
  if ((state.problems ?? []).length === 0) {
    lines.push('（还没有提炼。调用 inquiry_problems 从这份材料里挖出可动手的科研问题。）');
  } else {
    for (const [index, problem] of state.problems.entries()) {
      lines.push(`### P${index + 1} · ${problemKindLabel(problem.kind)} · ${problem.title}`);
      if (problem.statement) lines.push(`**问题** ${problem.statement}`);
      if (problem.whyReal) lines.push(`**为什么是真问题** ${problem.whyReal}`);
      if (problem.evidence) lines.push(`**材料依据** ${problem.evidence}`);
      if (problem.novelty) lines.push(`**与作者的关系** ${problem.novelty}`);
      if (problem.firstStep) lines.push(`**最小验证** ${problem.firstStep}`);
      lines.push(`**风险** ${problem.risk || '（未写）'} · **难度** ${problem.difficulty}`);
      lines.push('');
    }
  }
  lines.push('');

  if (state.summary) {
    lines.push('## 6 合成判断');
    if (state.summary.strongest) lines.push(`**最有力的证据 / 最脆弱的环节** ${state.summary.strongest}`);
    if (state.summary.unresolved) lines.push(`\n**最值得继续追的问题** ${state.summary.unresolved}`);
    if (state.summary.nextAction) lines.push(`\n**一个 1 天内能做完的验证动作** ${state.summary.nextAction}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('由 inquiry-ladder 生成。每层问题由上一层答案的弱点触发；答案标注 E1 原文实测 / E2 原文推理 / E3 领域常识 / E4 推测。');
  return lines.join('\n');
}

/** Bounded model-facing summary of one finished layer (~400 tokens). */
export function renderLayerDigest(state, layer) {
  const next = layer.critique?.nextCandidates ?? [];
  const lines = [];
  lines.push(`LAYER L${layer.index} · ${opName(layer.operator)} · verdict ${layer.critique?.verdict ?? '?'} · 累计 ${state.usage?.calls ?? 0} calls · ${state.usage?.tokens ?? 0} tok`);
  lines.push('');
  lines.push(`Q${layer.index}.1 ${layer.question}`);
  if (layer.subQuestions?.length) {
    for (const sub of layer.subQuestions) lines.push(`     · ${sub}`);
  }
  const graded = /\[E[1-4][^\]]*\]/u.test(String(layer.answer ?? ''));
  lines.push(`A${layer.index}.1 ${layer.answer}${graded ? '' : ' [未标证据等级]'}`);
  if (layer.unsure?.length) lines.push(`     答不出：${layer.unsure.join('；')}`);
  const critique = layer.critique ?? {};
  if (critique.weakPoints?.length) {
    lines.push(`C${layer.index}.1 ${critique.weakPoints.map((point) => point.point).join('；')}`);
  }
  if (critique.alternative) lines.push(`     替代解释：${critique.alternative}`);
  if (critique.counterexample) lines.push(`     反例：${critique.counterexample}`);
  if (critique.residual?.length) lines.push(`残留  ${critique.residual.join('；')}`);
  lines.push(`裁决  ${layer.decision?.reason ?? ''}`);
  if (next.length > 0) lines.push(`下一层候选  ${next.map(opName).join(' / ')}`);
  lines.push('');
  lines.push(`树：${renderTree(state).split('\n').slice(3).join('\n').trim()}`);
  return lines.join('\n');
}


/** Bounded text for the `inquiry_problems` tool result (~600 tokens). */
export function renderProblemsText(state) {
  const problems = state.problems ?? [];
  const lines = [];
  lines.push(`RESEARCH PROBLEMS · ${problems.length} 条 · ${state.usage?.calls ?? 0} calls · ${state.usage?.tokens ?? 0} tok`);
  lines.push('');
  for (const [index, problem] of problems.entries()) {
    lines.push(`P${index + 1} [${problemKindLabel(problem.kind)}] ${problem.title}`);
    if (problem.statement) lines.push(`   问题  ${problem.statement}`);
    if (problem.whyReal) lines.push(`   为什么真  ${problem.whyReal}`);
    if (problem.evidence) lines.push(`   依据  ${problem.evidence}`);
    if (problem.novelty) lines.push(`   与作者  ${problem.novelty}`);
    if (problem.firstStep) lines.push(`   最小实验  ${problem.firstStep}`);
    lines.push(`   风险  ${problem.risk || '（未写）'} · 难度 ${problem.difficulty}`);
    lines.push('');
  }
  lines.push('继续：inquiry_report 把问题写进报告；或 inquiry_problems 换 focus 再挖一轮。');
  return lines.join('\n');
}
