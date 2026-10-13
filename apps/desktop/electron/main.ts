import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Notification,
  shell,
} from "electron";
import { resolve, join } from "node:path";
import { ProcessClient } from "../../../packages/protocol/src/client.ts";
import { Command } from "../../../packages/protocol/src/index.ts";

let window: BrowserWindow | undefined;
let client: ProcessClient | undefined;
let connection: Promise<{ cwd: string }> | undefined;
let cwd = process.env.HIKARO_WORKSPACE ?? process.cwd();
let busy = false;
let quitting = false;

function publish(message: unknown) {
  if (window && !window.isDestroyed())
    window.webContents.send("hikaro:event", message);
}

async function connect() {
  if (connection) return connection;
  if (client) return { cwd };
  connection = new Promise<{ cwd: string }>((resolveConnection, reject) => {
    const next = new ProcessClient(
      process.execPath,
      [
        resolve(app.getAppPath(), "../../dist/hikaro.mjs"),
        "--rpc",
        ...(process.env.HIKARO_DEMO === "1" ? ["--demo"] : []),
      ],
      { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    );
    client = next;
    next.subscribe((message) => {
      if (message.type === "ready") resolveConnection({ cwd });
      if (message.type === "event") {
        if (message.event.type === "run.start") busy = true;
        if (message.event.type === "run.end") {
          busy = false;
          if (!window?.isFocused() && Notification.isSupported()) {
            new Notification({
              title: "Hikaro",
              body: message.event.data.error
                ? "A task needs your attention."
                : "Your task is complete.",
            }).show();
          }
        }
      }
      publish(message);
    });
    next.onExit((error) => {
      if (client !== next) return;
      client = undefined;
      busy = false;
      reject(error);
      if (!quitting)
        publish({
          type: "connection",
          status: "disconnected",
          error: error.message,
        });
    });
  }).finally(() => {
    connection = undefined;
  });
  return connection;
}

async function createWindow() {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 640,
    minHeight: 480,
    title: "Hikaro",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#faf9f7",
    icon: resolve(app.getAppPath(), "../../brand/hikaro-icon-transparent.png"),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // Closing a macOS window keeps the process that owns an active run alive.
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on("closed", () => {
    window = undefined;
  });
  await window.loadFile(join(app.getAppPath(), "dist/index.html"));
}

app.whenReady().then(async () => {
  const validate = (event: Electron.IpcMainInvokeEvent) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw Error("Invalid sender");
  };
  ipcMain.handle("hikaro:connect", (event) => {
    validate(event);
    return connect();
  });
  ipcMain.handle("hikaro:command", (event, input) => {
    validate(event);
    if (!client) throw Error("Agent disconnected. Reconnect to continue.");
    const parsed = Command.parse(input);
    return client.request(parsed.method, parsed.params);
  });
  ipcMain.handle("hikaro:external", async (event, value: unknown) => {
    validate(event);
    if (typeof value !== "string") throw Error("Invalid link");
    const url = new URL(value);
    if (!new Set(["https:", "http:"]).has(url.protocol))
      throw Error("Unsupported link");
    await shell.openExternal(url.toString());
  });
  ipcMain.handle("hikaro:workspace", async (event) => {
    validate(event);
    if (busy) throw Error("Stop the current task before changing workspace.");
    const choice = await dialog.showOpenDialog(window!, {
      properties: ["openDirectory"],
    });
    if (choice.canceled || !choice.filePaths[0] || choice.filePaths[0] === cwd)
      return;
    if (busy) throw Error("Stop the current task before changing workspace.");
    const previous = client;
    client = undefined;
    await previous?.close();
    cwd = choice.filePaths[0];
    return connect();
  });
  await createWindow();
  app.on("activate", () => {
    void createWindow();
  });
});

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (client) void client.close().finally(() => app.quit());
  else app.quit();
});
