"use strict";
const { app, BrowserWindow, ipcMain, session } = require("electron");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HUB_URL = process.env.PET_HUB_URL || "http://127.0.0.1:8787";
const HUB_ORIGIN = new URL(HUB_URL).origin;
const CONFIG_DIR = process.env.PET_CONFIG_DIR || join(homedir(), ".config", "pet-brain");
const WIDTH = 340;
const HEIGHT = 520;

function readToken() {
  return readFileSync(join(CONFIG_DIR, "token"), "utf8").trim();
}

function createWindow() {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);

  // O pet só fala com o hub: nada de navegar ou abrir janelas para outro lugar.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockForeign = (event, url) => {
    if (new URL(url).origin !== HUB_ORIGIN) event.preventDefault();
  };
  win.webContents.on("will-navigate", blockForeign);
  win.webContents.on("will-redirect", blockForeign);
  win.webContents.on("will-frame-navigate", blockForeign);
  win.loadURL(HUB_URL);
  return win;
}

app.whenReady().then(() => {
  // A UI não precisa de câmera, microfone, localização etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ipcMain.handle("pet:token", (event) => {
    const sender = event.senderFrame && event.senderFrame.url;
    if (!sender || new URL(sender).origin !== HUB_ORIGIN) throw new Error("origem não permitida");
    return readToken();
  });
  createWindow();
});

app.on("window-all-closed", () => app.quit());
