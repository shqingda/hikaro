// 第 3 章实验：队列 + 单消费者 + 插话 + 取消 + 调用预算。
// 运行：node --test labs/03-runner.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

// 一扇可以手动打开的“门”：让测试精确控制任务什么时候结束
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

export class Runner {
  queue = [];
  steering = [];
  draining = false;
  controller;
  log = [];
  budget = { modelCallsLeft: Infinity };

  // work(text, signal, runner) 代表一次 Run
  constructor(work) { this.work = work; }

  prompt(text) {
    if (this.queue.length >= 32) throw Error('Prompt queue is full');
    return new Promise((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      void this.drain();
    });
  }

  steer(text) {
    if (this.steering.length >= 16) throw Error('Steering queue is full');
    this.steering.push(text);
  }

  // 每轮开头调用：一次取走所有插话
  takeSteering() { return this.steering.splice(0); }

  // 请求模型前调用：先检查，再扣减，中间没有 await
  takeModelCall() {
    if (this.budget.modelCallsLeft <= 0) throw Error('Shared model-call budget exhausted');
    this.budget.modelCallsLeft--;
  }

  async drain() {
    if (this.draining) return;
    this.draining = true; // 先占位，再 await
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        this.controller = new AbortController();
        try {
          this.log.push(`start ${item.text}`);
          await this.work(item.text, this.controller.signal, this);
          this.log.push(`end ${item.text}`);
          item.resolve();
        } catch (e) {
          this.log.push(`fail ${item.text}`);
          item.reject(e);
        } finally {
          this.controller = undefined;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  cancel() {
    this.controller?.abort();
    for (const item of this.queue.splice(0)) item.reject(new DOMException('Cancelled', 'AbortError'));
    this.steering = [];
    // 注意：不在这里设 draining = false，旧 Run 还没退场
  }

  get busy() { return this.draining; }
}

test('两个任务不重叠：A 结束前 B 不开始', async () => {
  const doors = { A: gate(), B: gate() };
  const runner = new Runner((text) => doors[text].promise);
  const a = runner.prompt('A');
  const b = runner.prompt('B');
  await Promise.resolve();
  assert.deepEqual(runner.log, ['start A']);
  assert.equal(runner.queue.length, 1);
  doors.A.open();
  await a;
  doors.B.open();
  await b;
  assert.deepEqual(runner.log, ['start A', 'end A', 'start B', 'end B']);
});

test('调用者等到的是执行结果，不是“已入队”', async () => {
  const door = gate();
  const runner = new Runner(() => door.promise);
  let settled = false;
  const p = runner.prompt('A').then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settled, false);
  door.open();
  await p;
  assert.equal(settled, true);
});

test('A 失败只影响 A，B 照样执行', async () => {
  const runner = new Runner(async (text) => { if (text === 'A') throw Error('boom'); });
  const a = runner.prompt('A');
  const b = runner.prompt('B');
  await assert.rejects(a, /boom/);
  await b;
  assert.deepEqual(runner.log, ['start A', 'fail A', 'start B', 'end B']);
});

test('插话：在下一轮开头一次取走，不会重复消费', async () => {
  const seen = [];
  const door = gate();
  const runner = new Runner(async (_text, _signal, r) => {
    seen.push(r.takeSteering());   // 第 1 轮
    await door.promise;
    seen.push(r.takeSteering());   // 第 2 轮
    seen.push(r.takeSteering());   // 第 3 轮
  });
  const p = runner.prompt('A');
  await Promise.resolve();
  runner.steer('别改公共接口');
  door.open();
  await p;
  assert.deepEqual(seen, [[], ['别改公共接口'], []]);
});

test('取消：排队的直接拒绝；正在跑的收到信号，收尾前仍然 busy', async () => {
  const finish = gate();
  let sideEffects = 0;
  const runner = new Runner(async (text, signal) => {
    if (text !== 'A') return;
    sideEffects++;                 // 取消前已经发生的副作用
    await finish.promise;          // 故意不理 signal，稍后才返回
    signal.throwIfAborted();       // 回来后检查：不接受迟到的成功
  });
  const a = runner.prompt('A');
  const b = runner.prompt('B');
  await Promise.resolve();
  runner.cancel();
  await assert.rejects(b, { name: 'AbortError' });
  assert.equal(runner.busy, true, '旧 Run 还没退场');
  finish.open();
  await assert.rejects(a, { name: 'AbortError' });
  assert.equal(runner.busy, false);
  assert.equal(sideEffects, 1, '结果被拒绝，但副作用已经发生');
});

test('共享预算：先检查再扣减，最后一个名额只给一个人', () => {
  const runner = new Runner(async () => {});
  runner.budget.modelCallsLeft = 1;
  runner.takeModelCall();
  assert.throws(() => runner.takeModelCall(), /budget exhausted/);
  assert.equal(runner.budget.modelCallsLeft, 0, '拒绝后不会变成负数');
});

test('反例（练习 3）：检查和扣减之间隔着 await，两个子 Agent 都通过了检查', async () => {
  const budget = { modelCallsLeft: 1 };
  async function racyTake() {
    if (budget.modelCallsLeft <= 0) throw Error('exhausted');
    await Promise.resolve();        // 中间让出执行权
    budget.modelCallsLeft--;
  }
  await Promise.all([racyTake(), racyTake()]);
  assert.equal(budget.modelCallsLeft, -1);
});
