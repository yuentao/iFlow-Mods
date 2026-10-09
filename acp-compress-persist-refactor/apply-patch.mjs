#!/usr/bin/env node
// apply-patch.mjs — generate the acp-compress-persist-refactor patched bundle.
//
//   node apply-patch.mjs --base <in.js> --out <out.js> [--expect-count N]
//
// Anchors on the AcpSession.prompt() slash-handling block (minified, stable
// across builds because it only uses property names + string literals).
// HARD FAILS when the anchor is not found exactly once — after a CLI version
// bump, re-derive the anchor from the new bundle before regenerating
// (same discipline as the other refactor mods).

import { readFileSync, writeFileSync } from 'node:fs';

const OLD =
  'if(y.handled){if(y.shouldEndTurn)return{stopReason:"end_turn"};' +
  'if(y.newPrompt)e.prompt=[{type:"text",text:y.newPrompt}];else return{stopReason:"end_turn"}}';

// `b` = the trimmed slash text (e.prompt[0].text.trim()), `this` = AcpSession
// (saveSessionState = the CLI's own persist path, name not mangled).
// Only the shouldEndTurn early-return needs the fix: every compression return
// path in handleAcpSlashCommand ends there, bypassing the per-turn finally.
const NEW =
  'if(y.handled){if(y.shouldEndTurn){' +
  "try{let __cp=require('./acp-compress-persist-loader.cjs');__cp&&__cp.shouldPersist(b)&&await this.saveSessionState()}" +
  'catch(__ce){}' +
  'return{stopReason:"end_turn"}};' +
  'if(y.newPrompt)e.prompt=[{type:"text",text:y.newPrompt}];else return{stopReason:"end_turn"}}';

const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const base = arg('--base');
const out = arg('--out');
if (!base || !out) {
  console.error('usage: node apply-patch.mjs --base <in.js> --out <out.js>');
  process.exit(2);
}

const raw = readFileSync(base, 'utf8');
const count = raw.split(OLD).length - 1;
if (count !== 1) {
  console.error(`[acp-compress-persist] anchor found ${count} times (expected exactly 1) — ` +
    'bundle drifted, re-derive the anchor before regenerating');
  process.exit(1);
}
const patched = raw.replace(OLD, NEW);
if (patched.split(NEW).length - 1 !== 1) {
  console.error('[acp-compress-persist] injection verification failed');
  process.exit(1);
}
// round-trip: reverting NEW must reproduce the base byte-for-byte
if (patched.split(NEW).join(OLD) !== raw) {
  console.error('[acp-compress-persist] round-trip check failed');
  process.exit(1);
}
writeFileSync(out, patched);
console.log(`[acp-compress-persist] patched ${base} -> ${out} (${(patched.length / 1048576).toFixed(1)}MB)`);
