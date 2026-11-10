"use strict";
(() => {
  const TOKEN_KEY = "pet-token";
  const HAPPY_MS = 4000;
  const SLEEP_MS = 5 * 60 * 1000;
  const RECONNECT_MS = 2000;
  const $ = (id) => document.getElementById(id);
  const pet = $("pet");
  const log = $("log");

  let socket = null;
  let state = null;
  let happyUntil = 0;
  let lastActivity = Date.now();

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
    if (Date.now() - lastActivity > SLEEP_MS) return "sleeping";
    return "idle";
  }

  function renderMood() { pet.setAttribute("class", "pet mood-" + mood()); }

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
    if (wasBusy && !next.busy) happyUntil = Date.now() + HAPPY_MS;
    $("name").textContent = next.name;
    $("level").textContent = "nível " + next.stats.level;
    $("stats").textContent = next.stats.notes + " neurônios · " + next.stats.links + " conexões";
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
    else if (data.type === "message") addMessage(data.message);
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
    send({ type: "chat", text });
  });

  setInterval(renderMood, 1000);
  connect();
})();
