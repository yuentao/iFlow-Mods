#!/usr/bin/env node
// apply-patch.mjs — generate the acp-context-report-refactor patched bundle.
//
//   node apply-patch.mjs --base <in.js> --out <out.js>
//
// ONE inline injection (the decision/write layer lives in
// acp-context-report-loader.cjs, required lazily at the call site). The anchor
// was verified byte-identical and UNIQUE in the 0.5.19-custom.8 fork bundle;
// minified, stable across builds because it uses only property names + a
// literal template string. HARD FAILS when the anchor is not found exactly
// once — after a CLI version bump, re-derive the anchor from the new bundle
// before regenerating (same discipline as acp-usage-report-refactor).
//
// What it does: GeminiClient.startChat() assembles the final system
// instruction `d` (core prompt via getCoreSystemPrompt/GLM.md override/plan
// wrapper, plus appendSystemPrompt) and the joined hierarchical memory `m`
// right before constructing the chat. The injection calls the loader with
// (config, d, m) AFTER the append merge, so the report holds exactly what the
// model receives. startChat runs on session/new, session/load and
// approval-mode changes, so the report file always reflects the CURRENT
// request context — the harness panel reads it the moment the first prompt
// starts streaming. Loader missing / throwing / env gate off -> no-op, the
// emitted bundle behaves byte-identically to upstream at runtime.
//
// Anchor (GeminiClient.startChat, custom.8):
//   ...:d=await P0e(this.config,m),this.appendSystemPrompt&&(d=d+`\r\n`+this.appendSystemPrompt);let f=j9a(...

import { readFileSync, writeFileSync } from 'node:fs';

// NOTE: the `\r\n` inside the template literal is a LITERAL four-character
// sequence (backslash r backslash n) in the minified source — hence the double
// backslashes below. Use String.raw semantics: never let JS interpret the
// escapes or the anchor will not match.
// Anchor deliberately avoids the template literal between the two
// `appendSystemPrompt` references: the fork bundle (built on Windows) keeps
// `\r\n` there while the vendor bundle (built on macOS) has `\n` — a
// newline-sensitive anchor would match only one of them. This anchor is
// byte-identical and UNIQUE in both 0.5.19-custom.8 bundles.
const OLD = '+this.appendSystemPrompt);let f=j9a(';
const NEW =
  '+this.appendSystemPrompt);' +
  "try{require('./acp-context-report-loader.cjs').report(this.config,d,m)}catch{}" +
  'let f=j9a(';

const PATCHES = [{ name: 'startchat-report', old: OLD, new: NEW }];

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

let raw = readFileSync(base, 'utf8');
for (const p of PATCHES) {
  const count = raw.split(p.old).length - 1;
  if (count !== 1) {
    console.error(`[acp-context-report] anchor "${p.name}" found ${count} times (expected exactly 1) — ` +
      'bundle drifted, re-derive the anchor before regenerating');
    process.exit(1);
  }
  raw = raw.replace(p.old, p.new);
  if (raw.split(p.new).length - 1 !== 1) {
    console.error(`[acp-context-report] injection verification failed for "${p.name}"`);
    process.exit(1);
  }
}
// round-trip: reverting every NEW back to OLD must reproduce the base
// byte-for-byte.
let reverted = raw;
for (let i = PATCHES.length - 1; i >= 0; i--) {
  const p = PATCHES[i];
  if (reverted.split(p.new).length - 1 !== 1) {
    console.error(`[acp-context-report] round-trip: "${p.name}" injection not uniquely present`);
    process.exit(1);
  }
  reverted = reverted.split(p.new).join(p.old);
}
if (reverted !== readFileSync(base, 'utf8')) {
  console.error('[acp-context-report] round-trip mismatch — patched bundle does not unwind to the base');
  process.exit(1);
}

writeFileSync(out, raw, 'utf8');
console.log(`[acp-context-report] patched ${base} -> ${out}`);
