// 第 1 章实验：最小 Agent 循环。
// 用“剧本模型”代替真实模型：按顺序返回预设回复，不联网。
// 运行：node --test labs/01-agent-loop.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

// ---------- 工具注册表 ----------
// 简化版 schema：parse(raw) 成功返回 { success: true, data }，失败返回 { success: false, error }
function makeTools(files) {
  const tools = new Map();
  tools.set('read_file', {
    description: 'Read a text file.',
    parse(raw) {
      if (typeof raw?.path !== 'string') return { success: false, error: 'path must be a string' };
      const limit = raw.limit ?? 200; // 默认值：校验后才有
      if (!Number.isInteger(limit) || limit < 1) return { success: false, error: 'limit must be >= 1' };
      return { success: true, data: { path: raw.path, limit } };
    },
    async execute({ path, limit }) {
      if (!(path in files)) return { text: `No such file: ${path}`, isError: true };
      return { text: files[path].slice(0, limit), meta: { limit } };
    },
  });
  tools.set('edit_file', {
    description: 'Replace exactly one occurrence of oldText.',
    parse(raw) {
      if (typeof raw?.path !== 'string' || typeof raw?.oldText !== 'string' || typeof raw?.newText !== 'string')
        return { success: false, error: 'path, oldText, newText must be strings' };
      return { success: true, data: raw };
    },
    async execute({ path, oldText, newText }) {
      const old = files[path];
      if (old === undefined) return { text: 'File does not exist', isError: true };
      const index = old.indexOf(oldText);
      if (index < 0 || old.indexOf(oldText, index + 1) !== -1) return { text: 'Expected exactly one match', isError: true };
      files[path] = old.slice(0, index) + newText + old.slice(index + oldText.length);
      return { text: 'Edited' };
    },
  });
  return tools;
}

// ---------- invoke：把模型请求变成受控执行 ----------
export async function invoke(tools, name, args, stats) {
  const tool = tools.get(name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  const parsed = tool.parse(args);
  if (!parsed.success) return { text: `Invalid arguments: ${parsed.error}`, isError: true };
  stats.toolCalls++;
  return tool.execute(parsed.data); // 用校验后的数据，不用原始 args
}

// ---------- Agent 循环 ----------
export async function runAgent({ userText, model, tools, maxTurns = 8 }) {
  const history = [{ role: 'user', text: userText }];
  const stats = { modelCalls: 0, toolCalls: 0 };
  for (let turn = 0; turn < maxTurns; turn++) {
    stats.modelCalls++;
    const reply = await model(history);
    history.push(reply);
    if (!reply.toolCalls?.length) return { history, stats, status: 'completed' };
    for (const call of reply.toolCalls) {
      const result = await invoke(tools, call.name, call.arguments, stats);
      history.push({ role: 'tool', callId: call.id, name: call.name, text: result.text, isError: !!result.isError, meta: result.meta });
    }
  }
  throw Error('Turn limit reached');
}

// 剧本模型：每次调用返回下一条预设回复
function scriptedModel(replies) {
  let i = 0;
  return async () => {
    if (i >= replies.length) throw Error('script exhausted');
    return replies[i++];
  };
}

// ---------- 测试 ----------
test('完整修复流程：模型 3 次，工具 2 次', async () => {
  const files = { 'greeting.txt': 'Helo, Ada!\n' };
  const model = scriptedModel([
    { role: 'assistant', text: '', toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'greeting.txt' } }] },
    { role: 'assistant', text: '', toolCalls: [{ id: 'edit-1', name: 'edit_file', arguments: { path: 'greeting.txt', oldText: 'Helo', newText: 'Hello' } }] },
    { role: 'assistant', text: '已修复。' },
  ]);
  const { history, stats, status } = await runAgent({ userText: '修复拼写', model, tools: makeTools(files) });
  assert.equal(status, 'completed');
  assert.equal(files['greeting.txt'], 'Hello, Ada!\n');
  assert.deepEqual(stats, { modelCalls: 3, toolCalls: 2 });
  assert.equal(history.length, 6);
});

test('callId 把结果和调用一一对应（同一回复里调用两次同一个工具）', async () => {
  const files = { 'a.txt': 'A', 'b.txt': 'B' };
  const model = scriptedModel([
    { role: 'assistant', text: '', toolCalls: [
      { id: 'r1', name: 'read_file', arguments: { path: 'a.txt' } },
      { id: 'r2', name: 'read_file', arguments: { path: 'b.txt' } },
    ] },
    { role: 'assistant', text: 'done' },
  ]);
  const { history } = await runAgent({ userText: 'x', model, tools: makeTools(files) });
  const results = Object.fromEntries(history.filter((m) => m.role === 'tool').map((m) => [m.callId, m.text]));
  assert.deepEqual(results, { r1: 'A', r2: 'B' });
});

test('参数不合法：返回错误结果，不抛异常，不执行工具，循环继续', async () => {
  const files = { 'greeting.txt': 'Helo' };
  const model = scriptedModel([
    { role: 'assistant', text: '', toolCalls: [{ id: 'e1', name: 'edit_file', arguments: { path: 123 } }] },
    { role: 'assistant', text: '参数错了，放弃。' },
  ]);
  const { history, stats, status } = await runAgent({ userText: 'x', model, tools: makeTools(files) });
  assert.equal(status, 'completed');
  assert.equal(stats.toolCalls, 0);
  assert.equal(files['greeting.txt'], 'Helo');
  assert.match(history[2].text, /^Invalid arguments/);
  assert.equal(history[2].isError, true);
});

test('未知工具：同样作为错误结果写回历史', async () => {
  const model = scriptedModel([
    { role: 'assistant', text: '', toolCalls: [{ id: 'x1', name: 'rm_rf', arguments: {} }] },
    { role: 'assistant', text: 'ok' },
  ]);
  const { history } = await runAgent({ userText: 'x', model, tools: makeTools({}) });
  assert.equal(history[2].text, 'Unknown tool: rm_rf');
});

test('默认值：执行时用的是校验后的数据（练习 3：改成原始 args 会失败）', async () => {
  const files = { 'a.txt': 'x'.repeat(500) };
  const model = scriptedModel([
    { role: 'assistant', text: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'a.txt' } }] },
    { role: 'assistant', text: 'ok' },
  ]);
  const { history } = await runAgent({ userText: 'x', model, tools: makeTools(files) });
  assert.equal(history[2].meta.limit, 200);
  assert.equal(history[2].text.length, 200);
});

test('模型一直要求调用工具：到达轮数上限就停', async () => {
  const model = async () => ({ role: 'assistant', text: '', toolCalls: [{ id: crypto.randomUUID(), name: 'read_file', arguments: { path: 'a' } }] });
  await assert.rejects(runAgent({ userText: 'x', model, tools: makeTools({ a: '' }), maxTurns: 3 }), /Turn limit reached/);
});
