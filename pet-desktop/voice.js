"use strict";
const { execFile, spawn } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
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

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
const LEVEL_GAIN = 5;
const LEVEL_EVERY_MS = 50;
const MAX_AUDIO_BYTES = (MAX_RECORD_MS / 1000 + 2) * SAMPLE_RATE * BYTES_PER_SAMPLE;

/** Volume de 0 a 1 de um trecho de áudio PCM 16 bits, com ganho para fala normal mexer bem as barras. */
function rmsLevel(pcm) {
  const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const value = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / samples) * LEVEL_GAIN);
}

/** Embrulha PCM 16 bits mono de 16 kHz num WAV, que é o que o whisper-cli lê. */
function wavFile(pcm) {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Texto limpo do que o whisper ouviu; vazio quando foi só silêncio ou ruído. */
function cleanTranscript(raw) {
  const text = String(raw).replace(NOISE_TOKENS, " ").replace(/\s+/g, " ").trim();
  return ONLY_PUNCTUATION.test(text) ? "" : text.slice(0, MAX_TEXT_CHARS);
}

/**
 * Microfone do PC: um toque grava, outro toque para e transcreve com o whisper.cpp local.
 * O áudio fica numa pasta privada que some logo depois; nada sai do PC.
 */
function createVoice({ onState, onLevel = () => undefined, onText, onError, model = process.env.PET_WHISPER_MODEL || DEFAULT_MODEL, source = process.env.PET_MIC_SOURCE }) {
  let recorder = null;
  let dir = null;
  let timer = null;
  let busy = false;
  let chunks = [];
  let audioBytes = 0;
  let lastLevelAt = 0;

  const cleanup = () => {
    clearTimeout(timer);
    recorder = null;
    chunks = [];
    audioBytes = 0;
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
    onLevel(0);
    recorder.once("exit", () => {
      writeFileSync(file, wavFile(Buffer.concat(chunks)), { mode: 0o600 });
      transcribe(file);
    });
    recorder.kill("SIGINT");
  };

  const start = () => {
    if (!existsSync(model)) return onError("Modelo do whisper não encontrado em " + model + ".");
    dir = mkdtempSync(join(tmpdir(), "pet-voice-"));
    // Áudio cru pela saída padrão: dá para medir o volume em tempo real e depois montar o WAV.
    const args = ["--raw", "--rate", String(SAMPLE_RATE), "--channels", "1", "--format", "s16"];
    if (source) args.push("--target", source);
    args.push("-");
    recorder = spawn("pw-record", args, { stdio: ["ignore", "pipe", "ignore"] });
    recorder.stdout.on("data", (chunk) => {
      if (audioBytes < MAX_AUDIO_BYTES) {
        chunks.push(chunk);
        audioBytes += chunk.length;
      }
      const now = Date.now();
      if (now - lastLevelAt >= LEVEL_EVERY_MS) {
        lastLevelAt = now;
        onLevel(rmsLevel(chunk));
      }
    });
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

module.exports = { cleanTranscript, createVoice, rmsLevel, wavFile };
