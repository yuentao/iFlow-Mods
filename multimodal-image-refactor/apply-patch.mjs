#!/usr/bin/env node
// apply-patch.mjs — multimodal-image-refactor Feature 4 bundle injections.
//
//   node apply-patch.mjs --base <in.js> --out <out.js>
//
// Two inline injections at the ONLY `new _4(...)` construction sites (anchors
// verified byte-identical and UNIQUE in the 0.5.19-custom.10 fork bundle;
// property names only, stable under minification). HARD FAILS when an anchor
// is not found exactly once — after a CLI version bump re-derive anchors.
//
// Why: Config.getMultimodalHelper() caches the helper on the Config and
// passes getMultimodalModelName() (undefined in OpenAI-compatible mode) as a
// value snapshot, so the loader's fallback re-read settings.json on disk —
// wrong model under the harness (panel model lives in memory via set_model,
// api-config-isolation keeps panel fields off disk). Fix: pass a live getter
// `()=>this.getModel()||""` instead of a snapshot; the loader (multimodal-
// model-loader.cjs) resolves function-valued modelName per description call.
// Bundle evidence (0.5.19-custom.10): getModel(){return this.contentGeneratorConfig?.model||this.model}
// sits next to setModel(){this.contentGeneratorConfig&&(this.contentGeneratorConfig.model=e)}.

const PATCHES = [
  {
    name: 'content-generator-ctor',
    old: 'this.multimodalHelper=new _4(this.apiKey,this.baseUrl,o,r,n)',
    new: 'this.multimodalHelper=new _4(this.apiKey,this.baseUrl,o||(()=>this.config?.getModel()||""),r,n)',
  },
  {
    name: 'config-getMultimodalHelper',
    old: 'this.multimodalHelper=new _4(e,r,n,o,s)',
    new: 'this.multimodalHelper=new _4(e,r,n||(()=>this.getModel()||""),o,s)',
  },
];

const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const base = arg('--base');
const out = arg('--out');
if (!base || !out) { console.error('usage: node apply-patch.mjs --base <in.js> --out <out.js>'); process.exit(2); }

import { readFileSync, writeFileSync } from "node:fs";
const original = readFileSync(base, "utf8");
let raw = original;
for (const p of PATCHES) {
  const count = raw.split(p.old).length - 1;
  if (count !== 1) {
    console.error(`[multimodal] anchor "${p.name}" found ${count} times (expected 1) — bundle drifted, re-derive anchors`);
    process.exit(1);
  }
  raw = raw.replace(p.old, p.new);
  if (raw.split(p.new).length - 1 !== 1) {
    console.error(`[multimodal] injection verification failed for "${p.name}"`);
    process.exit(1);
  }
}
let reverted = raw;
for (let i = PATCHES.length - 1; i >= 0; i--) {
  const p = PATCHES[i];
  if (reverted.split(p.new).length - 1 !== 1) {
    console.error(`[multimodal] round-trip: "${p.name}" injection not uniquely present`);
    process.exit(1);
  }
  reverted = reverted.split(p.new).join(p.old);
}
if (reverted !== original) { console.error('[multimodal] round-trip check failed'); process.exit(1); }
writeFileSync(out, raw);
console.log(`[multimodal] patched ${base} -> ${out}`);
