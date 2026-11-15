"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petHost", {
  getToken: () => ipcRenderer.invoke("pet:token"),
  listen: () => ipcRenderer.send("pet:listen"),
  onMic: (callback) => ipcRenderer.on("pet:mic", (_event, state) => callback(String(state))),
  onVoice: (callback) => ipcRenderer.on("pet:voice", (_event, text) => callback(String(text))),
  onVoiceError: (callback) => ipcRenderer.on("pet:voice-error", (_event, text) => callback(String(text))),
  notch: (expanded) => ipcRenderer.send("pet:notch", Boolean(expanded)),
});
