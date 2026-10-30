// 第 8 章实验：JSONL 分帧、命令回执、会骗人的测试。
// 运行：node --test labs/08-reliability.mjs
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

// ---------- 8.2 JSONL ----------
export class JsonLines {
  buffer = '';
  decoder = new TextDecoder('utf-8', { fatal: true });
  constructor(receive, maxBytes = 1_048_576) { this.receive = receive; this.maxBytes = maxBytes; }
  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line) > this.maxBytes) throw Error('Protocol frame too large');
      if (line) this.receive(JSON.parse(line));
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw Error('Protocol frame too large');
  }
  // 教学新增：流结束时还有半行，就是不完整的消息
  finish() {
    this.buffer += this.decoder.decode();
    if (this.buffer) throw Error('Stream ended without a line break');
  }
}

const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

export class Receipts {
  rows = new Map();
  constructor(hostInstanceId) { this.hostInstanceId = hostInstanceId; }
  get(id) {
    const r = this.rows.get(id);
    if (!r) return null;
    // 记录它的是另一个宿主实例（宿主重启过），accepted 状态就不能再信
    if (r.status === 'accepted' && r.hostInstanceId !== this.hostInstanceId) return { ...r, status: 'unknown' };
    return r;
  }
  accept(id, payload) {
    const existing = this.get(id);
    if (existing) {
      if (existing.digest !== digest(payload)) throw Error('Command ID payload conflict');
      return { inserted: false, receipt: existing };
    }
    const r = { id, digest: digest(payload), hostInstanceId: this.hostInstanceId, status: 'accepted' };
    this.rows.set(id, r);
    return { inserted: true, receipt: r };
  }
  settle(id, status) { this.rows.get(id).status = status; }
}

// 执行一个带副作用的命令：先登记，再做，最后写结果；写结果失败就保守标 unknown
export function execute(receipts, id, payload, file, { failReceipt = false, allowed = true } = {}) {
  const { inserted, receipt } = receipts.accept(id, payload);
  if (!inserted) return receipt;
  if (!allowed) { receipts.settle(id, 'rejected'); return receipts.get(id); }
  file.text = payload.content;
  file.writes++;
  try {
    if (failReceipt) throw Error('disk full');
    receipts.settle(id, 'completed');
  } catch {
    receipts.settle(id, 'unknown');
  }
  return receipts.get(id);
}

// ---------- 测试 ----------
test('JSONL：中文在每一个字节处切开，都解析出同样的两条命令', () => {
  const text = '{"id":"q1","method":"prompt","params":{"text":"你好"}}\n{"id":"q2","method":"cancel"}\n';
  const bytes = new TextEncoder().encode(text);
  for (let cut = 1; cut < bytes.length; cut++) {
    const got = [];
    const lines = new JsonLines((m) => got.push(m.id));
    lines.push(bytes.subarray(0, cut));
    lines.push(bytes.subarray(cut));
    lines.finish();
    assert.deepEqual(got, ['q1', 'q2'], `cut ${cut}`);
  }
});

test('练习 1：合法 JSON 但没有换行，不交付', () => {
  const got = [];
  const lines = new JsonLines((m) => got.push(m));
  lines.push(new TextEncoder().encode('{"id":"q1"}'));
  assert.equal(got.length, 0);
  assert.throws(() => lines.finish(), /without a line break/);
});

test('JSONL：超过单帧上限就断开，不无限等', () => {
  const lines = new JsonLines(() => {}, 16);
  assert.throws(() => lines.push(new TextEncoder().encode('{"x":"' + 'a'.repeat(100))), /too large/);
});

test('回执：同 id 同内容到达两次，只执行一次', () => {
  const receipts = new Receipts('host-1');
  const file = { text: 'old', writes: 0 };
  execute(receipts, 'cmd-1', { content: 'new' }, file);
  const second = execute(receipts, 'cmd-1', { content: 'new' }, file);
  assert.equal(second.status, 'completed');
  assert.equal(file.writes, 1);
});

test('回执：同 id 不同内容，报冲突', () => {
  const receipts = new Receipts('host-1');
  const file = { text: 'old', writes: 0 };
  execute(receipts, 'cmd-1', { content: 'new' }, file);
  assert.throws(() => execute(receipts, 'cmd-1', { content: 'other' }, file), /payload conflict/);
  assert.equal(file.writes, 1);
});

test('没有权限：副作用为 0', () => {
  const receipts = new Receipts('host-1');
  const file = { text: 'old', writes: 0 };
  assert.equal(execute(receipts, 'cmd-1', { content: 'new' }, file, { allowed: false }).status, 'rejected');
  assert.equal(file.writes, 0);
  assert.equal(file.text, 'old');
});

test('练习 3：文件已改，回执写失败 → unknown；重发同 id 也不会再执行', () => {
  const receipts = new Receipts('host-1');
  const file = { text: 'old', writes: 0 };
  assert.equal(execute(receipts, 'cmd-1', { content: 'new' }, file, { failReceipt: true }).status, 'unknown');
  assert.equal(file.text, 'new');
  execute(receipts, 'cmd-1', { content: 'new' }, file);
  assert.equal(file.writes, 1);
});

test('宿主重启后，上一个实例留下的 accepted 报告为 unknown', () => {
  const before = new Receipts('host-1');
  before.accept('cmd-1', { content: 'x' });
  const after = new Receipts('host-2');
  after.rows = before.rows;
  assert.equal(after.get('cmd-1').status, 'unknown');
});

test('会骗人的测试：参数先抛错，被测函数根本没被调用', () => {
  let calls = 0;
  function receive() { calls++; throw Error('auth failed'); }
  function hello() { throw Error('already started'); }
  assert.throws(() => receive(hello()));   // 通过了
  assert.equal(calls, 0);                   // 但什么也没测到
  // 更好的写法：在断言外准备输入，只把目标调用放进断言，并检查具体原因
  const input = 'valid-hello';
  assert.throws(() => receive(input), /auth failed/);
  assert.equal(calls, 1);
});

test('缺失成本不当 0；成功 = completed 且已独立验证', () => {
  const runs = [
    { id: randomUUID(), status: 'completed', verified: true, cost: 0.2 },
    { id: randomUUID(), status: 'completed', verified: false, cost: 0 },
    { id: randomUUID(), status: 'unknown', verified: false, cost: null },
  ];
  const success = runs.filter((r) => r.status === 'completed' && r.verified).length;
  const known = runs.filter((r) => r.cost !== null);
  assert.equal(success, 1);
  assert.equal(known.length, 2);
  assert.equal(runs.length - known.length, 1);
});
