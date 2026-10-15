#!/usr/bin/env node
// apply-patch.mjs — generate the web-search-refactor patched bundle.
//
//   node apply-patch.mjs --base <in.js> --out <out.js>
//
// Anchor: the MAIN-SESSION core-tool registration in createToolRegistry():
//   bB()==="aone"?r(j0e,this):r(u3,this)
// (verified unique, count 1, on the custom.8 bundle; r(cls,...) re-instantiates
// via new n(...o), so instance-level wrapping at the OTHER site
// (SubAgentManager.initializeAvailableTools, new u3(this.config)) does NOT cover
// the executed instance — patch the CLASS PROTOTYPE instead).
// The replacement keeps the Aone branch untouched and calls
// web-search-loader.cjs patchClass(u3) once (lazy require, cached on globalThis,
// null-cached on failure so a missing loader silently keeps upstream).
// HARD FAILS when the anchor is not found exactly once — after a CLI bundle
// version bump, re-derive the anchor before regenerating (same discipline as
// the other refactor mods).

import { readFileSync, writeFileSync } from 'node:fs';

const OLD = 'bB()==="aone"?r(j0e,this):r(u3,this)';

const NEW =
  'bB()==="aone"?r(j0e,this):(()=>{let __l=globalThis.__iflowWebSearchLoader;' +
  'if(__l===undefined){try{globalThis.__iflowWebSearchLoader=__l=require("./web-search-loader.cjs")}catch(__we){globalThis.__iflowWebSearchLoader=__l=null}}' +
  '__l&&__l.patchClass&&__l.patchClass(u3);return r(u3,this)})()';

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
  console.error(`[web-search-refactor] anchor found ${count} times (expected exactly 1) — ` +
    'bundle drifted, re-derive the anchor before regenerating');
  process.exit(1);
}
const patched = raw.replace(OLD, NEW);
if (patched.split(NEW).length - 1 !== 1) {
  console.error('[web-search-refactor] injection verification failed');
  process.exit(1);
}
if (patched.split(NEW).join(OLD) !== raw) {
  console.error('[web-search-refactor] round-trip check failed');
  process.exit(1);
}
writeFileSync(out, patched);
console.log(`[web-search-refactor] patched ${base} -> ${out} (${(patched.length / 1048576).toFixed(1)}MB)`);
