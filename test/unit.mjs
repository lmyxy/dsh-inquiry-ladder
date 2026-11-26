// Pure-function checks. No model, no filesystem: run with `node test/unit.mjs`.
import assert from 'node:assert/strict';
import {
  chooseOperator,
  decide,
  hasAnchor,
  isRepeat,
  normalizeCritique,
  normalizeProblems,
  normalizeQuestion,
  problemKindLabel,
  similarity,
} from '../lib/ladder.js';
import { parseJsonLoose } from '../lib/engine.js';
import { params } from '../lib/params.js';
import { renderReport, renderTree, renderLayerDigest } from '../lib/report.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}\n${error.stack}`);
    process.exitCode = 1;
  }
};

test('operator: explicit request wins', () => {
  const { operator } = chooseOperator({ requested: 'evidence', history: [], depth: 1 });
  assert.equal(operator.id, 'evidence');
});

test('operator: repeated operator on a branch is refused', () => {
  const { operator } = chooseOperator({ requested: 'premise', history: ['premise'], depth: 3 });
  assert.notEqual(operator.id, 'premise');
});

test('operator: critic candidate used when no explicit request', () => {
  const { operator } = chooseOperator({ criticCandidates: ['boundary'], history: ['decompose'], depth: 2 });
  assert.equal(operator.id, 'boundary');
});

test('operator: ladder advances by depth (first probe layer is L1 拆解)', () => {
  assert.equal(chooseOperator({ history: [], depth: 1 }).operator.id, 'decompose');
  assert.equal(chooseOperator({ history: ['decompose'], depth: 2 }).operator.id, 'premise');
});

test('operator: climbs when the natural rung was already used', () => {
  const { operator, bent } = chooseOperator({ history: ['premise'], depth: 2 });
  assert.equal(operator.id, 'evidence');
  assert.equal(bent, true);
});

test('anchor: quoted source text counts, an unquoted question does not', () => {
  assert.equal(hasAnchor('论文声称「we batch up to 32 requests」(q3)，那么…'), true);
  assert.equal(hasAnchor('这篇论文的意义是什么'), false);
  assert.equal(hasAnchor('Does the 40% improve anything?'), false);
});

test('similarity and repeat detection', () => {
  assert.ok(similarity('the batching gain matters', 'the batching gain is real') > 0.4);
  assert.equal(isRepeat('这篇的贡献是什么', ['这篇的贡献到底是什么']), true);
  assert.equal(isRepeat('延迟下降的归因是否分离', ['评测基线是否公平']), false);
});

test('decide: no rival explanation blocks advancement', () => {
  const verdict = decide({
    critique: { verdict: 'pass', weakPoints: [], residual: [], alternative: '', counterexample: '' },
    depth: 1,
    settings: { maxDepth: 5, maxCalls: 20, maxTokens: 80000, strictAnchors: true },
    usage: { calls: 3, tokens: 1000 },
  });
  assert.equal(verdict.action, 'continue');
});

test('decide: residual keeps probing, then stops at the depth limit', () => {
  const critique = { verdict: 'needs_more', weakPoints: [], residual: ['缓存状态未记录'], alternative: '连接复用', counterexample: '' };
  const settings = { maxDepth: 3, maxCalls: 20, maxTokens: 80000, strictAnchors: true };
  assert.equal(decide({ critique, depth: 2, settings, usage: { calls: 6, tokens: 5000 } }).action, 'continue');
  assert.equal(decide({ critique, depth: 3, settings, usage: { calls: 9, tokens: 5000 } }).action, 'stop');
});

test('decide: budget stops even on a converged layer', () => {
  const critique = { verdict: 'pass', weakPoints: [], residual: [], alternative: 'x' };
  const settings = { maxDepth: 5, maxCalls: 4, maxTokens: 80000, strictAnchors: true };
  const verdict = decide({ critique, depth: 1, settings, usage: { calls: 4, tokens: 10 } });
  assert.equal(verdict.action, 'stop');
});

test('normalize: question and critique shapes survive bad input', () => {
  const question = normalizeQuestion({ question: '  q  ', subQuestions: ['a', '', 'b', 'c', 'd', 'e'], anchors: ['q1'] });
  assert.equal(question.question, 'q');
  assert.deepEqual(question.subQuestions, ['a', 'b', 'c', 'd']);

  const critique = normalizeCritique({
    weakPoints: ['没有对照', { point: '基线过旧', needs: '同期基线' }, { nope: 1 }],
    verdict: 'PASS',
    residual: ['x', ''],
    nextCandidates: ['evidence', 'made-up', 'boundary'],
  });
  assert.equal(critique.weakPoints.length, 2);
  assert.equal(critique.verdict, 'pass');
  assert.deepEqual(critique.residual, ['x']);
  assert.deepEqual(critique.nextCandidates, ['evidence', 'boundary']);
});

test('problems: kinds are whitelisted and slogans are dropped', () => {
  const problems = normalizeProblems({
    problems: [
      { title: '冷启动收益', kind: 'deployment', statement: '只在 warm cache 下测过', firstStep: 'cache-off 对照', difficulty: 'low' },
      { title: '更好的可解释性', kind: 'mechanism', statement: '短' },
      { title: '冷启动收益', kind: 'deployment', statement: '重复项' },
      { title: '奇怪类型', kind: 'made-up', statement: 'x', difficulty: 'extreme' },
    ],
  });
  assert.equal(problems.length, 2, 'slogan and near-duplicate dropped');
  assert.equal(problems[0].kind, 'deployment');
  assert.equal(problems[0].difficulty, 'low');
  assert.equal(problems[1].kind, 'assumption', 'unknown kind falls back');
  assert.equal(problems[1].difficulty, 'medium');
  assert.equal(problemKindLabel('deployment'), '部署假设不成立');
});

test('problems: a slogan with real substance is kept', () => {
  const problems = normalizeProblems({
    problems: [{ title: '更好的可解释性', statement: '在调度器里需要解释每个 batch 的排队归因，当前只有总量指标，无法定位到请求级别。' }],
  });
  assert.equal(problems.length, 1);
});

test('json: fenced and prose-wrapped objects are recovered', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('好的，结果如下：{"a":{"b":2}} 以上。'), { a: { b: 2 } });
  assert.equal(parseJsonLoose('完全不是 JSON'), undefined);
});

const fixture = {
  id: 'inq_20261126_130000_test',
  createdAt: '2026-11-26T05:00:00.000Z',
  source: { kind: 'text', chars: 12000, truncated: false },
  settings: { maxDepth: 5, lang: 'zh' },
  usage: { calls: 7, tokens: 12345 },
  status: 'open',
  brief: {
    title: 'A batching paper',
    thesis: '批处理把延迟降低 40%',
    claims: ['合并请求可以摊薄排队开销'],
    evidence: ['合成负载 p99 从 120ms 降到 72ms'],
    assumptions: ['缓存命中率在各组间相同'],
    quotes: [{ id: 'q1', text: 'we batch up to 32 requests', loc: '§4.2' }],
    open: ['批大小与合并收益是否可分离'],
  },
  layers: [
    {
      index: 1,
      operator: 'decompose',
      question: '论文把「延迟降低 40%」归因于批处理，但批大小同时从 1 改成 32——「we batch up to 32 requests」(q1)，两个变量怎么分离？',
      why: '引用 L1 的「合并请求摊薄排队开销」',
      answer: '原文只报告合并后的数字 [E2]。',
      unsure: ['连接复用未被控制'],
      critique: {
        weakPoints: [{ point: '消融未固定缓存状态', why: '对照组不同', needs: 'cache-off 对照' }],
        alternative: '连接复用也能产生同样差值',
        counterexample: '缓存全冷时收益消失',
        verdict: 'needs_more',
        residual: ['缓存状态未记录'],
        nextCandidates: ['evidence', 'boundary'],
      },
      decision: { action: 'continue', reason: '仍有 1 个残留疑问' },
      calls: 3,
      tokens: { inputTokens: 4000, outputTokens: 700 },
    },
  ],
};

test('params: compiles the compact form into real JSON Schema', () => {
  const schema = params({
    inquiry_id: { type: 'string', required: true, description: 'id' },
    operator: { type: 'string', enum: ['evidence', 'boundary'] },
    auto: { type: 'boolean' },
  });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['inquiry_id']);
  assert.equal(schema.properties.inquiry_id.type, 'string');
  assert.equal(schema.properties.inquiry_id.required, undefined);
  assert.deepEqual(schema.properties.operator.enum, ['evidence', 'boundary']);
  assert.equal(schema.additionalProperties, false);

  const optionalOnly = params({ text: { type: 'string' } });
  assert.equal(optionalOnly.required, undefined);
});

test('report: tree carries the operator label and the verdict', () => {
  const tree = renderTree(fixture);
  assert.match(tree, /L1 拆解 Decompose/u);
  assert.match(tree, /待追/u);
  assert.match(tree, /残留疑问/u);
});

test('report: full report has every required section', () => {
  const report = renderReport(fixture);
  for (const heading of ['# 追问报告', '## 0 定位', '## 原文锚点', '## 1 问题树', '## 2 分层追问', '## 3 弱点与未证前提', '## 4 仍开放的追问']) {
    assert.ok(report.includes(heading), `missing ${heading}`);
  }
  assert.match(report, /q1.*we batch up to 32 requests/u);
});

test('digest: a graded answer is not marked as ungraded', () => {
  const graded = renderLayerDigest(fixture, fixture.layers[0]);
  assert.ok(!graded.includes('未标证据等级'), 'graded answer must not be flagged');
  const ungraded = renderLayerDigest(fixture, { ...fixture.layers[0], answer: '这段回答没有任何证据标注。' });
  assert.ok(ungraded.includes('未标证据等级'), 'ungraded answer must be flagged');
});

test('report: layer digest stays bounded', () => {
  const digest = renderLayerDigest(fixture, fixture.layers[0]);
  assert.ok(digest.length < 1400, `digest too long: ${digest.length}`);
  assert.match(digest, /LAYER L1/u);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
