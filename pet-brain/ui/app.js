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
  let micBusy = false;

  const NOTCH_COLLAPSE_MS = 700;
  const MEDIA_POLL_MS = 3000;
  const DEVICE_LABELS = { pc: "💻 PC", phone: "📱 Celular", unknown: "❔ Aparelho" };
  const SUGGESTIONS = ["toca uma música", "como está meu PC?", "me lembra de beber água em 30 minutos", "anota que preciso comprar café", "conta uma piada"];
  /** Quem sou eu para o hub: o Electron é o PC, o app Android é o celular. */
  const device = window.petHost ? "pc" : window.PetHost ? "phone" : undefined;
  /** Cada pet tem o seu jeito: o do PC é descolado, o do celular é fofo. Muda a cor do olho, a reação e o tom das falas. */
  const PERSONALITY = {
    pc: {
      eye: "#5ff2ff",
      joined: (who) => who + " apareceu. Finalmente. 😎",
      left: (who) => who + " sumiu. Tá, tanto faz.",
      poke: { fx: "confused", happy: false, text: (who) => who + " me cutucou. Sério? 😏" },
      wave: { fx: "blink", happy: false, text: (who) => who + " mandou um oi. Oi. 😎" },
    },
    phone: {
      eye: "#ff9ecb",
      joined: (who) => who + " chegou! 💕",
      left: (who) => who + " foi embora 🥺",
      poke: { fx: "surprised", happy: true, text: (who) => who + " me cutucou! 🥰" },
      wave: { fx: "blink", happy: true, text: (who) => who + " mandou um oi! 💖" },
    },
  };
  const personality = PERSONALITY[device] || PERSONALITY.pc;
  document.documentElement.style.setProperty("--eye", personality.eye);
  let peers = [];
  let peersKnown = false;
  let currentView = "home";
  let reminderItems = [];
  let knownReminderCount = -1;
  const TIMER_PRESETS = [1, 5, 10, 25];
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
    renderWave(now);
    requestAnimationFrame(frame);
  }

  const WAVE_SHAPE = [0.4, 0.6, 0.8, 0.95, 1, 0.95, 0.8, 0.6, 0.4];
  const WAVE_MIN_PX = 4;
  const WAVE_MAX_PX = 26;
  const waveBars = Array.prototype.slice.call(document.querySelectorAll("#wave i"));
  const waveState = { target: 0, shown: 0 };

  /** Cada barra segue o volume da voz, com um balanço próprio para parecer fala e não um bloco só. */
  function renderWave(now) {
    if (!document.documentElement.classList.contains("recording")) return;
    waveState.target *= 0.9;
    waveState.shown += (waveState.target - waveState.shown) * 0.4;
    waveBars.forEach((bar, index) => {
      const wobble = 0.75 + 0.25 * Math.sin(now / 90 + index * 1.3);
      const height = WAVE_MIN_PX + waveState.shown * (WAVE_MAX_PX - WAVE_MIN_PX) * WAVE_SHAPE[index] * wobble;
      bar.style.height = height.toFixed(1) + "px";
    });
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
    if (next.reminders !== knownReminderCount) { knownReminderCount = next.reminders; if (isNotch) send({ type: "reminders" }); }
  }

  /** Avisa quando o outro pet entra ou sai; a primeira lista (ao conectar) só mostra quem já estava. */
  function noticePeers(next) {
    if (!peersKnown) { peersKnown = true; return; }
    const others = (list) => list.filter((name) => name !== device);
    const before = others(peers);
    others(next).filter((name) => !before.includes(name)).forEach((name) => {
      fx("surprised");
      happyUntil = Date.now() + HAPPY_MS;
      addMessage({ role: "system", text: personality.joined(DEVICE_LABELS[name] || "Aparelho") });
    });
    before.filter((name) => !others(next).includes(name)).forEach((name) => {
      addMessage({ role: "system", text: personality.left(DEVICE_LABELS[name] || "Aparelho") });
    });
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
    $("wave").disabled = others === 0;
  }

  function renderMedia(status) {
    const live = status.available;
    $("media-title").textContent = live ? (status.title || "Sem título") : "Nada tocando";
    $("media-artist").textContent = live ? (status.artist || "–") : "Abra um player no PC";
    $("media-toggle").textContent = live && status.playing ? "⏸" : "▶";
    $("media-volume").textContent = live ? Math.round(status.volume * 100) + "%" : "–";
  }

  function formatLeft(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    if (total < 3600) return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
    const hours = Math.floor(total / 3600);
    return hours + "h " + String(Math.floor((total % 3600) / 60)).padStart(2, "0") + "min";
  }

  function renderReminders() {
    const list = $("reminder-list");
    list.replaceChildren();
    if (reminderItems.length === 0) {
      list.appendChild(el("li", "muted", "Nenhum lembrete ou timer."));
      return;
    }
    reminderItems.forEach((item) => {
      const row = el("li", "reminder");
      row.append(el("span", "left", formatLeft(Date.parse(item.dueAt) - Date.now())), el("span", "text", item.text));
      const cancel = el("button", "icon deny", "✕");
      cancel.type = "button";
      cancel.setAttribute("aria-label", "Cancelar " + item.text);
      cancel.addEventListener("click", () => send({ type: "reminder_cancel", id: item.id }));
      row.appendChild(cancel);
      list.appendChild(row);
    });
  }

  function addReminder(text, minutes) {
    const clean = String(text).trim();
    if (!clean || !Number.isInteger(minutes) || minutes < 1) return;
    send({ type: "reminder_add", text: clean, inMinutes: minutes });
  }

  function askMedia(action) { send({ type: "media", action }); }

  function showView(view) {
    currentView = view;
    ["home", "reminders", "media", "peers"].forEach((name) => { $("view-" + name).hidden = name !== view; });
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("on", tab.dataset.view === view));
    if (view === "media") askMedia("status");
    if (view === "reminders") send({ type: "reminders" });
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
    else if (data.type === "peers") { noticePeers(data.devices); peers = data.devices; renderPeers(); }
    else if (data.type === "media") renderMedia(data);
    else if (data.type === "reminders") { reminderItems = data.items; renderReminders(); }
    else if (data.type === "signal") {
      const who = DEVICE_LABELS[data.from] || "Aparelho";
      const reaction = data.kind === "wave" ? personality.wave : personality.poke;
      fx(reaction.fx);
      if (reaction.happy) happyUntil = Date.now() + HAPPY_MS;
      addMessage({ role: "system", text: reaction.text(who) });
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

  // Microfone. No celular (app Android) liga e desliga e ouve frase por frase; no PC (Electron) um toque
  // grava, outro toque para e o whisper local transcreve. Nos dois, o texto entendido vai direto ao chat.
  const hostListen = window.PetHost && window.PetHost.listen ? () => window.PetHost.listen()
    : window.petHost && window.petHost.listen ? () => window.petHost.listen() : null;
  if (hostListen) {
    const mic = $("mic");
    mic.hidden = false;
    mic.setAttribute("aria-pressed", "false");
    mic.addEventListener("click", hostListen);
    window.petMic = (on) => {
      micBusy = on;
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
    if (window.petHost && window.petHost.onMic) {
      const root = document.documentElement;
      $("wave").addEventListener("click", hostListen);
      window.petHost.onLevel((level) => { waveState.target = Math.max(waveState.target, Math.min(1, Math.max(0, level))); });
      window.petHost.onMic((state) => {
        window.petMic(state === "on");
        root.classList.toggle("recording", state !== "off");
        root.classList.toggle("transcribing", state === "transcribing");
        if (state === "off") waveBars.forEach((bar) => { bar.style.height = ""; });
        if (state === "transcribing") { micBusy = true; mic.textContent = "⏳"; }
      });
      window.petHost.onVoice((text) => window.petVoice(text));
      window.petHost.onVoiceError((text) => addMessage({ role: "system", text }));
    }
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
    $("wave").addEventListener("click", () => send({ type: "signal", kind: "wave" }));
    setInterval(() => { if (currentView === "media" && !document.hidden) askMedia("status"); }, MEDIA_POLL_MS);
    TIMER_PRESETS.forEach((minutes) => {
      const button = el("button", "chip", "⏱ " + minutes + " min");
      button.type = "button";
      button.addEventListener("click", () => addReminder("⏱ Timer de " + minutes + " min", minutes));
      $("timer-presets").appendChild(button);
    });
    $("reminder-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      addReminder($("reminder-text").value, Number.parseInt($("reminder-min").value, 10));
      $("reminder-text").value = "";
    });
    setInterval(() => { if (currentView === "reminders" && !document.hidden) renderReminders(); }, 1000);
    renderPeers();
    renderReminders();
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
