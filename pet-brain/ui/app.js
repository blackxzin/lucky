"use strict";
(() => {
  const TOKEN_KEY = "pet-token";
  const HAPPY_MS = 4000;
  const SLEEP_MS = 5 * 60 * 1000;
  const NIGHT_SLEEP_MS = 60 * 1000;
  const NIGHT_START_HOUR = 23;
  const NIGHT_END_HOUR = 7;
  const FX_MS = { blink: 450, surprised: 600, confused: 1600, yawn: 1500 };
  const RECONNECT_MS = 2000;
  const $ = (id) => document.getElementById(id);
  const pet = $("pet");
  const log = $("log");

  let socket = null;
  let state = null;
  let happyUntil = 0;
  let lastActivity = Date.now();
  let fxName = "";
  let fxUntil = 0;
  let lastMood = "sleeping";
  let knownApprovals = 0;
  let collapseTimer = 0;

  const NOTCH_COLLAPSE_MS = 700;
  const MEDIA_POLL_MS = 3000;
  const DEVICE_LABELS = { pc: "💻 PC", phone: "📱 Celular", unknown: "❔ Aparelho" };
  const SUGGESTIONS = ["toca uma música", "como está meu PC?", "me lembra de beber água em 30 minutos", "anota que preciso comprar café", "conta uma piada"];
  /** Quem sou eu para o hub: o Electron é o PC, o app Android é o celular. */
  const device = window.petHost ? "pc" : window.PetHost ? "phone" : undefined;
  let peers = [];
  let currentView = "home";
  const isNotch = new URLSearchParams(location.search).get("notch") === "1";

  async function readToken() {
    try {
      if (window.petHost && window.petHost.getToken) return await window.petHost.getToken();
      if (window.PetHost && window.PetHost.getToken) return window.PetHost.getToken();
    } catch (e) { /* cai no prompt */ }
    let saved = null;
    try { saved = localStorage.getItem(TOKEN_KEY); } catch (e) { /* sem storage */ }
    if (saved) return saved;
    const typed = window.prompt("Token do pet:");
    if (typed) { try { localStorage.setItem(TOKEN_KEY, typed.trim()); } catch (e) { /* ok */ } }
    return typed ? typed.trim() : "";
  }

  /** No celular a bolinha flutuante repete o rosto: o humor e as reações são empurrados ao app nativo. */
  function hostCall(method, value) {
    try { if (window.PetHost && window.PetHost[method]) window.PetHost[method](value); } catch (e) { /* sem ponte */ }
  }

  function mood() {
    if (!state) return "sleeping";
    if (state.approvals.length > 0) return "alert";
    if (state.busy) return "thinking";
    if (Date.now() < happyUntil) return "happy";
    const idleFor = Date.now() - lastActivity;
    if (idleFor > (isNight() ? NIGHT_SLEEP_MS : SLEEP_MS)) return "sleeping";
    return "idle";
  }

  function isNight() {
    const hour = new Date().getHours();
    return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
  }

  /** Reação curta por cima do humor: piscada, susto, confusão, bocejo. */
  function fx(name) {
    fxName = name;
    fxUntil = Date.now() + FX_MS[name];
    hostCall("fx", name);
    renderMood();
  }

  const GAZE_MS = 2200;
  const GAZE_X = 7;
  const GAZE_Y = 4;
  const GAZE_SMOOTH_MS = 90;
  const MAX_FRAME_MS = 100;

  const eyes = $("eyes");
  const gaze = { x: 0, y: 0, targetX: 0, targetY: 0, nextAt: 0, lastFrame: 0 };

  /** Escolhe pra onde os olhos vão olhar; em humor que não é "idle" ficam centralizados. */
  function pickGaze(now) {
    gaze.nextAt = now + GAZE_MS;
    const current = mood();
    if (current === "thinking") {
      // Pensando: olha pra cima e alterna de lado, como quem procura a resposta.
      gaze.targetX = (gaze.targetX > 0 ? -1 : 1) * GAZE_X;
      gaze.targetY = -GAZE_Y;
      return;
    }
    const resting = current !== "idle" || Math.random() < 0.3;
    gaze.targetX = resting ? 0 : (Math.random() * 2 - 1) * GAZE_X;
    gaze.targetY = resting ? 0 : (Math.random() * 2 - 1) * GAZE_Y;
  }

  /** Um quadro por vsync (60 fps ou o que a tela der). A suavização usa o tempo real, não o número de quadros. */
  function frame(now) {
    const dt = Math.min(now - (gaze.lastFrame || now), MAX_FRAME_MS);
    gaze.lastFrame = now;
    if (now >= gaze.nextAt) pickGaze(now);
    const k = 1 - Math.exp(-dt / GAZE_SMOOTH_MS);
    gaze.x += (gaze.targetX - gaze.x) * k;
    gaze.y += (gaze.targetY - gaze.y) * k;
    eyes.style.transform = "translate3d(" + gaze.x.toFixed(2) + "px, " + gaze.y.toFixed(2) + "px, 0)";
    requestAnimationFrame(frame);
  }

  function renderMood() {
    const current = mood();
    if (current === "sleeping" && lastMood !== "sleeping" && lastMood !== "alert") { fxName = "yawn"; fxUntil = Date.now() + FX_MS.yawn; hostCall("fx", "yawn"); }
    if (current !== lastMood) hostCall("mood", current);
    lastMood = current;
    const effect = Date.now() < fxUntil ? " fx-" + fxName : "";
    pet.setAttribute("class", "pet mood-" + current + effect);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function addMessage(message) {
    const node = el("div", "msg " + message.role, message.text);
    log.appendChild(node);
    log.scrollTop = log.scrollHeight;
  }

  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  function renderApprovals() {
    const box = $("approvals");
    box.replaceChildren();
    state.approvals.forEach((a) => {
      const card = el("div", "approval" + (a.risk === "danger" ? " danger" : ""));
      card.appendChild(el("strong", "", a.tool + (a.risk === "danger" ? " — PERIGOSO" : "")));
      card.appendChild(el("code", "", a.action));
      card.appendChild(el("div", "muted", a.reason));
      const actions = el("div", "actions");
      const yes = el("button", "", "Aprovar");
      const no = el("button", "deny", "Negar");
      yes.addEventListener("click", () => send({ type: "decide", id: a.id, approved: true }));
      no.addEventListener("click", () => send({ type: "decide", id: a.id, approved: false }));
      actions.append(yes, no);
      card.appendChild(actions);
      box.appendChild(card);
    });
  }

  /** Entalho: abre com o mouse, com foco no campo ou com aprovação pendente; fecha logo depois. */
  function setNotch(expanded) {
    if (!isNotch || document.documentElement.classList.contains("collapsed") !== expanded) return;
    document.documentElement.classList.toggle("collapsed", !expanded);
    if (window.petHost && window.petHost.notch) window.petHost.notch(expanded);
  }

  function wantsNotchOpen() {
    return document.activeElement === $("input") || (state && state.approvals.length > 0) || document.body.matches(":hover");
  }

  function renderState(next) {
    const wasBusy = state && state.busy;
    state = next;
    if (next.approvals.length > knownApprovals) fx("surprised");
    knownApprovals = next.approvals.length;
    if (wasBusy && !next.busy) happyUntil = Date.now() + HAPPY_MS;
    $("name").textContent = next.name;
    $("level").textContent = "nível " + next.stats.level;
    $("stats").textContent = next.stats.notes + " neurônios · " + next.stats.links + " conexões";
    $("brain").textContent = "cérebro: " + (next.brain || "–") + " · " + next.reminders + (next.reminders === 1 ? " lembrete" : " lembretes");
    renderApprovals();
    renderMood();
    if (next.approvals.length > 0) setNotch(true);
  }

  function renderPeers() {
    const list = $("peer-list");
    list.replaceChildren();
    peers.forEach((name) => {
      const row = el("li", "");
      row.append(el("span", "dot"), el("span", "", (DEVICE_LABELS[name] || name) + (name === device ? " (este)" : "")));
      list.appendChild(row);
    });
    const others = peers.filter((name) => name !== device).length;
    const badge = $("peer-count");
    badge.hidden = peers.length < 2;
    badge.textContent = String(peers.length);
    $("poke").disabled = others === 0;
  }

  function renderMedia(status) {
    const live = status.available;
    $("media-title").textContent = live ? (status.title || "Sem título") : "Nada tocando";
    $("media-artist").textContent = live ? (status.artist || "–") : "Abra um player no PC";
    $("media-toggle").textContent = live && status.playing ? "⏸" : "▶";
    $("media-volume").textContent = live ? Math.round(status.volume * 100) + "%" : "–";
  }

  function askMedia(action) { send({ type: "media", action }); }

  function showView(view) {
    currentView = view;
    ["home", "media", "peers"].forEach((name) => { $("view-" + name).hidden = name !== view; });
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("on", tab.dataset.view === view));
    if (view === "media") askMedia("status");
  }

  function handle(data) {
    lastActivity = Date.now();
    if (data.type === "hello") {
      log.replaceChildren();
      data.history.forEach(addMessage);
      renderState(data.state);
    } else if (data.type === "state") renderState(data.state);
    else if (data.type === "message") {
      addMessage(data.message);
      fx(data.message.role === "system" ? "confused" : "blink");
    }
    else if (data.type === "peers") { peers = data.devices; renderPeers(); }
    else if (data.type === "media") renderMedia(data);
    else if (data.type === "signal") {
      fx("surprised");
      addMessage({ role: "system", text: (DEVICE_LABELS[data.from] || "Aparelho") + " te cutucou 👋" });
    }
    else if (data.type === "error") addMessage({ role: "system", text: data.text });
  }

  async function connect() {
    const token = await readToken();
    const scheme = location.protocol === "https:" ? "wss://" : "ws://";
    socket = new WebSocket(scheme + location.host + "/ws");
    socket.addEventListener("open", () => {
      $("conn").classList.add("on");
      socket.send(JSON.stringify(device ? { type: "auth", token, device } : { type: "auth", token }));
    });
    socket.addEventListener("message", (ev) => {
      try { handle(JSON.parse(ev.data)); } catch (e) { /* ignora lixo */ }
    });
    socket.addEventListener("close", (ev) => {
      $("conn").classList.remove("on");
      if (ev.code === 4401) {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ok */ }
        addMessage({ role: "system", text: "Token recusado." });
      }
      setTimeout(connect, RECONNECT_MS);
    });
  }

  $("form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = $("input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    lastActivity = Date.now();
    if (text.toLowerCase() === "/parar" && window.PetHost && window.PetHost.stop) {
      window.PetHost.stop();
      return;
    }
    send({ type: "chat", text });
  });

  // No celular o painel é uma janela flutuante sem botão voltar: o app nativo oferece como fechá-lo.
  if (window.PetHost && window.PetHost.minimize) {
    const minimize = $("minimize");
    minimize.hidden = false;
    minimize.addEventListener("click", () => window.PetHost.minimize());
  }

  // Microfone como o de jogo: o botão liga/desliga. Ligado, o app nativo ouve frase por frase e manda ao chat.
  if (window.PetHost && window.PetHost.listen) {
    const mic = $("mic");
    mic.hidden = false;
    mic.setAttribute("aria-pressed", "false");
    mic.addEventListener("click", () => window.PetHost.listen());
    window.petMic = (on) => {
      mic.classList.toggle("on", on);
      mic.setAttribute("aria-pressed", String(on));
      mic.textContent = on ? "🔴" : "🎤";
    };
    window.petVoice = (text) => {
      const heard = String(text).trim().slice(0, 2000);
      if (!heard) return;
      lastActivity = Date.now();
      send({ type: "chat", text: heard });
    };
  }

  if (isNotch) {
    $("tabs").hidden = false;
    const chips = $("chips");
    chips.hidden = false;
    SUGGESTIONS.forEach((text) => {
      const chip = el("button", "chip", text);
      chip.type = "button";
      chip.addEventListener("click", () => { lastActivity = Date.now(); send({ type: "chat", text }); });
      chips.appendChild(chip);
    });
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));
    document.querySelectorAll("[data-media]").forEach((button) => button.addEventListener("click", () => askMedia(button.dataset.media)));
    $("poke").addEventListener("click", () => send({ type: "signal", kind: "poke" }));
    setInterval(() => { if (currentView === "media" && !document.hidden) askMedia("status"); }, MEDIA_POLL_MS);
    renderPeers();
    document.documentElement.classList.add("notch", "collapsed");
    const scheduleCollapse = () => {
      clearTimeout(collapseTimer);
      collapseTimer = setTimeout(() => { if (!wantsNotchOpen()) setNotch(false); }, NOTCH_COLLAPSE_MS);
    };
    document.addEventListener("mouseenter", () => { clearTimeout(collapseTimer); setNotch(true); });
    document.documentElement.addEventListener("mouseenter", () => { clearTimeout(collapseTimer); setNotch(true); });
    document.documentElement.addEventListener("mouseleave", scheduleCollapse);
    $("input").addEventListener("blur", scheduleCollapse);
  }

  setInterval(renderMood, 1000);
  requestAnimationFrame(frame);
  connect();
})();
