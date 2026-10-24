// 第 4 章实验：整批注册、运行时校验、等待后复查、延迟展示不是授权。
// 运行：node --test labs/04-tools.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

export class ToolRegistry {
  tools = new Map();
  registerAll(tools) {
    const names = new Set();
    for (const tool of tools) {                     // 第一遍：只检查
      if (this.tools.has(tool.name) || names.has(tool.name)) throw Error(`Duplicate tool: ${tool.name}`);
      names.add(tool.name);
    }
    for (const tool of tools) this.tools.set(tool.name, tool); // 第二遍：写入
  }
  get(name) { return this.tools.get(name); }
  definitions() {
    return [...this.tools.values()].filter((t) => !t.deferred).map(({ name, description }) => ({ name, description }));
  }
  search(query) {
    const hits = [...this.tools.values()].filter((t) => (t.name + ' ' + t.description).toLowerCase().includes(query.toLowerCase())).slice(0, 12);
    for (const t of hits) t.deferred = false;
    return hits.map((t) => t.name);
  }
}

// 宿主侧调用入口：校验 → 构造 context → 执行
export async function invoke(registry, name, args, { signal, approve }) {
  signal.throwIfAborted();
  const tool = registry.get(name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  const parsed = tool.parse(args);
  if (!parsed.success) return { text: `Invalid arguments: ${parsed.error}`, isError: true };
  const ctx = {
    signal,
    checkpoint: async () => signal.throwIfAborted(),
    approve: async (reason) => {
      signal.throwIfAborted();          // 等待前查
      const ok = await approve(reason);
      signal.throwIfAborted();          // 等待后再查
      return ok;
    },
  };
  try {
    return await tool.execute(parsed.data, ctx);
  } catch (e) {
    if (signal.aborted) throw e;
    return { text: String(e.message ?? e), isError: true };
  }
}

function greetingTool(file) {
  return {
    name: 'replace_greeting',
    description: 'Replace the greeting when it still matches expected text.',
    calls: 0,
    parse(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { success: false, error: 'expected object' };
      if (typeof raw.expected !== 'string' || typeof raw.content !== 'string') return { success: false, error: 'expected and content must be strings' };
      return { success: true, data: { expected: raw.expected, content: raw.content } };
    },
    async execute({ expected, content }, ctx) {
      this.calls++;
      if (!(await ctx.approve('Replace greeting'))) throw Error('Permission denied');
      await ctx.checkpoint();
      if (file.text !== expected) throw Error('File changed; read it again');
      file.text = content;
      return { text: 'Replaced' };
    },
  };
}

const yes = async () => true;

test('练习 1：撞到已有名字，整批都不注册', () => {
  const r = new ToolRegistry();
  r.registerAll([{ name: 'read_file', description: '' }]);
  assert.throws(() => r.registerAll([{ name: 'new_tool', description: '' }, { name: 'read_file', description: '' }]), /Duplicate tool: read_file/);
  assert.equal(r.get('new_tool'), undefined);
});

test('同一批内部重名，同样整批拒绝', () => {
  const r = new ToolRegistry();
  assert.throws(() => r.registerAll([{ name: 'a', description: '' }, { name: 'a', description: '' }]));
  assert.equal(r.tools.size, 0);
});

for (const [label, args] of [['null', null], ['数组', []], ['字段类型错', { expected: 1, content: 'x' }]]) {
  test(`练习 2：参数不合法（${label}）→ 错误结果，execute 调用 0 次，文件不变`, async () => {
    const file = { text: 'Helo, Ada!' };
    const tool = greetingTool(file);
    const r = new ToolRegistry();
    r.registerAll([tool]);
    const result = await invoke(r, tool.name, args, { signal: new AbortController().signal, approve: yes });
    assert.equal(result.isError, true);
    assert.equal(tool.calls, 0);
    assert.equal(file.text, 'Helo, Ada!');
  });
}

test('审批拒绝：不写入', async () => {
  const file = { text: 'Helo, Ada!' };
  const r = new ToolRegistry();
  r.registerAll([greetingTool(file)]);
  const result = await invoke(r, 'replace_greeting', { expected: 'Helo, Ada!', content: 'Hello, Ada!' }, { signal: new AbortController().signal, approve: async () => false });
  assert.match(result.text, /Permission denied/);
  assert.equal(file.text, 'Helo, Ada!');
});

test('等审批期间用户取消：审批回来是“允许”，也不能写入', async () => {
  const file = { text: 'Helo, Ada!' };
  const r = new ToolRegistry();
  r.registerAll([greetingTool(file)]);
  const controller = new AbortController();
  let answer;
  const approve = () => new Promise((resolve) => { answer = resolve; });
  const pending = invoke(r, 'replace_greeting', { expected: 'Helo, Ada!', content: 'Hello, Ada!' }, { signal: controller.signal, approve });
  await Promise.resolve();
  controller.abort();   // 时刻 B：取消
  answer(true);         // 时刻 C：审批返回允许
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(file.text, 'Helo, Ada!');
});

test('expected 不符：拒绝覆盖别人刚做的修改', async () => {
  const file = { text: 'Helo, Lin!' };
  const r = new ToolRegistry();
  r.registerAll([greetingTool(file)]);
  const result = await invoke(r, 'replace_greeting', { expected: 'Helo, Ada!', content: 'Hello, Ada!' }, { signal: new AbortController().signal, approve: yes });
  assert.match(result.text, /File changed/);
  assert.equal(file.text, 'Helo, Lin!');
});

test('练习 3：deferred 只是不展示，按名字照样能调用', async () => {
  const r = new ToolRegistry();
  r.registerAll([
    { name: 'read_file', description: 'read', parse: (x) => ({ success: true, data: x }), execute: async () => ({ text: 'r' }) },
    { name: 'external_lookup', description: 'lookup issues', deferred: true, parse: (x) => ({ success: true, data: x }), execute: async () => ({ text: 'secret' }) },
  ]);
  assert.deepEqual(r.definitions().map((d) => d.name), ['read_file']);
  const hidden = await invoke(r, 'external_lookup', {}, { signal: new AbortController().signal, approve: yes });
  assert.equal(hidden.text, 'secret');
  assert.deepEqual(r.search('issues'), ['external_lookup']);
  assert.deepEqual(r.definitions().map((d) => d.name), ['read_file', 'external_lookup']);
});
