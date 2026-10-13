"use strict";

// electron/preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("hikaro", {
  connect: () => import_electron.ipcRenderer.invoke("hikaro:connect"),
  workspace: () => import_electron.ipcRenderer.invoke("hikaro:workspace"),
  openExternal: (url) => import_electron.ipcRenderer.invoke("hikaro:external", url),
  command: (method, params = {}) => import_electron.ipcRenderer.invoke("hikaro:command", {
    id: globalThis.crypto.randomUUID(),
    method,
    params
  }),
  subscribe: (fn) => {
    const handler = (_event, message) => fn(message);
    import_electron.ipcRenderer.on("hikaro:event", handler);
    return () => import_electron.ipcRenderer.removeListener("hikaro:event", handler);
  }
});
