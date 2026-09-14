"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Keep the desktop bridge intentionally tiny. The Mia renderer receives no
// Node.js access and no raw IPC object; it can only ask the main process to
// retry the local connection when the backend was unavailable at startup.
contextBridge.exposeInMainWorld("miaDesktop", {
  ready: () => ipcRenderer.send("miaos-renderer-ready"),
  hydrated: () => ipcRenderer.send("miaos-renderer-hydrated"),
  retryConnection: () => ipcRenderer.invoke("miaos-retry-connection"),
  artifact: {
    open: (url) => ipcRenderer.invoke("miaos-artifact-open", url),
  },
  reset: {
    // After a clean slate the renderer asks the shell to drop Electron
    // storage and relaunch the whole app. Resolves false when refused.
    relaunch: () => ipcRenderer.invoke("miaos-reset-relaunch"),
  },
  state: {
    get: (key) => ipcRenderer.sendSync("miaos-state-get", key),
    set: (key, value) => ipcRenderer.send("miaos-state-set", key, value),
  },
  browser: {
    command: (command) => ipcRenderer.invoke("miaos-browser-command", command),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("miaos-browser-state", listener);
      return () => ipcRenderer.removeListener("miaos-browser-state", listener);
    },
    onFocus: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("miaos-browser-focus", listener);
      return () => ipcRenderer.removeListener("miaos-browser-focus", listener);
    },
    onOpen: (callback) => {
      const listener = (_event, action) => callback(action);
      ipcRenderer.on("miaos-browser-open", listener);
      return () => ipcRenderer.removeListener("miaos-browser-open", listener);
    },
    onLayoutRequest: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("miaos-browser-layout-request", listener);
      return () => ipcRenderer.removeListener("miaos-browser-layout-request", listener);
    },
    onFind: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("miaos-browser-find", listener);
      return () => ipcRenderer.removeListener("miaos-browser-find", listener);
    },
    onFindResult: (callback) => {
      const listener = (_event, result) => callback(result);
      ipcRenderer.on("miaos-browser-find-result", listener);
      return () => ipcRenderer.removeListener("miaos-browser-find-result", listener);
    },
  },
});
