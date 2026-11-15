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
