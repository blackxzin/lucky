"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petHost", {
  getToken: () => ipcRenderer.invoke("pet:token"),
  notch: (expanded) => ipcRenderer.send("pet:notch", Boolean(expanded)),
});
