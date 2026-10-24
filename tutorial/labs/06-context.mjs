// 第 6 章实验：按 user 边界裁剪、找未配对的工具调用、SQLite 事务回滚。
// 需要支持 node:sqlite 的 Node.js（Node 26 可用）。数据库建在系统临时目录，结束后删除。
// 运行：node --test labs/06-context.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const bytes = (m) => new TextEncoder().encode(JSON.stringify(m)).length;

// 只在 user 消息处切，保证不留下“孤儿”工具结果
export function fitContext(messages, budget) {
  const size = (from) => messages.slice(from).reduce((n, m) => n + bytes(m), 0);
  let start = 0;
  for (let next = 1; next < messages.length && size(start) > budget; next++) {
    if (messages[next].role !== 'user') continue;
    start = next;
  }
  return { messages: messages.slice(start), omitted: start, overflow: size(start) > budget };
}

// 有调用、没结果的 callId
export function unresolvedCalls(messages) {
  const pending = new Map();
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) pending.set(c.id, c.name);
    if (m.role === 'tool' && m.callId) pending.delete(m.callId);
  }
  return [...pending].map(([id, name]) => ({ id, name, outcome: 'unknown' })); // 不返回 retry
}

const U = (t) => ({ role: 'user', text: t });
const A = (t, calls) => ({ role: 'assistant', text: t, ...(calls ? { toolCalls: calls } : {}) });
const T = (id, t) => ({ role: 'tool', callId: id, name: 'read_file', text: t });

test('练习 1：预算只够最后三条，也只能从 U2 切', () => {
  const history = [U('检查文件'), A('', [{ id: 'r1', name: 'read_file' }]), T('r1', 'x'.repeat(200)), A('结论'), U('再看一个'), A('好')];
  const lastThree = bytes(history[3]) + bytes(history[4]) + bytes(history[5]);
  const fit = fitContext(history, lastThree);
  assert.deepEqual(fit.messages.map((m) => m.text), ['再看一个', '好']);
  assert.equal(fit.omitted, 4);
  assert.equal(fit.overflow, false);
});

test('当前这一轮自己就超了：报 overflow，不假装装下', () => {
  const history = [U('x'.repeat(1000))];
  assert.equal(fitContext(history, 100).overflow, true);
});

test('练习 2：按 callId 配对，只标记真正缺结果的那次', () => {
  const history = [
    U('改两处'),
    A('', [{ id: 'e1', name: 'edit_file' }, { id: 'e2', name: 'edit_file' }]),
    { role: 'tool', callId: 'e1', name: 'edit_file', text: 'ok' },
  ];
  assert.deepEqual(unresolvedCalls(history), [{ id: 'e2', name: 'edit_file', outcome: 'unknown' }]);
});

test('练习 3：写入前崩溃和写入后崩溃，数据库看起来一样', () => {
  const record = [U('改配置'), A('', [{ id: 'w1', name: 'write_file' }])];
  const before = { file: 'A', history: structuredClone(record) };
  const after = { file: 'B', history: structuredClone(record) };
  assert.deepEqual(unresolvedCalls(before.history), unresolvedCalls(after.history));
  assert.notEqual(before.file, after.file); // 现场不同，所以不能自动重放
});

function openDb(dir) {
  const db = new DatabaseSync(join(dir, 'events.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT, type TEXT, data TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS heads (sessionId TEXT PRIMARY KEY, lastSeq INTEGER)');
  return db;
}

function append(db, sessionId, type, data, failAfterInsert = false) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO events (sessionId, type, data) VALUES (?, ?, ?)').run(sessionId, type, JSON.stringify(data));
    if (failAfterInsert) throw Error('injected failure');
    db.prepare('INSERT INTO heads VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET lastSeq = excluded.lastSeq').run(sessionId, Number(lastInsertRowid));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

test('事务：插入后注入错误，事件和 heads 一起回滚', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hikaro-lab-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(dir);
  append(db, 'A', 'message', { text: 'hi' });
  assert.throws(() => append(db, 'A', 'message', { text: 'lost' }, true), /injected/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
  assert.equal(db.prepare('SELECT lastSeq FROM heads WHERE sessionId = ?').get('A').lastSeq, 1);
  db.close();
});

test('游标分页：seq 全表递增，按 seq > 上次 读取，跳号是正常的', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hikaro-lab-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let db = openDb(dir);
  append(db, 'A', 'message', 1);
  append(db, 'B', 'message', 2);
  append(db, 'A', 'message', 3);
  db.close();
  db = openDb(dir); // 关闭重开：已提交的仍在
  const page = (after) => db.prepare('SELECT seq FROM events WHERE sessionId = ? AND seq > ? ORDER BY seq LIMIT 10').all('A', after).map((r) => r.seq);
  assert.deepEqual(page(0), [1, 3]);
  assert.deepEqual(page(1), [3]);
  db.close();
});
