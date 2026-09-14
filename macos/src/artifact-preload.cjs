"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("miaArtifactControls", {
  action: (action) => ipcRenderer.invoke("miaos-artifact-action", action),
  getState: () => ipcRenderer.invoke("miaos-artifact-state"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("miaos-artifact-state", listener);
    return () => ipcRenderer.removeListener("miaos-artifact-state", listener);
  },
});
