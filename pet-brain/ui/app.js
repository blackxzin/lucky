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
  const RALLY_MAX = 5;
  const RALLY_DELAY_MIN_MS = 900;
  const RALLY_DELAY_SPAN_MS = 700;
  const RALLY_RESET_MS = 8000;
  const GOODNIGHT_IDLE_MS = 40 * 1000;
  const PERF_POLL_MS = 2000;
  const WEATHER_POLL_MS = 10 * 60 * 1000;
  const LYRIC_LEAD_S = 0.3;
  const SEEK_KEY_STEP_S = 5;
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
      play: { served: (who) => "Bora de bolinha com o " + who + ". 🏓", end: (n) => "Rali de " + n + " trocas. Fácil. 😎" },
      goodnight: { say: (who) => "Boa noite, " + who + ". Não deixa o bug te morder. 🌙", hear: (who) => who + " deu boa noite. Boa noite. 😴" },
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
      play: { served: (who) => "Bora brincar de bolinha com o " + who + "! 🎾", end: (n) => "Rali de " + n + " trocas!! 🏆💖" },
      goodnight: { say: (who) => "Boa noite, " + who + "! 💤💕", hear: (who) => who + " deu boa noite! 🌙💖 durma bem" },
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
  const rally = { count: 0, at: 0 };
  let goodnightKey = "";
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
    if (data.kind === "goodnight") {
      if (!wasAsleep) { fx("yawn"); addMessage({ role: "system", text: personality.goodnight.hear(who) }); }
      return;
    }
    if (data.kind === "play" && !wasAsleep) { onPlay(data.from); return; }
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
    const roll = Math.random();
    const kind = targetAsleep ? (roll < 0.65 ? "scare" : "poke") : roll < 0.3 ? "wave" : roll < 0.65 ? "poke" : "play";
    lastActivity = now;
    fx("yawn");
    if (kind === "play") startRally(who);
    else addMessage({ role: "system", text: kind === "scare" ? personality.did.scareSleeping(who) : personality.did.bored(who) });
    send({ type: "signal", kind });
  }

  /** Bolinha entre os dois pets: cada um devolve até completar o rali; quem recebe a última troca anuncia. */
  function startRally(who) {
    rally.count = 1;
    rally.at = Date.now();
    addMessage({ role: "system", text: personality.play.served(who) });
  }

  function onPlay(from) {
    const now = Date.now();
    if (now - rally.at > RALLY_RESET_MS) rally.count = 0;
    rally.at = now;
    rally.count += 1;
    fx("surprised");
    happyUntil = now + TOUCH_HAPPY_MS;
    spark("🎾", false);
    if (rally.count >= RALLY_MAX) {
      addMessage({ role: "system", text: personality.play.end(rally.count) });
      rally.count = 0;
      return;
    }
    setTimeout(() => {
      if (!peers.includes(from)) return;
      rally.count += 1;
      rally.at = Date.now();
      send({ type: "signal", kind: "play" });
    }, RALLY_DELAY_MIN_MS + Math.random() * RALLY_DELAY_SPAN_MS);
  }

  /** De noite, antes de dormir, dá boa noite ao outro pet (uma vez por noite). */
  function tickGoodnight() {
    const now = Date.now();
    if (!state || !isNight() || mood() !== "idle" || now - lastActivity < GOODNIGHT_IDLE_MS) return;
    const target = otherDevices(peers)[0];
    if (!target || peerAsleep.includes(target)) return;
    const key = new Date(now - NIGHT_END_HOUR * 3600000).toDateString();
    try {
      if (localStorage.getItem("pet-goodnight") === key) return;
      localStorage.setItem("pet-goodnight", key);
    } catch (e) {
      if (goodnightKey === key) return;
      goodnightKey = key;
    }
    addMessage({ role: "system", text: personality.goodnight.say(labelOf(target)) });
    send({ type: "signal", kind: "goodnight" });
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
    $("play").disabled = others === 0;
    $("scare").textContent = otherDevices(peerAsleep).length > 0 ? "😈 Acordar no susto" : "😱 Assustar";
  }

  const RING_DOTS = 44;
  const SEEK_W = 200;
  const SEEK_MID = 8;
  const SEEK_AMP = 3;
  const SEEK_WAVELENGTH = 22;
  const SEEK_STEP = 2;
  const SEEK_TICK_MS = 120;
  const LOOP_LABEL = { none: "Repetir: desligado", track: "Repetir: esta faixa", playlist: "Repetir: lista" };
  const playback = { position: 0, length: 0, at: 0, playing: false };
  let artKey = "";

  const ring = $("media-ring");
  for (let i = 0; i < RING_DOTS; i += 1) {
    const dot = document.createElement("i");
    dot.style.setProperty("--a", (i * 360) / RING_DOTS + "deg");
    ring.appendChild(dot);
  }
  const ringDots = Array.prototype.slice.call(ring.children);

  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
  }

  /** A capa vem por https direto do player (ex.: Spotify) ou, se estiver em disco no PC, o hub a manda como imagem. */
  function showArt(src) {
    const img = $("media-img");
    img.hidden = !src;
    $("media-note").hidden = Boolean(src);
    if (src) img.src = src;
    tintFromCover(src);
  }

  function applyArt(url) {
    if (url === artKey) return;
    artKey = url;
    showArt("");
    if (url.startsWith("https://")) showArt(url);
    else if (url.startsWith("file://")) send({ type: "media_art", url });
  }

  function renderMedia(status) {
    const live = status.available;
    $("media-title").textContent = live ? (status.title || "Sem título") : "Nada tocando";
    $("media-artist").textContent = live ? (status.artist || "–") : "Abra um player no PC";
    $("media-toggle").textContent = live && status.playing ? "⏸" : "▶";
    $("media-volume").textContent = live ? Math.round(status.volume * 100) + "%" : "–";
    $("media-card").classList.toggle("playing", live && status.playing);
    const shuffle = $("media-shuffle");
    shuffle.classList.toggle("on", live && status.shuffle);
    shuffle.setAttribute("aria-pressed", String(live && status.shuffle));
    const loop = $("media-loop");
    loop.classList.toggle("on", live && status.loop !== "none");
    loop.setAttribute("aria-pressed", String(live && status.loop !== "none"));
    loop.title = LOOP_LABEL[live ? status.loop : "none"];
    loop.textContent = live && status.loop === "track" ? "🔂" : "🔁";
    playback.position = live ? status.position : 0;
    playback.length = live ? status.length : 0;
    playback.playing = live && status.playing;
    playback.at = Date.now();
    applyArt(live ? status.artUrl : "");
    requestLyrics(live ? status : undefined);
    applyTint();
    tickMedia();
  }

  /** Letra: pede ao hub só quando a música muda. Sem letra, o bloco some. */
  const lyrics = { key: "", synced: null, plain: null, shownIndex: -2 };
  function requestLyrics(status) {
    const box = $("media-lyrics");
    if (!status || !status.title) { lyrics.key = ""; lyrics.synced = null; lyrics.plain = null; box.hidden = true; return; }
    const key = status.title + "\u0000" + status.artist;
    if (key === lyrics.key) return;
    lyrics.key = key;
    lyrics.synced = null;
    lyrics.plain = null;
    lyrics.shownIndex = -2;
    box.hidden = true;
    send({ type: "lyrics", title: status.title, artist: status.artist, duration: status.length });
  }

  function renderLyricsMessage(message) {
    if (message.key !== lyrics.key) return;
    lyrics.synced = Array.isArray(message.synced) ? message.synced : null;
    lyrics.plain = typeof message.plain === "string" ? message.plain : null;
    lyrics.shownIndex = -2;
    tickMedia();
  }

  function renderLyrics(position) {
    const box = $("media-lyrics");
    if (lyrics.synced) {
      let index = -1;
      for (let i = 0; i < lyrics.synced.length && lyrics.synced[i].t <= position + LYRIC_LEAD_S; i += 1) index = i;
      if (index === lyrics.shownIndex && !box.hidden) return;
      lyrics.shownIndex = index;
      box.className = "lyrics";
      box.replaceChildren();
      [index - 1, index, index + 1].forEach((i) => {
        const line = lyrics.synced[i];
        if (!line || (!line.text && i !== index)) return;
        box.appendChild(el("span", i === index ? "line now" : "line", line.text || "♪"));
      });
      box.hidden = false;
    } else if (lyrics.plain) {
      if (lyrics.shownIndex === -1 && !box.hidden) return;
      lyrics.shownIndex = -1;
      box.className = "lyrics plain";
      box.textContent = lyrics.plain;
      box.hidden = false;
    } else box.hidden = true;
  }

  /** O pet e o destaque da aba ganham a cor dominante da capa enquanto a música toca. */
  let artTint = "";
  function setTint(color) {
    document.documentElement.style.setProperty("--eye", color || personality.eye);
    if (color) $("media-card").style.setProperty("--accent", color);
    else $("media-card").style.removeProperty("--accent");
  }
  function applyTint() { setTint(playback.playing ? artTint : ""); }
  function tintFromCover(src) {
    artTint = "";
    if (!src) { applyTint(); return; }
    const img = new Image();
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 8;
        const context = canvas.getContext("2d");
        context.drawImage(img, 0, 0, 8, 8);
        const pixels = context.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, b = 0, weight = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const spread = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
          const w = 1 + spread / 32;
          r += pixels[i] * w; g += pixels[i + 1] * w; b += pixels[i + 2] * w; weight += w;
        }
        r /= weight; g /= weight; b /= weight;
        const top = Math.max(r, g, b) || 1;
        const lift = top < 170 ? 190 / top : 1;
        artTint = "rgb(" + [r, g, b].map((v) => Math.min(255, Math.round(v * lift))).join(",") + ")";
      } catch (e) { artTint = ""; }
      applyTint();
    };
    img.onerror = () => { artTint = ""; applyTint(); };
    img.src = src;
  }

  function seekTo(seconds) {
    if (playback.length <= 0) return;
    const target = Math.max(0, Math.min(playback.length, Math.round(seconds)));
    playback.position = target;
    playback.at = Date.now();
    send({ type: "media_seek", seconds: target });
    tickMedia();
  }

  function renderMediaArt(message) {
    if (message.url !== artKey) return;
    showArt(message.data || "");
  }

  /** Barra de progresso ondulada (a parte já tocada balança enquanto toca) e anel de pontinhos em volta da capa. */
  function currentPosition() {
    const elapsed = playback.playing ? (Date.now() - playback.at) / 1000 : 0;
    return playback.position + elapsed;
  }

  function tickMedia() {
    const position = playback.length > 0 ? Math.min(playback.length, currentPosition()) : currentPosition();
    const fraction = playback.length > 0 ? position / playback.length : 0;
    const x = Math.max(0, Math.min(1, fraction)) * SEEK_W;
    const phase = playback.playing ? Date.now() / 260 : 0;
    let path = "M0 " + SEEK_MID;
    for (let px = 0; px <= x; px += SEEK_STEP) {
      const ease = Math.min(1, px / 12);
      path += " L" + px.toFixed(1) + " " + (SEEK_MID + SEEK_AMP * ease * Math.sin((px / SEEK_WAVELENGTH) * 2 * Math.PI - phase)).toFixed(2);
    }
    $("seek-played").setAttribute("d", path);
    $("seek-rest").setAttribute("d", "M" + x.toFixed(1) + " " + SEEK_MID + "H" + SEEK_W);
    $("seek-knob").setAttribute("x", Math.max(0, x - 1.5).toFixed(1));
    $("media-pos").textContent = playback.length > 0 || playback.playing ? formatClock(position) : "–";
    $("media-len").textContent = playback.length > 0 ? formatClock(playback.length) : "–";
    const lit = Math.round(Math.max(0, Math.min(1, fraction)) * RING_DOTS);
    ringDots.forEach((dot, index) => dot.classList.toggle("on", index < lit));
    renderLyrics(position);
    $("media-seek").setAttribute("aria-valuenow", String(Math.floor(position)));
  }

  let lastWeatherAt = 0;
  function askSystem() {
    send({ type: "perf" });
    if (Date.now() - lastWeatherAt > WEATHER_POLL_MS) { lastWeatherAt = Date.now(); send({ type: "weather" }); }
  }

  function setMeter(key, fraction, text, inverse) {
    const row = document.querySelector('.meter[data-key="' + key + '"]');
    if (!row) return;
    row.hidden = fraction === undefined || fraction === null;
    if (row.hidden) return;
    const bar = row.querySelector("i");
    bar.style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + "%";
    bar.className = inverse ? (fraction <= 0.2 ? "hot" : fraction <= 0.4 ? "warn" : "") : fraction >= 0.9 ? "hot" : fraction >= 0.7 ? "warn" : "";
    row.querySelector(".m-val").textContent = text;
  }

  function renderPerf(sample) {
    if (!sample) { $("perf-uptime").textContent = "Não consegui ler o PC agora."; return; }
    const pct = (v) => Math.round(v * 100) + "%";
    setMeter("cpu", sample.cpu, sample.cpu === undefined ? "–" : pct(sample.cpu));
    setMeter("memory", sample.memory, sample.memory === undefined ? "–" : pct(sample.memory) + " · " + Math.round(sample.memoryTotalGb) + "G");
    setMeter("disk", sample.disk, sample.disk === undefined ? "–" : pct(sample.disk));
    setMeter("temp", sample.tempC === undefined ? undefined : sample.tempC / 100, sample.tempC === undefined ? "–" : Math.round(sample.tempC) + "°C");
    setMeter("battery", sample.battery ? sample.battery.percent / 100 : undefined, sample.battery ? sample.battery.percent + "%" + (sample.battery.charging ? " ⚡" : "") : "–", true);
    const up = sample.uptimeSeconds;
    $("perf-uptime").textContent = up === undefined ? "" : "Ligado há " + (up >= 3600 ? Math.floor(up / 3600) + "h" + String(Math.floor((up % 3600) / 60)).padStart(2, "0") : Math.floor(up / 60) + " min");
  }

  function renderWeather(message) {
    const info = message.info;
    $("wx-extra").textContent = "";
    if (!message.configured) {
      $("wx-emoji").textContent = "🌐";
      $("wx-temp").textContent = "Tempo desligado";
      $("wx-label").textContent = "Defina PET_WEATHER_PLACE no hub.env (ex.: Fortaleza) e reinicie o hub.";
      $("wx-place").textContent = "";
      return;
    }
    if (!info) {
      $("wx-emoji").textContent = "🌫️";
      $("wx-temp").textContent = "–";
      $("wx-label").textContent = "Não consegui buscar o tempo agora.";
      $("wx-place").textContent = "";
      return;
    }
    $("wx-emoji").textContent = info.emoji;
    $("wx-temp").textContent = info.tempC + "°C";
    $("wx-label").textContent = info.label + " · sensação " + info.feelsC + "°C";
    $("wx-place").textContent = info.place;
    $("wx-extra").textContent = "Hoje " + info.minC + "° a " + info.maxC + "°" + (info.rainChance === undefined ? "" : " · chance de chuva " + info.rainChance + "%");
  }

  /** Resumo do dia: uma vez por dia, na primeira conexão depois das 5h. O hub monta o texto sem chamar o modelo. */
  function briefOncePerDay() {
    if (new Date().getHours() < 5) return;
    const key = new Date().toDateString();
    try {
      if (localStorage.getItem("pet-briefed") === key) return;
      localStorage.setItem("pet-briefed", key);
    } catch (e) { return; }
    send({ type: "briefing" });
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
    ["home", "reminders", "habits", "media", "system", "peers"].forEach((name) => { $("view-" + name).hidden = name !== view; });
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("on", tab.dataset.view === view));
    if (view === "media") askMedia("status");
    if (view === "system") { lastWeatherAt = 0; askSystem(); }
    if (view === "reminders") send({ type: "reminders" });
    if (view === "habits") send({ type: "habits" });
  }

  function handle(data) {
    const wasAsleep = mood() === "sleeping";
    const whisper = data.type === "asleep" || (data.type === "signal" && data.kind === "goodnight");
    if (!whisper) lastActivity = Date.now();
    if (data.type === "hello") {
      log.replaceChildren();
      data.history.forEach(addMessage);
      renderState(data.state);
      ready = true;
      reportedAsleep = null;
      reportSleep();
      greetOncePerPart();
      briefOncePerDay();
    } else if (data.type === "state") renderState(data.state);
    else if (data.type === "message") {
      addMessage(data.message);
      fx(data.message.role === "system" ? "confused" : "blink");
    }
    else if (data.type === "peers") { noticePeers(data.devices); peers = data.devices; renderPeers(); }
    else if (data.type === "media") renderMedia(data);
    else if (data.type === "media_art") renderMediaArt(data);
    else if (data.type === "lyrics") renderLyricsMessage(data);
    else if (data.type === "perf") renderPerf(data.sample);
    else if (data.type === "weather") renderWeather(data);
    else if (data.type === "briefing") { addMessage({ role: "pet", text: data.text }); happyUntil = Date.now() + HAPPY_MS; }
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
    const briefing = el("button", "chip", "resumo do dia");
    briefing.type = "button";
    briefing.addEventListener("click", () => { lastActivity = Date.now(); send({ type: "briefing" }); });
    chips.appendChild(briefing);
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
    $("play").addEventListener("click", () => {
      const target = otherDevices(peers)[0];
      if (!target) return;
      startRally(labelOf(target));
      send({ type: "signal", kind: "play" });
    });
    $("media-seek").addEventListener("click", (ev) => {
      const rect = document.querySelector(".seek-bar").getBoundingClientRect();
      if (rect.width > 0) seekTo(((ev.clientX - rect.left) / rect.width) * playback.length);
    });
    $("media-seek").addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      seekTo(currentPosition() + (ev.key === "ArrowRight" ? SEEK_KEY_STEP_S : -SEEK_KEY_STEP_S));
    });
    $("capture").addEventListener("click", () => {
      const input = $("input");
      const text = input.value.trim();
      lastActivity = Date.now();
      if (!text) { input.focus(); addMessage({ role: "system", text: "Escreva a ideia e toque em 📝 de novo (ou use /anota ideia)." }); return; }
      input.value = "";
      send({ type: "capture", text });
    });
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

  setInterval(() => { tickIdleLife(); tickSocial(); tickGoodnight(); renderMood(); }, 1000);
  setInterval(() => { if (currentView === "media" && !document.hidden) tickMedia(); }, SEEK_TICK_MS);
  requestAnimationFrame(frame);
  connect();
})();
