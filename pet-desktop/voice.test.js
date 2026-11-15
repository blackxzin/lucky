"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanTranscript } = require("./voice.js");

test("keeps the spoken text", () => {
  assert.equal(cleanTranscript("  toca uma música \n"), "toca uma música");
});

test("joins lines and collapses spaces", () => {
  assert.equal(cleanTranscript("me lembra\n  de beber   água"), "me lembra de beber água");
});

test("drops whisper noise tokens", () => {
  assert.equal(cleanTranscript("[BLANK_AUDIO]"), "");
  assert.equal(cleanTranscript("[Música] (risos) oi"), "oi");
});

test("drops silence hallucinations made only of punctuation", () => {
  assert.equal(cleanTranscript(" ... "), "");
  assert.equal(cleanTranscript(""), "");
});

test("caps very long transcripts", () => {
  assert.equal(cleanTranscript("a".repeat(5000)).length, 2000);
});

const { rmsLevel, wavFile } = require("./voice.js");

const pcm = (samples) => {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer;
};

test("silence has level zero", () => {
  assert.equal(rmsLevel(pcm([0, 0, 0, 0])), 0);
  assert.equal(rmsLevel(Buffer.alloc(0)), 0);
});

test("loud audio is near one and never above it", () => {
  assert.ok(rmsLevel(pcm([30000, -30000, 30000, -30000])) > 0.9);
  assert.equal(rmsLevel(pcm([32767, -32768, 32767, -32768])), 1);
});

test("quiet speech still moves the bars", () => {
  const level = rmsLevel(pcm([1500, -1500, 1500, -1500]));
  assert.ok(level > 0.15 && level < 0.9);
});

test("builds a 16 kHz mono 16-bit wav around the samples", () => {
  const data = pcm([1, 2, 3]);
  const wav = wavFile(data);

  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), data.length);
  assert.equal(wav.length, 44 + data.length);
});
