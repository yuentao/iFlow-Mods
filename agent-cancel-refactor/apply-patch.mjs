#!/usr/bin/env node
// apply-patch.mjs — generate the agent-cancel-refactor patched bundle.
//
//   node apply-patch.mjs --base <in.js> --out <out.js>
//
// Five injections (all anchors verified byte-identical and UNIQUE in the
// 0.5.19-custom.6 fork bundle; minified, stable across builds because they
// only use property names + string literals). HARD FAILS when any anchor is
// not found exactly once — after a CLI version bump, re-derive the anchors
// from the new bundle before regenerating (same discipline as the other
// refactor mods).
//
// Variable names at each site (0.5.19-custom.6):
//   createAndExecuteAgent(e,r,n={},o,s,a,u):  o=parent signal, a=parentAgentId
//     d = wire agentId (`subagent-${u|instanceId}-${r}-${Date.now()}`, the id
//         the ACP adapter stamps on update.agentId), p = instanceManager
//         entry (p.id = `agent_...`), h = the per-agent sut controller.
//   executeAgentWithSession(e,r,n,o,s,a):  e.session carries e.agentId (the
//     same wire `d`), o = parent signal handed to sendMessageStream +
//     executeToolCallsWithSession.
//   executeWithRetry(e,r,n=1):  e = p.id (instanceManager id).
//   method table:  s = (method, params) dispatcher, o = agent object.

import { readFileSync, writeFileSync } from 'node:fs';

const LOADER = './agent-cancel-loader.cjs';

// 1. register the per-agent controller under BOTH keys right after the
//    parent-abort listener. This is the ONLY site that require()s the
//    loader; the globalThis handoff makes the other four sites degrade to
//    no-ops when the loader file is missing.
const REG_OLD = 'o.addEventListener("abort",()=>h.abort("parent_aborted"));';
const REG_NEW =
  REG_OLD +
  'try{let __acl=require(\'' + LOADER + '\');globalThis.__iflowAgentCancel=__acl;' +
  '__acl&&__acl.register(d,p.id,h)}catch(__ace){}';

// 2. the agent loop must run on AbortSignal.any([parent, agent]) so a user
//    abort interrupts the in-flight LLM stream and shell tools. e.agentId is
//    the session's wire id (same `d` registered above).
const LOOP_OLD = 'async executeAgentWithSession(e,r,n,o,s,a){let{geminiClient:u,sessionConfig:c}=e';
const LOOP_NEW =
  'async executeAgentWithSession(e,r,n,o,s,a){' +
  'o=globalThis.__iflowAgentCancel?.mergedSignal?.(e.agentId,o)||o;' +
  'let{geminiClient:u,sessionConfig:c}=e';

// 3. `_iflow/agent/cancel` in the ACP method table (iFlow extension point,
//    same shape as session/set_think). Lazy-requires the loader itself (the
//    register site may not have run yet when the first cancel arrives) and
//    never throws: unknown agentId answers {stopped:false,reason:"not_found"}
//    so a stale panel card cannot break the JSON-RPC channel.
const CASE_OLD = 'default:throw El.methodNotFound(a)';
const CASE_NEW =
  'case"_iflow/agent/cancel":{let __ac=globalThis.__iflowAgentCancel;__ac||(()=>{try{return globalThis.__iflowAgentCancel=__ac=require(\'' + LOADER + '\')}catch(__acc){return null}})();' +
  'return __ac?.cancelAgent?.(u)||{stopped:false,reason:"no_loader"}}' +
  CASE_OLD;

// 4. executeWithRetry must not treat a user abort as a transient failure:
//    without this the abort is retried 3x (~7s backoff + 3 wasted API calls)
//    before the graceful wasInterrupted branch is reached.
const RETRY_OLD = 'async executeWithRetry(e,r,n=1){try{let o=await r();return this.retryCount.delete(e),o}catch(o){';
const RETRY_NEW =
  'async executeWithRetry(e,r,n=1){try{let o=await r();return this.retryCount.delete(e),o}catch(o){' +
  'if(globalThis.__iflowAgentCancel?.isAborted?.(e))throw o;';

// 5. drop both registry keys when the agent finishes (any outcome).
const CLEAN_OLD = 'this.recursionGuard.exitCall(p.id),h.cleanup()';
const CLEAN_NEW =
  'this.recursionGuard.exitCall(p.id),globalThis.__iflowAgentCancel?.unregister?.(d,p.id),h.cleanup()';

const PATCHES = [
  { name: 'register', old: REG_OLD, new: REG_NEW },
  { name: 'loop-signal', old: LOOP_OLD, new: LOOP_NEW },
  { name: 'method-case', old: CASE_OLD, new: CASE_NEW },
  { name: 'retry-abort', old: RETRY_OLD, new: RETRY_NEW },
  { name: 'cleanup', old: CLEAN_OLD, new: CLEAN_NEW },
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
    console.error(`[agent-cancel] anchor "${p.name}" found ${count} times (expected exactly 1) — ` +
      'bundle drifted, re-derive the anchors before regenerating');
    process.exit(1);
  }
  raw = raw.replace(p.old, p.new);
  if (raw.split(p.new).length - 1 !== 1) {
    console.error(`[agent-cancel] injection verification failed for "${p.name}"`);
    process.exit(1);
  }
}
// round-trip: reverting every NEW back to OLD must reproduce the base
// byte-for-byte (apply in reverse order so nested overlaps unwind cleanly).
let reverted = raw;
for (let i = PATCHES.length - 1; i >= 0; i--) {
  const p = PATCHES[i];
  if (reverted.split(p.new).length - 1 !== 1) {
    console.error(`[agent-cancel] round-trip: "${p.name}" injection not uniquely present`);
    process.exit(1);
  }
  reverted = reverted.split(p.new).join(p.old);
}
if (reverted !== readFileSync(base, 'utf8')) {
  console.error('[agent-cancel] round-trip check failed');
  process.exit(1);
}
writeFileSync(out, raw);
console.log(`[agent-cancel] patched ${base} -> ${out} (${(raw.length / 1048576).toFixed(1)}MB)`);
