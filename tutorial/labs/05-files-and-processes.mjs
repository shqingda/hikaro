// 第 5 章实验：路径判断、修改前提检查、真实子进程的停止升级。
// 子进程只运行本文件自身（固定参数），不执行任意命令，不读你的项目。
// 运行：node --test labs/05-files-and-processes.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute, posix } from 'node:path';
import test from 'node:test';

// ---------- 子进程模式：被自己以 `node 本文件 --child <mode>` 启动 ----------
if (process.argv[2] === '--child') {
  const mode = process.argv[3];
  if (mode === 'echo') {
    process.stdout.write(process.argv[4] + '\n');
  } else if (mode === 'split-utf8') {
    const bytes = Buffer.from('你好');
    process.stdout.write(bytes.subarray(0, 2));
    setTimeout(() => process.stdout.write(bytes.subarray(2)), 20);
  } else if (mode === 'ignore-term') {
    process.on('SIGTERM', () => {});  // 故意忽略礼貌的停止请求
    process.stdout.write('READY\n');
    setInterval(() => {}, 1000);
  }
} else {
  runTests();
}

// ---------- 5.1 路径判断 ----------
export function inside(root, path) {
  const rel = posix.relative(root, path);
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel));
}

// ---------- 5.4 修改前提 ----------
export function writeFile(files, path, expected, content) {
  const current = files[path];
  if (current !== undefined && expected !== current) throw Error('File changed or expected content missing. Read it before replacing.');
  files[path] = content;
}
export function editFile(files, path, oldText, newText) {
  const old = files[path];
  if (old === undefined) throw Error('File does not exist');
  const index = old.indexOf(oldText);
  if (index < 0 || old.indexOf(oldText, index + 1) !== -1) throw Error('Expected exactly one match');
  files[path] = old.slice(0, index) + newText + old.slice(index + oldText.length);
}

// ---------- 5.6–5.8 运行子进程 ----------
const self = fileURLToPath(import.meta.url);
export function run(mode, args = []) {
  const child = spawn(process.execPath, [self, '--child', mode, ...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); // 流式解码：汉字被切开也不乱码
  let out = '';
  const ready = new Promise((resolve) => child.stdout.on('data', (s) => { out += s; if (out.includes('READY')) resolve(); }));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, ready, exited, output: () => out };
}

// 先 SIGTERM，等不到就 SIGKILL，再等不到就报错
export async function stop(child, exited, termWaitMs = 300, killWaitMs = 2000) {
  const wait = (ms) => Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
  child.kill('SIGTERM');
  if (await wait(termWaitMs)) return 'SIGTERM';
  child.kill('SIGKILL');
  if (await wait(killWaitMs)) return 'SIGKILL';
  throw Error('Process termination could not be confirmed; retry stop');
}

function runTests() {
  test('练习 1：startsWith 会把兄弟目录认错，relative 不会', () => {
    assert.equal('/work/application/key.txt'.startsWith('/work/app'), true);
    assert.equal(inside('/work/app', '/work/application/key.txt'), false);
    assert.equal(inside('/work/app', '/work/app'), true);
    assert.equal(inside('/work/app', '/work/app/src/a.ts'), true);
    assert.equal(inside('/work/app', '/work/app/../secret'), false);
  });

  test('write_file：文件被别人改过，拒绝覆盖', () => {
    const files = { 'g.txt': 'Helo, Lin!' };
    assert.throws(() => writeFile(files, 'g.txt', 'Helo, Ada!', 'Hello, Ada!'), /File changed/);
    assert.equal(files['g.txt'], 'Helo, Lin!');
  });

  test('练习 2：A→B→A，只比内容发现不了中间的修改', () => {
    const files = { 'g.txt': 'A' };
    const seen = files['g.txt'];
    files['g.txt'] = 'B';
    files['g.txt'] = 'A';
    assert.doesNotThrow(() => writeFile(files, 'g.txt', seen, 'C'));
  });

  test('edit_file：0 处、多处（含重叠）都拒绝', () => {
    assert.throws(() => editFile({ f: 'abc' }, 'f', 'x', 'y'), /exactly one/);
    assert.throws(() => editFile({ f: 'a a' }, 'f', 'a', 'b'), /exactly one/);
    assert.throws(() => editFile({ f: 'aaa' }, 'f', 'aa', 'b'), /exactly one/);
    const files = { f: 'Helo, Ada!' };
    editFile(files, 'f', 'Helo', 'Hello');
    assert.equal(files.f, 'Hello, Ada!');
  });

  test('参数数组：分号只是普通文字，不会被 shell 解释', async () => {
    const p = run('echo', ['hello; echo injected']);
    await p.exited;
    assert.equal(p.output(), 'hello; echo injected\n');
  });

  test('输出把汉字切成两块到达，setEncoding 后拼出来仍正确', async () => {
    const p = run('split-utf8');
    await p.exited;
    assert.equal(p.output(), '你好');
  });

  test('进程忽略 SIGTERM：升级到 SIGKILL 才确认退出', async () => {
    const p = run('ignore-term');
    await p.ready;                        // 等它真的准备好，不靠 sleep 猜
    const how = await stop(p.child, p.exited);
    assert.equal(how, 'SIGKILL');
    assert.equal((await p.exited).signal, 'SIGKILL');
  });
}
