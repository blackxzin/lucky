"use strict";
const { app, BrowserWindow, ipcMain, screen, session } = require("electron");
const { execFile } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HUB_URL = process.env.PET_HUB_URL || "http://127.0.0.1:8787";
const HUB_ORIGIN = new URL(HUB_URL).origin;
const CONFIG_DIR = process.env.PET_CONFIG_DIR || join(homedir(), ".config", "pet-brain");
const NOTCH = process.env.PET_NOTCH !== "0";
const WIDTH = 340;
const HEIGHT = 520;
const NOTCH_COLLAPSED = { width: 230, height: 44 };
const NOTCH_EXPANDED = { width: 560, height: 440 };

function readToken() {
  return readFileSync(join(CONFIG_DIR, "token"), "utf8").trim();
}

const IN_HYPRLAND = Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);
const WINDOW_CLASS = "pet-desktop";

function hyprctl(args) {
  return new Promise((resolve) => {
    execFile("hyprctl", args, { timeout: 2000 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/** No Wayland o app não escolhe a própria posição; o Hyprland sim. Só mexe na janela do pet, sem tocar na config. */
async function placeInHyprland(bounds) {
  if (!IN_HYPRLAND) return;
  const target = "class:^(" + WINDOW_CLASS + ")$";
  await hyprctl(["dispatch", "resizewindowpixel", "exact " + bounds.width + " " + bounds.height + "," + target]);
  await hyprctl(["dispatch", "movewindowpixel", "exact " + bounds.x + " " + bounds.y + "," + target]);
  const clients = await hyprctl(["clients", "-j"]);
  try {
    const mine = JSON.parse(clients).find((client) => client.class === WINDOW_CLASS);
    if (mine && !mine.floating) await hyprctl(["dispatch", "togglefloating", "address:" + mine.address]);
    if (mine && !mine.pinned) await hyprctl(["dispatch", "pin", "address:" + mine.address]);
  } catch (error) { /* sem hyprctl: segue com a posição do sistema */ }
}

/** Posição no topo, centralizada na tela principal. */
function notchBounds(size) {
  const { x, y, width } = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(x + (width - size.width) / 2), y, width: size.width, height: size.height };
}

function createWindow() {
  const start = NOTCH ? notchBounds(NOTCH_COLLAPSED) : { width: WIDTH, height: HEIGHT };
  const win = new BrowserWindow({
    ...start,
    resizable: !NOTCH,
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
  win.loadURL(NOTCH ? HUB_URL + "/?notch=1" : HUB_URL);
  if (NOTCH) win.once("show", () => setTimeout(() => placeInHyprland(notchBounds(NOTCH_COLLAPSED)), 300));
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
  const win = createWindow();
  ipcMain.on("pet:notch", (event, expanded) => {
    const sender = event.senderFrame && event.senderFrame.url;
    if (!sender || new URL(sender).origin !== HUB_ORIGIN || !NOTCH) return;
    const bounds = notchBounds(expanded ? NOTCH_EXPANDED : NOTCH_COLLAPSED);
    win.setBounds(bounds);
    placeInHyprland(bounds);
  });
});

app.on("window-all-closed", () => app.quit());
