"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petHost", {
  getToken: () => ipcRenderer.invoke("pet:token"),
});
