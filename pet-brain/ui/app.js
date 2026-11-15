"use strict";
(() => {
  const TOKEN_KEY = "pet-token";
  const HAPPY_MS = 4000;
  const SLEEP_MS = 5 * 60 * 1000;
  const NIGHT_SLEEP_MS = 60 * 1000;
  const NIGHT_START_HOUR = 23;
  const NIGHT_END_HOUR = 7;
  const FX_MS = { blink: 450, surprised: 600, confused: 1600, yawn: 1500, scared: 1100 };
  /** Se o pet ficar parado por tanto tempo, ele mesmo vai mexer com o outro pet (mas não de madrugada). */
  const SOCIAL_IDLE_MS = 3 * 60 * 1000;
  const SOCIAL_FIRST_MIN_MS = 4 * 60 * 1000;
  const SOCIAL_MIN_MS = 12 * 60 * 1000;
  const SOCIAL_SPAN_MS = 18 * 60 * 1000;
  const REVENGE_MIN_MS = 4000;
  const REVENGE_SPAN_MS = 4000;
  const REVENGE_COOLDOWN_MS = 2 * 60 * 1000;
  /** Mouse no pet: os olhos seguem a seta; passar por cima alegra, clicar faz graça, clicar demais deixa tonto. */
  const FOLLOW_MS = 2500;
  const FOLLOW_REACH_PX = 160;
  const HOVER_COOLDOWN_MS = 5000;
  const STROKE_MS = 1400;
  const STROKE_COOLDOWN_MS = 6000;
  const CLICK_WINDOW_MS = 2500;
  const ANNOYED_CLICKS = 5;
  const ANNOYED_COOLDOWN_MS = 8000;
  const SPARK_MS = 1100;
  const TOUCH_HAPPY_MS = 1500;
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
      scare: { fx: "surprised", happy: false, text: (who) => who + " tentou me assustar. Fraco. 😎" },
      woken: { fx: "scared", happy: false, text: (who) => who + " me acordou?! KKKK tá de sacanagem 😒", scared: (who) => who + " me deu um susto dormindo!! Quase deu tela azul 😳" },
      did: { poke: (who) => "Cutuquei o " + who + ". 😏", wave: (who) => "Mandei um oi pro " + who + ".", scare: (who) => "Assustei o " + who + ". KKKK 😈", scareSleeping: (who) => who + " tava dormindo... vou acordar ele do pior jeito 😈", bored: (who) => "Tédio. Vou mexer com o " + who + ". 😏" },
      touch: { hover: ["😎", "Hm?", "Tá olhando o quê?"], click: ["Boop. 😏", "Ei!", "Clicou, né."], stroke: "Ok... isso é bom. 😌", annoyed: "Chega! Tô tonto 😵‍💫", woken: "Hã?! Quem foi?! 😳" },
      revenge: (who) => "Tá, agora vou cutucar o " + who + " de volta. 😒",
      peerSleep: (who) => who + " dormiu. Presa fácil. 😈",
      peerWake: (who) => who + " acordou.",
      greet: { morning: "Bom dia. Café primeiro, bug depois. ☕", afternoon: "Boa tarde. Bora render. 😎", evening: "Boa noite. Hora do modo hacker. 🌙", late: "Ainda acordado? Respeito. Mas dorme. 🦉" },
    },
    phone: {
      eye: "#ff9ecb",
      joined: (who) => who + " chegou! 💕",
      left: (who) => who + " foi embora 🥺",
      poke: { fx: "surprised", happy: true, text: (who) => who + " me cutucou! 🥰" },
      wave: { fx: "blink", happy: true, text: (who) => who + " mandou um oi! 💖" },
      scare: { fx: "scared", happy: false, text: (who) => who + " me assustou! 😱 Nossa, que coração!" },
      woken: { fx: "scared", happy: false, text: (who) => who + " me acordou... 🥺 hihi, bobo", scared: (who) => who + " me assustou dormindo!! 😱💢 que maldade!" },
      did: { poke: (who) => "Cutuquei o " + who + "! 🥰", wave: (who) => "Mandei um oi pro " + who + "! 💖", scare: (who) => "Assustei o " + who + "! hihi 🙈", scareSleeping: (who) => who + " tá dormindo... vou fazer uma arte 🙈", bored: (who) => "Tô entediada... vou chamar o " + who + " 🥺" },
      touch: { hover: ["🥰", "Oi!", "Hihi 💕"], click: ["Hihi 💕", "Cosquinha! 🙈", "Boop! 💖"], stroke: "Que cafuné bom 🥹💖", annoyed: "Para, tô tonta! 😵‍💫", woken: "Aaah?! Que susto! 🥺" },
      revenge: (who) => "Ai, agora eu cutuco o " + who + " de volta! 😤",
      peerSleep: (who) => who + " dormiu 💤 shhh",
      peerWake: (who) => who + " acordou! 🌞",
      greet: { morning: "Bom diaaa! Dormiu bem? 🌸", afternoon: "Boa tarde! Já bebeu água? 💧", evening: "Boa noite! Como foi o dia? 🌷", late: "Tá tarde... vai descansar, vai 🥺" },
    },
  };
  const personality = PERSONALITY[device] || PERSONALITY.pc;
  document.documentElement.style.setProperty("--eye", personality.eye);
  let peers = [];
  let peersKnown = false;
  /** Quais aparelhos (o outro pet) estão dormindo agora, como o hub informou. */
  let peerAsleep = [];
  let ready = false;
  let reportedAsleep = null;
  let nextSocial = Date.now() + SOCIAL_FIRST_MIN_MS;
  let lastRevenge = 0;
  let currentView = "home";
  let reminderItems = [];
  let knownReminderCount = -1;
  let habitItems = [];
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
    hostCall("fx", name === "scared" ? "surprised" : name);
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

  /** Olhos acompanham a seta do mouse enquanto ela se mexe por perto; sem mouse mexendo, voltam a olhar ao redor. */
  const cursor = { x: 0, y: 0, at: -Infinity };
  function followCursor(now) {
    if (now - cursor.at > FOLLOW_MS) return false;
    const current = mood();
    if (current !== "idle" && current !== "happy") return false;
    const box = pet.getBoundingClientRect();
    const dx = cursor.x - (box.left + box.width / 2);
    const dy = cursor.y - (box.top + box.height / 2);
    const dist = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, dist / FOLLOW_REACH_PX);
    gaze.targetX = (dx / dist) * GAZE_X * reach;
    gaze.targetY = (dy / dist) * GAZE_Y * reach;
    gaze.nextAt = now + 400;
    return true;
  }

  /** Um quadro por vsync (60 fps ou o que a tela der). A suavização usa o tempo real, não o número de quadros. */
  function frame(now) {
    const dt = Math.min(now - (gaze.lastFrame || now), MAX_FRAME_MS);
    gaze.lastFrame = now;
    if (!followCursor(now) && now >= gaze.nextAt) pickGaze(now);
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

  const BLINK_MIN_MS = 4000;
  const BLINK_SPAN_MS = 5000;
  const CURIOUS_MIN_MS = 25000;
  const CURIOUS_SPAN_MS = 35000;
  const CURIOUS_FX = ["confused", "surprised", "blink"];
  const idleLife = { nextBlink: Date.now() + BLINK_MIN_MS, nextCurious: Date.now() + CURIOUS_MIN_MS };

  /** Com o pet parado ele pisca sozinho e, de vez em quando, estranha algo: parece vivo mesmo sem ninguém falar com ele. */
  function tickIdleLife() {
    const now = Date.now();
    if (mood() !== "idle" || now < fxUntil) return;
    if (now >= idleLife.nextCurious) {
      idleLife.nextCurious = now + CURIOUS_MIN_MS + Math.random() * CURIOUS_SPAN_MS;
      fx(CURIOUS_FX[Math.floor(Math.random() * CURIOUS_FX.length)]);
    } else if (now >= idleLife.nextBlink) {
      idleLife.nextBlink = now + BLINK_MIN_MS + Math.random() * BLINK_SPAN_MS;
      fx("blink");
    }
  }

  /** Carinho, clique e susto no pet com o mouse. Faíscas flutuam em cima dele em vez de encher o chat. */
  function spark(text, isSay) {
    const box = pet.getBoundingClientRect();
    const collapsed = document.documentElement.classList.contains("collapsed");
    const node = el("div", isSay ? "spark say" : "spark", text);
    node.style.left = (collapsed ? box.right + 14 : box.left + box.width / 2) + "px";
    node.style.top = (collapsed ? box.top + 4 : box.top - 6) + "px";
    document.body.appendChild(node);
    setTimeout(() => node.remove(), SPARK_MS);
  }

  const touch = { enteredAt: 0, lastHover: 0, lastStroke: 0, nextAnnoyed: 0, clicks: [] };
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  function onPetEnter() {
    const now = Date.now();
    touch.enteredAt = now;
    if (now - touch.lastHover < HOVER_COOLDOWN_MS) return;
    touch.lastHover = now;
    const wasAsleep = mood() === "sleeping";
    lastActivity = now;
    if (wasAsleep) { fx("surprised"); spark("?!", true); return; }
    fx("blink");
    happyUntil = now + TOUCH_HAPPY_MS;
    spark(pick(personality.touch.hover), true);
  }

  /** Seta passeando por cima por um tempo = carinho. */
  function onPetMove() {
    const now = Date.now();
    lastActivity = now;
    if (!touch.enteredAt || now - touch.enteredAt < STROKE_MS || now - touch.lastStroke < STROKE_COOLDOWN_MS) return;
    touch.lastStroke = now;
    happyUntil = now + HAPPY_MS;
    spark(personality.touch.stroke, true);
  }

  function onPetClick() {
    const now = Date.now();
    const wasAsleep = mood() === "sleeping";
    lastActivity = now;
    touch.clicks = touch.clicks.filter((at) => now - at < CLICK_WINDOW_MS).concat(now);
    if (wasAsleep) { fx("scared"); spark(personality.touch.woken, true); return; }
    if (touch.clicks.length >= ANNOYED_CLICKS && now >= touch.nextAnnoyed) {
      touch.nextAnnoyed = now + ANNOYED_COOLDOWN_MS;
      touch.clicks = [];
      fx("confused");
      spark("💫", false);
      spark(personality.touch.annoyed, true);
      return;
    }
    fx("surprised");
    happyUntil = now + TOUCH_HAPPY_MS;
    spark(pick(personality.touch.click), true);
  }

  pet.addEventListener("pointerenter", onPetEnter);
  pet.addEventListener("pointerleave", () => { touch.enteredAt = 0; });
  pet.addEventListener("pointermove", onPetMove);
  pet.addEventListener("click", onPetClick);
  document.addEventListener("pointermove", (ev) => { cursor.x = ev.clientX; cursor.y = ev.clientY; cursor.at = performance.now(); });

  function dayPart() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return "morning";
    if (hour >= 12 && hour < 18) return "afternoon";
    if (hour >= 18 && hour < 23) return "evening";
    return "late";
  }

  /** Uma saudação por período do dia, por aparelho: o pet puxa assunto sem ninguém pedir. */
  function greetOncePerPart() {
    const key = new Date().toDateString() + ":" + dayPart();
    try {
      if (localStorage.getItem("pet-greeted") === key) return;
      localStorage.setItem("pet-greeted", key);
    } catch (e) { /* sem armazenamento: cumprimenta de novo, sem problema */ }
    addMessage({ role: "pet", text: personality.greet[dayPart()] });
    happyUntil = Date.now() + HAPPY_MS;
  }

  function renderMood() {
    const current = mood();
    if (current === "sleeping" && lastMood !== "sleeping" && lastMood !== "alert") { fxName = "yawn"; fxUntil = Date.now() + FX_MS.yawn; hostCall("fx", "yawn"); }
    if (current !== lastMood) hostCall("mood", current);
    lastMood = current;
    const effect = Date.now() < fxUntil ? " fx-" + fxName : "";
    pet.setAttribute("class", "pet mood-" + current + effect);
    reportSleep();
  }

  /** Conta ao hub quando este pet dorme ou acorda, para o outro pet poder mexer com ele. */
  function reportSleep() {
    if (!ready || !state) return;
    const asleep = mood() === "sleeping";
    if (asleep === reportedAsleep) return;
    reportedAsleep = asleep;
    send({ type: "sleep", asleep });
  }

  const otherDevices = (list) => list.filter((name) => name !== device);
  const labelOf = (name) => DEVICE_LABELS[name] || "Aparelho";

  /** Reação a um cutucão, oi ou susto: quem estava dormindo acorda com o susto e depois dá o troco. */
  function onSignal(data, wasAsleep) {
    const who = labelOf(data.from);
    if (wasAsleep) {
      const woken = personality.woken;
      fx(woken.fx);
      addMessage({ role: "system", text: data.kind === "scare" ? woken.scared(who) : woken.text(who) });
      scheduleRevenge(data.from);
      return;
    }
    const reaction = data.kind === "wave" ? personality.wave : data.kind === "scare" ? personality.scare : personality.poke;
    fx(reaction.fx);
    if (reaction.happy) happyUntil = Date.now() + HAPPY_MS;
    addMessage({ role: "system", text: reaction.text(who) });
  }

  function scheduleRevenge(from) {
    const now = Date.now();
    if (now - lastRevenge < REVENGE_COOLDOWN_MS) return;
    lastRevenge = now;
    setTimeout(() => {
      if (!peers.includes(from)) return;
      addMessage({ role: "system", text: personality.revenge(labelOf(from)) });
      send({ type: "signal", kind: "poke" });
    }, REVENGE_MIN_MS + Math.random() * REVENGE_SPAN_MS);
  }

  /** Avisa quando o outro pet dorme ou acorda (só se este estiver acordado). */
  function noticeAsleep(next) {
    const before = otherDevices(peerAsleep);
    const after = otherDevices(next);
    if (mood() === "idle") {
      after.filter((name) => !before.includes(name)).forEach((name) => addMessage({ role: "system", text: personality.peerSleep(labelOf(name)) }));
      before.filter((name) => !after.includes(name) && peers.includes(name)).forEach((name) => addMessage({ role: "system", text: personality.peerWake(labelOf(name)) }));
    }
    peerAsleep = next;
  }

  /** Os dois parados por muito tempo: este pet se entedia, acorda e vai mexer com o outro (nunca de madrugada). */
  function tickSocial() {
    const now = Date.now();
    if (!state || now < nextSocial || isNight()) return;
    const current = mood();
    if ((current !== "idle" && current !== "sleeping") || now - lastActivity < SOCIAL_IDLE_MS) return;
    const target = otherDevices(peers)[0];
    if (!target) return;
    nextSocial = now + SOCIAL_MIN_MS + Math.random() * SOCIAL_SPAN_MS;
    const who = labelOf(target);
    const targetAsleep = peerAsleep.includes(target);
    const kind = targetAsleep ? (Math.random() < 0.65 ? "scare" : "poke") : Math.random() < 0.5 ? "wave" : "poke";
    lastActivity = now;
    fx("yawn");
    addMessage({ role: "system", text: kind === "scare" ? personality.did.scareSleeping(who) : personality.did.bored(who) });
    send({ type: "signal", kind });
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
      const asleep = peerAsleep.includes(name);
      row.append(el("span", asleep ? "dot asleep" : "dot"), el("span", "", labelOf(name) + (name === device ? " (este)" : "") + (asleep ? " 💤 dormindo" : "")));
      list.appendChild(row);
    });
    const others = peers.filter((name) => name !== device).length;
    const badge = $("peer-count");
    badge.hidden = peers.length < 2;
    badge.textContent = String(peers.length);
    $("poke").disabled = others === 0;
    $("wave-hi").disabled = others === 0;
    $("scare").disabled = others === 0;
    $("scare").textContent = otherDevices(peerAsleep).length > 0 ? "😈 Acordar no susto" : "😱 Assustar";
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

  function renderHabits() {
    const list = $("habit-list");
    list.replaceChildren();
    if (habitItems.length === 0) {
      list.appendChild(el("li", "muted", "Nenhum hábito. Crie um e eu te cutuco."));
      return;
    }
    habitItems.forEach((item) => {
      const row = el("li", "reminder");
      const every = item.everyMinutes >= 60 && item.everyMinutes % 60 === 0 ? item.everyMinutes / 60 + " h" : item.everyMinutes + " min";
      row.append(el("span", "left", item.doneToday + "×"), el("span", "text", item.name + " · a cada " + every));
      const done = el("button", "icon allow", "✔");
      done.type = "button";
      done.setAttribute("aria-label", "Fiz " + item.name);
      done.addEventListener("click", () => { happyUntil = Date.now() + HAPPY_MS; send({ type: "habit_done", id: item.id }); });
      const remove = el("button", "icon deny", "✕");
      remove.type = "button";
      remove.setAttribute("aria-label", "Apagar " + item.name);
      remove.addEventListener("click", () => send({ type: "habit_remove", id: item.id }));
      row.append(done, remove);
      list.appendChild(row);
    });
  }

  function askMedia(action) { send({ type: "media", action }); }

  function showView(view) {
    currentView = view;
    ["home", "reminders", "habits", "media", "peers"].forEach((name) => { $("view-" + name).hidden = name !== view; });
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("on", tab.dataset.view === view));
    if (view === "media") askMedia("status");
    if (view === "reminders") send({ type: "reminders" });
    if (view === "habits") send({ type: "habits" });
  }

  function handle(data) {
    const wasAsleep = mood() === "sleeping";
    if (data.type !== "asleep") lastActivity = Date.now();
    if (data.type === "hello") {
      log.replaceChildren();
      data.history.forEach(addMessage);
      renderState(data.state);
      ready = true;
      reportedAsleep = null;
      reportSleep();
      greetOncePerPart();
    } else if (data.type === "state") renderState(data.state);
    else if (data.type === "message") {
      addMessage(data.message);
      fx(data.message.role === "system" ? "confused" : "blink");
    }
    else if (data.type === "peers") { noticePeers(data.devices); peers = data.devices; renderPeers(); }
    else if (data.type === "media") renderMedia(data);
    else if (data.type === "reminders") { reminderItems = data.items; renderReminders(); }
    else if (data.type === "habits") { habitItems = data.items; renderHabits(); }
    else if (data.type === "asleep") { noticeAsleep(data.devices); renderPeers(); }
    else if (data.type === "signal") onSignal(data, wasAsleep);
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
      ready = false;
      peerAsleep = [];
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
    $("wave-hi").addEventListener("click", () => send({ type: "signal", kind: "wave" }));
    $("scare").addEventListener("click", () => {
      const target = otherDevices(peers)[0];
      if (!target) return;
      const did = personality.did;
      addMessage({ role: "system", text: peerAsleep.includes(target) ? did.scareSleeping(labelOf(target)) : did.scare(labelOf(target)) });
      send({ type: "signal", kind: "scare" });
    });
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
    $("habit-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const minutes = Number.parseInt($("habit-min").value, 10);
      const name = $("habit-name").value.trim();
      if (!name || !Number.isInteger(minutes) || minutes < 5) return;
      send({ type: "habit_add", name, everyMinutes: minutes });
      $("habit-name").value = "";
    });
    renderHabits();
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

  setInterval(() => { tickIdleLife(); tickSocial(); renderMood(); }, 1000);
  requestAnimationFrame(frame);
  connect();
})();
