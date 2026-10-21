// Human acceptance entry: keyboard composition cannot be proved by PTY injection.
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw Error(
    "Run this command in a physical terminal with a Chinese input method.",
  );
await mkdir(join(root, "artifacts"), { recursive: true });
const directory = await realpath(await mkdtemp(join(root, "artifacts/ime-")));
const home = join(directory, "data");
const cwd = join(directory, "workspace");
await mkdir(cwd);
const bin = join(root, "dist/hikaro.mjs");
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
const resume = [
  process.execPath,
  bin,
  "--demo",
  "--continue",
  "--home",
  home,
  "--cwd",
  cwd,
];
console.log("输入法检查：这是独立的离线测试，不会使用你的个人会话或模型账号。");
console.log(
  "检查 5 项：\n" +
    "1. 打 nihao，输入法小框还在列出汉字时，用回车结束选字：这一下不能同时发送消息。上屏的是汉字还是拼音由输入法决定；离开选字后，再按回车才发送。\n" +
    "2. 输入 中文 abc 123 😀，左右移动、退格，看看是否删错字或光标错位。\n" +
    "3. 粘贴两行文字，应保留换行，不自动发送。\n" +
    "4. 缩窄终端窗口再拉宽，输入内容应完整。\n" +
    "5. 输入 草稿恢复测试，先别发送，按 Ctrl+D 退出，再执行下面的命令，草稿应回来。\n\n" +
    "草稿恢复命令：\n" +
    resume.map(quote).join(" "),
);
const child = spawn(
  process.execPath,
  [bin, "--demo", "--new", "--home", home, "--cwd", cwd],
  { stdio: "inherit", cwd },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
  console.log(
    "\n复制这条命令，检查未发送的草稿是否恢复：\n" +
      resume.map(quote).join(" "),
  );
  console.log(
    "请反馈终端版本、输入法名称和 5 项的通过/失败。启动脚本本身不代表输入法检查通过。",
  );
});
