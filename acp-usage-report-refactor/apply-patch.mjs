#!/usr/bin/env node
// apply-patch.mjs — generate the acp-usage-report-refactor patched bundle.
//
//   node apply-patch.mjs --base <in.js> --out <out.js>
//
// Three INLINE injections (no loader file — the logic is a single assignment,
// nothing worth externalising; the env gate is read once at loop init, so there
// is no hot-path require). All anchors verified byte-identical and UNIQUE in the
// 0.5.19-custom.7 fork bundle; minified, stable across builds because they use
// only property names + string literals. HARD FAILS when any anchor is not found
// exactly once — after a CLI version bump, re-derive the anchors from the new
// bundle before regenerating (same discipline as agent-cancel-refactor).
//
// What it does: the ACP session's prompt() tool-loop already iterates every
// streamed response block `v`, and each block carries `v.usageMetadata` — both
// the OpenAI-compatible generator (which converts the SSE `usage` field into
// usageMetadata, probed: `n.usageMetadata={promptTokenCount:e.usage?.prompt_tokens...}`)
// and the native Gemini path populate it. Upstream returns only {stopReason},
// discarding that data. We capture the FINAL request's promptTokenCount — which
// IS the exact context the model carried at turn end (system prompt + tool
// schemas + history + this turn's tool I/O) — and attach it as
// PromptResponse.usage.lastRequestInputTokens. The iflow-harness panel uses it
// to replace its transcript-estimated context occupancy bar.
//
// Gate: IFLOW_USAGE_REPORT=0|false disables it (the capture var stays null, the
// return spread emits nothing → the emitted PromptResponse is byte-identical to
// upstream at runtime).
//
// Variable names at the site (0.5.19-custom.7):
//   prompt(): `let u=await this.#e(...),c=this.config.getGeminiClient(),
//              m={role:"user",parts:u},d=0,f=0,p=3,h;`
//     then `for(;m!==null;){ ... let E=...getStream()?sendMessageStream:sendMessageLatency;
//            for await(let v of E){ ... } ... return{stopReason:this.mapFinishReasonToStopReason(h)}`

import { readFileSync, writeFileSync } from 'node:fs';

// 1. declare the capture var alongside the loop counters. null = disabled by
//    env; 0 = enabled, nothing captured yet; >0 = last request's input tokens.
const INIT_OLD = 'm={role:"user",parts:u},d=0,f=0,p=3,h;';
const INIT_NEW =
  'm={role:"user",parts:u},d=0,f=0,p=3,h,' +
  '__iflowU=(process.env.IFLOW_USAGE_REPORT==="0"||process.env.IFLOW_USAGE_REPORT==="false")?null:0;';

// 2. capture the last non-zero promptTokenCount seen on the stream. Runs once
//    per streamed block; the guarded assignment is the whole cost.
const CAP_OLD = 'for await(let v of E){if(r.signal.aborted)return await this.saveSessionState(),{stopReason:"cancelled"};';
const CAP_NEW =
  CAP_OLD +
  'if(__iflowU!==null&&v.usageMetadata&&v.usageMetadata.promptTokenCount)__iflowU=v.usageMetadata.promptTokenCount;';

// 3. attach the report to the turn's PromptResponse. The spread keeps the object
//    byte-identical to upstream when nothing was captured (0 / null / disabled).
const RET_OLD = 'return{stopReason:this.mapFinishReasonToStopReason(h)}';
const RET_NEW =
  'return{stopReason:this.mapFinishReasonToStopReason(h),...(__iflowU?{usage:{lastRequestInputTokens:__iflowU}}:{})}';

const PATCHES = [
  { name: 'init-var', old: INIT_OLD, new: INIT_NEW },
  { name: 'capture', old: CAP_OLD, new: CAP_NEW },
  { name: 'return', old: RET_OLD, new: RET_NEW },
];

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
    console.error(`[acp-usage] anchor "${p.name}" found ${count} times (expected exactly 1) — ` +
      'bundle drifted, re-derive the anchors before regenerating');
    process.exit(1);
  }
  raw = raw.replace(p.old, p.new);
  if (raw.split(p.new).length - 1 !== 1) {
    console.error(`[acp-usage] injection verification failed for "${p.name}"`);
    process.exit(1);
  }
}
// round-trip: reverting every NEW back to OLD must reproduce the base
// byte-for-byte (apply in reverse order so nested overlaps unwind cleanly).
let reverted = raw;
for (let i = PATCHES.length - 1; i >= 0; i--) {
  const p = PATCHES[i];
  if (reverted.split(p.new).length - 1 !== 1) {
    console.error(`[acp-usage] round-trip: "${p.name}" injection not uniquely present`);
    process.exit(1);
  }
  reverted = reverted.split(p.new).join(p.old);
}
if (reverted !== readFileSync(base, 'utf8')) {
  console.error('[acp-usage] round-trip check failed');
  process.exit(1);
}
writeFileSync(out, raw);
console.log(`[acp-usage] patched ${base} -> ${out} (${(raw.length / 1048576).toFixed(1)}MB)`);
