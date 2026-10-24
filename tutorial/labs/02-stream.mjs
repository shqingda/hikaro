// 第 2 章实验：流式解码 + 最小 SSE 解析器 + Provider 事件适配。
// 运行：node --test labs/02-stream.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

// 把任意切分的字节块变成 SSE 事件（只处理 data 行，够本章用）
export async function* parseSSE(chunks) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true }); // 汉字被切开时，残缺字节留到下次
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) { // 空行 = 一个事件结束
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
  buffer += decoder.decode(); // 收尾：仍有残缺字节会抛错
  if (buffer.trim()) throw Error('Stream ended inside an event');
}

// 把“厂商事件”翻译成 Hikaro 风格的 ProviderEvent
export async function* adapt(vendorEvents) {
  for await (const e of vendorEvents) {
    if (e.type === 'text_delta') yield { type: 'text', text: e.delta };
    else if (e.type === 'error') throw Error(e.message);
    else if (e.type === 'done') {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          text: e.message.content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
          toolCalls: e.message.content.filter((c) => c.type === 'toolCall').map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
          providerData: e.message,
        },
        usage: e.usage,
      };
    }
  }
}

// 测试工具：把字符串编码后在给定字节位置切开
function splitBytes(text, cuts) {
  const bytes = new TextEncoder().encode(text);
  const points = [0, ...cuts, bytes.length];
  return points.slice(0, -1).map((p, i) => bytes.subarray(p, points[i + 1]));
}
async function* from(list) { for (const x of list) yield x; }
async function collect(iter) { const out = []; for await (const x of iter) out.push(x); return out; }

test('练习 1：不用 stream 模式逐块解码，汉字会坏', () => {
  const [a, b] = splitBytes('你好', [2]);
  const naive = new TextDecoder().decode(a) + new TextDecoder().decode(b);
  assert.notEqual(naive, '你好');
  const d = new TextDecoder();
  assert.equal(d.decode(a, { stream: true }) + d.decode(b), '你好');
});

const SSE =
  'data: {"type":"text_delta","delta":"你"}\n\n' +
  'data: {"type":"text_delta","delta":"好"}\n\n' +
  'data: {"type":"done","message":{"content":[{"type":"text","text":"你好"},{"type":"toolCall","id":"c1","name":"read_file","arguments":{"path":"a"}}]},"usage":{"input":3,"output":2,"cost":0.01}}\n\n';

test('任意字节切点都解析出同样的三个事件', async () => {
  const total = new TextEncoder().encode(SSE).length;
  const expected = await collect(parseSSE(from([new TextEncoder().encode(SSE)])));
  assert.equal(expected.length, 3);
  for (let cut = 1; cut < total; cut++) {
    const events = await collect(parseSSE(from(splitBytes(SSE, [cut]))));
    assert.deepEqual(events, expected, `cut at byte ${cut}`);
  }
});

test('一块里有多个事件，也全部切出来', async () => {
  const events = await collect(parseSSE(from(splitBytes(SSE, []))));
  assert.deepEqual(events.map((e) => e.type), ['text_delta', 'text_delta', 'done']);
});

test('流在事件中途结束：报错，而不是悄悄丢掉', async () => {
  await assert.rejects(collect(parseSSE(from(splitBytes('data: {"type":"te', [])))), /Stream ended inside an event/);
});

test('适配器：增量只给显示，工具调用只在 done 里', async () => {
  const out = await collect(adapt(parseSSE(from(splitBytes(SSE, [7, 40])))));
  assert.deepEqual(out.slice(0, 2), [{ type: 'text', text: '你' }, { type: 'text', text: '好' }]);
  const done = out[2];
  assert.equal(done.message.text, '你好');
  assert.deepEqual(done.message.toolCalls, [{ id: 'c1', name: 'read_file', arguments: { path: 'a' } }]);
  assert.ok(done.message.providerData, '原始消息原样保留，供下次请求使用');
  assert.equal(done.usage.cost, 0.01);
});

test('厂商 error 事件变成异常', async () => {
  await assert.rejects(collect(adapt(from([{ type: 'error', message: 'rate limited' }]))), /rate limited/);
});
