import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("hikaro", {
  connect: () => ipcRenderer.invoke("hikaro:connect"),
  workspace: () => ipcRenderer.invoke("hikaro:workspace"),
  openExternal: (url: string) => ipcRenderer.invoke("hikaro:external", url),
  command: (method: string, params: Record<string, unknown> = {}) =>
    ipcRenderer.invoke("hikaro:command", {
      id: globalThis.crypto.randomUUID(),
      method,
      params,
    }),
  subscribe: (fn: (message: unknown) => void) => {
    const handler = (_event: unknown, message: unknown) => fn(message);
    ipcRenderer.on("hikaro:event", handler);
    return () => ipcRenderer.removeListener("hikaro:event", handler);
  },
});
