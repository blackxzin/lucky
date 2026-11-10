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
    if (current === "sleeping" && lastMood !== "sleeping" && lastMood !== "alert") { fxName = "yawn"; fxUntil = Date.now() + FX_MS.yawn; }
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
    else if (data.type === "error") addMessage({ role: "system", text: data.text });
  }

  async function connect() {
    const token = await readToken();
    const scheme = location.protocol === "https:" ? "wss://" : "ws://";
    socket = new WebSocket(scheme + location.host + "/ws");
    socket.addEventListener("open", () => {
      $("conn").classList.add("on");
      socket.send(JSON.stringify({ type: "auth", token }));
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

  setInterval(renderMood, 1000);
  requestAnimationFrame(frame);
  connect();
})();
