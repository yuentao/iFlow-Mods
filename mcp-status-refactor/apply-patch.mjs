#!/usr/bin/env node
// apply-patch.mjs — generate the mcp-status-refactor patched bundle.
//
//   node apply-patch.mjs --base <in.js> --out <out.js>
//
// Four injections (all anchors verified byte-identical and UNIQUE in the
// 0.5.19-custom.9 fork bundle; minified, stable across builds because they
// only use property names + string literals). HARD FAILS when any anchor is
// not found exactly once — after a CLI version bump, re-derive the anchors
// from the new bundle before regenerating (same discipline as the other
// refactor mods).
//
// Variable names at each site (0.5.19-custom.9):
//   MCP module init:  Djt = name→status Map, Ese(name)=status reader,
//                     Rjt()=discovery state, vk(name,status)=status writer.
//   k2n(name,...)     connect helper: t=server name, u=connection error.
//   method table:     s=async(a,u) dispatcher, a=method, u=params,
//                     o=the ACP agent object (o.config, o.sessions).

import { readFileSync, writeFileSync } from 'node:fs';

const LOADER = './mcp-status-loader.cjs';

// 1. at MCP module init, require the loader (same bundle dir) and hand it the
//    live status/discovery readers. The MCP module factory runs before any
//    connection attempt, so attach() always precedes the first status query.
const INIT_OLD = 'Djt=new Map,Tjt=bE.NOT_STARTED,_se=new Map,Ijt=new Set';
const INIT_NEW =
  INIT_OLD +
  ';try{let __msl=require(\'' + LOADER + '\');globalThis.__iflowMcpStatus=__msl;' +
  '__msl&&__msl.attach(Ese,Rjt)}catch(__mse){}';

// 2. mirror every status write into the loader (fallback reader when the
//    live Ese attach never ran). Optional-chain: loader missing = no-op.
const VK_OLD = 'function vk(t,e){Djt.set(t,e);for(let r of Ijt)r(t,e)}';
const VK_NEW = 'function vk(t,e){globalThis.__iflowMcpStatus?.record?.(t,e);' + VK_OLD.slice('function vk(t,e){'.length);

// 3. capture the connection error the upstream path only console.errors —
//    the panel shows it in the detail view (errorKind classified loader-side).
const ERR_OLD = '`Error connecting to MCP server \'\${t}\': \${mr(u)}`),vk(t,Ss.DISCONNECTED)';
const ERR_NEW =
  ERR_OLD +
  ',(()=>{try{globalThis.__iflowMcpStatus?.recordError?.(t,u)}catch(__mee){}})()';

// 4. `_iflow/mcp/status` in the ACP method table (iFlow extension point,
//    same shape as _iflow/agent/cancel). Lazy-requires the loader itself and
//    never throws: loader missing answers {available:false,reason:"no_loader"}
//    so the panel degrades to "no indicator" instead of a protocol error.
const CASE_OLD = 'default:throw El.methodNotFound(a)';
const CASE_NEW =
  'case"_iflow/mcp/status":{let __ms=globalThis.__iflowMcpStatus;__ms||(()=>{try{return globalThis.__iflowMcpStatus=__ms=require(\'' + LOADER + '\')}catch(__msc){return null}})();' +
  'return __ms?.status?.(o,u)||{available:false,reason:"no_loader"}}' +
  CASE_OLD;

const PATCHES = [
  { name: 'init-attach', old: INIT_OLD, new: INIT_NEW },
  { name: 'vk-mirror', old: VK_OLD, new: VK_NEW },
  { name: 'error-capture', old: ERR_OLD, new: ERR_NEW },
  { name: 'method-case', old: CASE_OLD, new: CASE_NEW },
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
    console.error(`[mcp-status] anchor "${p.name}" found ${count} times (expected exactly 1) — ` +
      'bundle drifted, re-derive the anchors before regenerating');
    process.exit(1);
  }
  raw = raw.replace(p.old, p.new);
  if (raw.split(p.new).length - 1 !== 1) {
    console.error(`[mcp-status] injection verification failed for "${p.name}"`);
    process.exit(1);
  }
}
// round-trip: reverting every NEW back to OLD must reproduce the base
// byte-for-byte (apply in reverse order so nested overlaps unwind cleanly).
let reverted = raw;
for (let i = PATCHES.length - 1; i >= 0; i--) {
  const p = PATCHES[i];
  if (reverted.split(p.new).length - 1 !== 1) {
    console.error(`[mcp-status] round-trip: "${p.name}" injection not uniquely present`);
    process.exit(1);
  }
  reverted = reverted.split(p.new).join(p.old);
}
if (reverted !== readFileSync(base, 'utf8')) {
  console.error('[mcp-status] round-trip check failed');
  process.exit(1);
}
writeFileSync(out, raw);
console.log(`[mcp-status] patched ${base} -> ${out} (${(raw.length / 1048576).toFixed(1)}MB)`);
