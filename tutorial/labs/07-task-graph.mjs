// 第 7 章实验：任务图调度。
// originalRunTaskGraph 照搬 Hikaro packages/core/src/task-graph.ts 的主循环（去掉类型），
// 用来复现“乱序输入 + 依赖失败”时的误报；runTaskGraph 是加了“进展判断”的修正版。
// 运行：node --test labs/07-task-graph.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

function validate(nodes, concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw Error('Concurrency must be a positive integer');
  const pending = new Map(nodes.map((n) => [n.id, n]));
  if (pending.size !== nodes.length) throw Error('Duplicate task ID');
  for (const n of nodes) for (const d of n.dependsOn) if (!pending.has(d)) throw Error(`Missing dependency: ${d}`);
  const visiting = new Set(), visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw Error('Task graph has a dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const d of pending.get(id).dependsOn) visit(d);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of pending.keys()) visit(id);
  return pending;
}

function startWork(id, node, execute, done, failures, running) {
  const work = execute(node, Object.fromEntries(node.dependsOn.map((d) => [d, done.get(d)])))
    .then((r) => { done.set(id, r); }, (e) => { failures.set(id, e); })
    .finally(() => { running.delete(id); });
  running.set(id, work);
}

export async function originalRunTaskGraph(nodes, concurrency, execute, signal) {
  const pending = validate(nodes, concurrency);
  const done = new Map(), running = new Map(), failures = new Map();
  while (pending.size || running.size) {
    signal.throwIfAborted();
    for (const [id, node] of pending) {
      if (running.size >= concurrency) break;
      if (node.dependsOn.some((d) => failures.has(d))) { pending.delete(id); failures.set(id, Error('Dependency failed')); continue; }
      if (!node.dependsOn.every((d) => done.has(d))) continue;
      pending.delete(id);
      startWork(id, node, execute, done, failures, running);
    }
    if (!running.size && pending.size) throw Error('Task graph has a dependency cycle');
    if (running.size) await Promise.race(running.values());
  }
  return { results: Object.fromEntries(done), failures: Object.fromEntries([...failures].map(([id, e]) => [id, String(e.message ?? e)])) };
}

export async function runTaskGraph(nodes, concurrency, execute, signal) {
  const pending = validate(nodes, concurrency);
  const done = new Map(), running = new Map(), failures = new Map();
  while (pending.size || running.size) {
    signal.throwIfAborted();
    let progressed = false;
    for (const [id, node] of pending) {
      if (running.size >= concurrency) break;
      if (node.dependsOn.some((d) => failures.has(d))) { pending.delete(id); failures.set(id, Error('Dependency failed')); progressed = true; continue; }
      if (!node.dependsOn.every((d) => done.has(d))) continue;
      pending.delete(id);
      startWork(id, node, execute, done, failures, running);
      progressed = true;
    }
    if (running.size) await Promise.race(running.values());
    else if (pending.size && !progressed) throw Error('Scheduler made no progress');
  }
  return { results: Object.fromEntries(done), failures: Object.fromEntries([...failures].map(([id, e]) => [id, String(e.message ?? e)])) };
}

const signal = () => new AbortController().signal;
const chainReversed = [
  { id: 'C', dependsOn: ['B'], task: '' },
  { id: 'B', dependsOn: ['A'], task: '' },
  { id: 'A', dependsOn: [], task: '' },
];
const failA = async (node) => { if (node.id === 'A') throw Error('A failed'); return node.id; };

test('复现 Hikaro 原版 bug：无环的 C→B→A，A 失败时被误报为依赖环', async () => {
  await assert.rejects(originalRunTaskGraph(chainReversed, 3, failA, signal()), /dependency cycle/);
});

test('同一张图换成 A、B、C 顺序，原版就正常', async () => {
  const r = await originalRunTaskGraph([...chainReversed].reverse(), 3, failA, signal());
  assert.deepEqual(Object.keys(r.failures).sort(), ['A', 'B', 'C']);
});

test('修正版：有进展就再扫一遍，失败一路传播到 C', async () => {
  const r = await runTaskGraph(chainReversed, 3, failA, signal());
  assert.deepEqual(r.failures, { A: 'A failed', B: 'Dependency failed', C: 'Dependency failed' });
});

test('练习 1：并发 2，inspect 和 test 先同时启动，report 最后', async () => {
  const order = [];
  let active = 0, peak = 0;
  const execute = async (node, deps) => {
    order.push(node.id);
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return node.id === 'report' ? Object.keys(deps).sort().join('+') : node.id;
  };
  const nodes = [
    { id: 'inspect', dependsOn: [], task: '' },
    { id: 'test', dependsOn: [], task: '' },
    { id: 'report', dependsOn: ['inspect', 'test'], task: '' },
  ];
  const r = await runTaskGraph(nodes, 2, execute, signal());
  assert.deepEqual(order, ['inspect', 'test', 'report']);
  assert.equal(peak, 2);
  assert.equal(r.results.report, 'inspect+test');
});

test('test 失败：report 不执行，独立分支照常完成', async () => {
  const ran = [];
  const nodes = [
    { id: 'inspect', dependsOn: [], task: '' },
    { id: 'test', dependsOn: [], task: '' },
    { id: 'report', dependsOn: ['inspect', 'test'], task: '' },
    { id: 'docs', dependsOn: [], task: '' },
  ];
  const r = await runTaskGraph(nodes, 2, async (n) => { ran.push(n.id); if (n.id === 'test') throw Error('red'); return n.id; }, signal());
  assert.equal(ran.includes('report'), false);
  assert.equal(r.failures.report, 'Dependency failed');
  assert.equal(r.results.docs, 'docs');
});

test('练习 2：依赖结果是 0 也算完成（用 has，不用 get 的真假）', async () => {
  const nodes = [{ id: 'zero', dependsOn: [], task: '' }, { id: 'next', dependsOn: ['zero'], task: '' }];
  const r = await runTaskGraph(nodes, 1, async (n, deps) => (n.id === 'zero' ? 0 : deps.zero + 1), signal());
  assert.equal(r.results.next, 1);
});

test('启动前校验：重复 id、缺失依赖、真正的环、并发为 0', async () => {
  const noop = async () => 1;
  await assert.rejects(runTaskGraph([{ id: 'a', dependsOn: [] }, { id: 'a', dependsOn: [] }], 1, noop, signal()), /Duplicate/);
  await assert.rejects(runTaskGraph([{ id: 'a', dependsOn: ['x'] }], 1, noop, signal()), /Missing dependency/);
  await assert.rejects(runTaskGraph([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }], 1, noop, signal()), /cycle/);
  await assert.rejects(runTaskGraph([{ id: 'a', dependsOn: [] }], 0, noop, signal()), /positive integer/);
});
