// End-to-end wiring check with a stubbed llm service: the real plugin entry,
// the real tool definitions, the real ledger and report writer — only the model
// is fake. Run with `node test/integration.mjs`.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';

const home = await mkdtemp(path.join(os.tmpdir(), 'inquiry-home-'));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'inquiry-cwd-'));
process.env.DSH_HOME = home;

const { apply } = await import('../index.js');

function reply(request) {
  const system = String(request.system ?? '');
  if (system.includes('证据骨架')) {
    return {
      title: '批处理论文（测试）',
      thesis: '批处理把 p99 延迟降低 40%',
      claims: ['合并请求摊薄排队开销', '批处理对尾部延迟更有利'],
      evidence: ['合成负载 p99 从 120ms 降到 72ms'],
      assumptions: ['各组缓存命中率相同'],
      quotes: [{ id: 'q1', text: 'we batch up to 32 requests', loc: '§4.2' }],
      open: ['批大小与合并收益是否可分离'],
    };
  }
  if (system.includes('苏格拉底')) {
    return {
      question: '论文把「延迟降低 40%」归因于批处理，但批大小同时从 1 改成 32——这两个变量怎么分离？（q1）',
      subQuestions: ['消融是否固定了缓存状态？'],
      anchors: ['q1'],
      why: '引用上一层「合并请求摊薄排队开销」',
    };
  }
  if (system.includes('应答者')) {
    return { answer: '原文只报告合并后的数字，未固定缓存状态 [E2]；连接复用也未控制 [E4]。', unsure: ['缓存命中率在各组的差异'] };
  }
  if (system.includes('审辨者')) {
    return {
      weakPoints: [{ point: '消融未固定缓存状态', why: '对照组不同', needs: 'cache-off 对照' }],
      alternative: '连接复用同样能产生差值',
      counterexample: '缓存全冷时收益消失',
      verdict: 'needs_more',
      residual: ['缓存状态未记录'],
      nextCandidates: ['evidence', 'boundary'],
    };
  }
  if (system.includes('合写者')) {
    return { verdict: '批处理的收益与批大小尚未分离 [E2]。', strongest: '最脆弱的是消融设计', unresolved: '缓存状态如何控制', nextAction: '跑一次 cache-off 对照' };
  }
  return { text: 'unexpected role' };
}

const seenSessionIds = [];

async function* stream(request) {
  seenSessionIds.push(request.sessionId);
  const value = reply(request);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  yield { type: 'block-start', index: 0, blockType: 'text' };
  const half = Math.ceil(text.length / 2);
  yield { type: 'text-delta', index: 0, text: text.slice(0, half) };
  yield { type: 'text-delta', index: 0, text: text.slice(half) };
  yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 180 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

const defs = new Map();
const ctx = {
  get(name) {
    if (name === 'llm') return { stream };
    return undefined;
  },
  inject(_deps, callback) {
    callback(ctx);
  },
  logger: { warn() {}, info() {} },
  tools: {
    register(definition) {
      defs.set(definition.name, definition);
      return () => defs.delete(definition.name);
    },
  },
};

apply(ctx, { maxDepth: 3, reportDir: 'inquiry', lang: 'zh' });

const exec = {
  agent: {
    session: { header: { cwd, id: 'sess_integration_test' } },
    model: { current: () => ({ provider: 'fake-provider', model: 'fake-model' }) },
  },
  signal: new AbortController().signal,
};

const call = async (name, args) => {
  const definition = defs.get(name);
  assert.ok(definition, `tool ${name} is registered`);
  const value = await definition.execute(args, exec);
  return value.text;
};

assert.ok(seenSessionIds.length === 0, 'no call before the first tool');
// Schema shape the model will receive.
const openSchema = defs.get('inquiry_open').parameters;
assert.equal(openSchema.type, 'object');
assert.ok(openSchema.properties.text);

const opened = await call('inquiry_open', {
  text: 'We batch up to 32 requests per server. Our system reduces p99 latency by 40% compared with the batch=1 baseline. We evaluate on a synthetic workload that keeps the cache warm across all runs, and connection reuse is enabled for every client. The ablation study only compares batch=1 with batch=32 and does not report a cache-off condition. We argue that the gain comes from amortising queueing overhead across the batch.',
  focus: '收益归因是否可分离',
});
assert.match(opened, /INQUIRY inq_/u);
assert.match(opened, /THESIS/u);
const inquiryId = /INQUIRY (inq_[a-z0-9_]+)/u.exec(opened)[1];

const first = await call('inquiry_probe', { inquiry_id: inquiryId });
assert.match(first, /LAYER L1/u);
assert.match(first, /拆解/u);
assert.match(first, /残留/u);

const second = await call('inquiry_probe', { inquiry_id: inquiryId, focus: '只盯消融' });
assert.match(second, /LAYER L2/u);

const third = await call('inquiry_probe', { inquiry_id: inquiryId });
assert.match(third, /LAYER L3/u);
assert.match(third, /已收敛|closed/u);

const tree = await call('inquiry_view', { inquiry_id: inquiryId });
assert.match(tree, /L1 拆解/u);
assert.match(tree, /L3/u);

const report = await call('inquiry_report', { inquiry_id: inquiryId });
const reportPath = /REPORT (.+)/u.exec(report)[1].trim();
const markdown = await readFile(reportPath, 'utf8');
for (const heading of ['# 追问报告', '## 0 定位', '## 1 问题树', '## 2 分层追问', '## 3 弱点与未证前提', '## 5 合成判断']) {
  assert.ok(markdown.includes(heading), `report missing ${heading}`);
}
assert.match(markdown, /q1/u);

const ledgerDir = path.join(home, 'inquiry', inquiryId);
const files = await readdir(ledgerDir);
assert.deepEqual(files.sort(), ['source.txt', 'state.json']);
const ledger = JSON.parse(await readFile(path.join(ledgerDir, 'state.json'), 'utf8'));
assert.equal(ledger.layers.length, 3);
assert.equal(ledger.status, 'closed');
assert.ok(ledger.usage.calls >= 9);

// A missing ledger must fail with guidance, not a stack trace.
assert.ok(seenSessionIds.every((id) => id === 'sess_integration_test'), 'every model call carries the session id');

const missing = await call('inquiry_view', { inquiry_id: 'inq_20260101_000000_zzzz' });
assert.match(missing, /找不到追问记录/u);

// A PDF path must point the caller at paper_brief instead of parsing bytes.
const pdf = await call('inquiry_open', { path: 'whatever.pdf' });
assert.match(pdf, /paper_brief/u);

console.log('integration ok');
console.log(`  report: ${reportPath}`);
console.log(`  layers: ${ledger.layers.length}, calls: ${ledger.usage.calls}, tokens: ${ledger.usage.tokens}`);
