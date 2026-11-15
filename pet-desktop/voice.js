"use strict";
const { execFile, spawn } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { homedir, tmpdir } = require("node:os");
const { join } = require("node:path");

const MAX_RECORD_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const MAX_TEXT_CHARS = 2000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MODEL = join(homedir(), ".local", "share", "whisper.cpp", "ggml-base.bin");
/** Marcas que o whisper escreve para silêncio e ruído, como [BLANK_AUDIO], [Música] ou (risos). */
const NOISE_TOKENS = /\[[^\]]*\]|\([^)]*\)/g;
const ONLY_PUNCTUATION = /^[\s.,;:!?…\-–—'"]*$/;

/** Texto limpo do que o whisper ouviu; vazio quando foi só silêncio ou ruído. */
function cleanTranscript(raw) {
  const text = String(raw).replace(NOISE_TOKENS, " ").replace(/\s+/g, " ").trim();
  return ONLY_PUNCTUATION.test(text) ? "" : text.slice(0, MAX_TEXT_CHARS);
}

/**
 * Microfone do PC: um toque grava, outro toque para e transcreve com o whisper.cpp local.
 * O áudio fica numa pasta privada que some logo depois; nada sai do PC.
 */
function createVoice({ onState, onText, onError, model = process.env.PET_WHISPER_MODEL || DEFAULT_MODEL, source = process.env.PET_MIC_SOURCE }) {
  let recorder = null;
  let dir = null;
  let timer = null;
  let busy = false;

  const cleanup = () => {
    clearTimeout(timer);
    recorder = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  };

  const transcribe = (file) => {
    onState("transcribing");
    execFile(
      "whisper-cli",
      ["-m", model, "-l", "pt", "-nt", "-np", "-f", file],
      { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout) => {
        cleanup();
        busy = false;
        onState("off");
        if (error) return onError("Não consegui transcrever o áudio (whisper-cli).");
        const text = cleanTranscript(stdout);
        if (text) onText(text);
      },
    );
  };

  const stop = () => {
    if (!recorder) return;
    const file = join(dir, "voice.wav");
    clearTimeout(timer);
    busy = true;
    recorder.once("exit", () => transcribe(file));
    recorder.kill("SIGINT");
  };

  const start = () => {
    if (!existsSync(model)) return onError("Modelo do whisper não encontrado em " + model + ".");
    dir = mkdtempSync(join(tmpdir(), "pet-voice-"));
    const args = ["--rate", "16000", "--channels", "1", "--format", "s16"];
    if (source) args.push("--target", source);
    args.push(join(dir, "voice.wav"));
    recorder = spawn("pw-record", args, { stdio: "ignore" });
    recorder.on("error", () => {
      cleanup();
      busy = false;
      onState("off");
      onError("Não consegui abrir o microfone (pw-record).");
    });
    timer = setTimeout(stop, MAX_RECORD_MS);
    onState("on");
  };

  return {
    toggle: () => {
      if (busy) return;
      if (recorder) stop();
      else start();
    },
    dispose: () => {
      if (recorder) recorder.kill("SIGKILL");
      cleanup();
    },
  };
}

module.exports = { cleanTranscript, createVoice };
