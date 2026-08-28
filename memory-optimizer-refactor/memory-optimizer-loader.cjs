/**
 * memory-optimizer-loader.cjs
 *
 * A self-contained memory watchdog / diagnostics layer for iFlow CLI.
 *
 * Problem it addresses:
 *   Long-running iFlow sessions slowly grow in RSS and eventually stutter.
 *   This is the classic "heap grows, GC is delayed / fragmented" symptom.
 *   iFlow ships no memory watchdog, no heap-snapshot helper and never calls
 *   global.gc(), so users have no visibility and no mitigation.
 *
 * What this loader does (all opt-in via config, zero cost when disabled):
 *   1. Periodically samples process.memoryUsage() into a small ring buffer.
 *   2. On the "warn" RSS threshold: logs a throttled warning.
 *   3. On the "critical" RSS threshold:
 *        - forces global.gc() when the runtime was started with --expose-gc
 *        - writes a V8 heap snapshot (rate-limited by a cooldown) for offline
 *          analysis in Chrome DevTools.
 *   4. Exposes a global API (global.__iflowMemory) for manual use:
 *        stats(), gc(), snapshot([dir]).
 *   5. If the command-api-refactor framework is present
 *      (global.registerSlashCommand), registers a "/mem" TUI command.
 *
 * Design notes:
 *   - The sampling timer is unref()'d so it never keeps the process alive.
 *   - global.gc() only exists when Node runs with --expose-gc. We detect this
 *     once and tell the user how to enable it via NODE_OPTIONS; without it the
 *     MOD still provides diagnostics (snapshots + sampling + logging).
 *   - Conversation-history trimming is intentionally out of scope: the chat
 *     history lives in a module-closure class that this injection point cannot
 *     reach safely. That would require a replace-type MOD.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_PREFIX = '[MemoryOptimizer]';
const MB = 1024 * 1024;

const CONFIG_PATH = process.env.IFLOW_HOME
  ? path.join(process.env.IFLOW_HOME, 'memory-optimizer.json')
  : path.join(os.homedir(), '.iflow', 'memory-optimizer.json');

const DEFAULT_CONFIG = {
  enabled: true,
  sampleIntervalMs: 30000,       // how often to sample memory
  warnThresholdMB: 1024,         // RSS at which we start warning
  criticalThresholdMB: 1600,     // RSS at which we act (gc / snapshot)
  autoGc: true,                  // force global.gc() at critical (needs --expose-gc)
  heapSnapshotOnCritical: false, // auto-dump a heap snapshot at critical
  snapshotDir: '',               // empty = <home>/.iflow/heap-snapshots
  snapshotCooldownMs: 300000,    // min gap between auto snapshots (5 min)
  maxSamples: 120,               // ring-buffer length
  logWarnCooldownMs: 60000,      // throttle warn logs
};

function numOr(v, fallback, min) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min) return fallback;
  return n;
}

function loadConfig() {
  let cfg = Object.assign({}, DEFAULT_CONFIG);
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') cfg = Object.assign(cfg, parsed);
  } catch {
    // Missing / invalid config -> silently use defaults.
  }
  cfg.sampleIntervalMs = numOr(cfg.sampleIntervalMs, DEFAULT_CONFIG.sampleIntervalMs, 1000);
  cfg.warnThresholdMB = numOr(cfg.warnThresholdMB, DEFAULT_CONFIG.warnThresholdMB, 1);
  cfg.criticalThresholdMB = numOr(cfg.criticalThresholdMB, DEFAULT_CONFIG.criticalThresholdMB, 1);
  cfg.snapshotCooldownMs = numOr(cfg.snapshotCooldownMs, DEFAULT_CONFIG.snapshotCooldownMs, 0);
  cfg.maxSamples = numOr(cfg.maxSamples, DEFAULT_CONFIG.maxSamples, 1);
  cfg.logWarnCooldownMs = numOr(cfg.logWarnCooldownMs, DEFAULT_CONFIG.logWarnCooldownMs, 0);
  return cfg;
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const state = {
  loaded: false,
  config: null,
  timer: null,
  samples: [],          // ring buffer of { t, rss, heapUsed, heapTotal, external }
  lastWarnAt: 0,
  lastSnapshotAt: 0,
  gcAvailable: typeof global.gc === 'function',
  v8: null,
};

function getV8() {
  if (!state.v8) {
    try { state.v8 = require('v8'); } catch { state.v8 = null; }
  }
  return state.v8;
}

function snapshotDir(cfg) {
  const dir = cfg.snapshotDir && String(cfg.snapshotDir).trim()
    ? cfg.snapshotDir
    : path.join(
        process.env.IFLOW_HOME || path.join(os.homedir(), '.iflow'),
        'heap-snapshots'
      );
  return dir;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

function sample() {
  const m = process.memoryUsage();
  const s = {
    t: Date.now(),
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
  };
  state.samples.push(s);
  const max = state.config.maxSamples;
  if (state.samples.length > max) state.samples.splice(0, state.samples.length - max);
  return s;
}

function forceGc() {
  if (typeof global.gc !== 'function') {
    state.gcAvailable = false;
    return { ok: false, reason: 'global.gc unavailable (start node with --expose-gc)' };
  }
  const before = process.memoryUsage().rss;
  try {
    global.gc();
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
  const after = process.memoryUsage().rss;
  return { ok: true, freedMB: (before - after) / MB, beforeMB: before / MB, afterMB: after / MB };
}

function writeHeapSnapshot(dir) {
  const v8 = getV8();
  if (!v8 || typeof v8.writeHeapSnapshot !== 'function') {
    return { ok: false, reason: 'v8.writeHeapSnapshot unavailable' };
  }
  const target = dir || snapshotDir(state.config);
  try {
    fs.mkdirSync(target, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(target, `iflow-${process.pid}-${stamp}.heapsnapshot`);
    v8.writeHeapSnapshot(file);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

function formatStats() {
  const m = process.memoryUsage();
  const first = state.samples[0];
  const growthMB = first ? (m.rss - first.rss) / MB : 0;
  const spanMin = first ? (Date.now() - first.t) / 60000 : 0;
  return {
    rssMB: +(m.rss / MB).toFixed(1),
    heapUsedMB: +(m.heapUsed / MB).toFixed(1),
    heapTotalMB: +(m.heapTotal / MB).toFixed(1),
    externalMB: +(m.external / MB).toFixed(1),
    samples: state.samples.length,
    growthMB: +growthMB.toFixed(1),
    spanMin: +spanMin.toFixed(1),
    gcAvailable: state.gcAvailable,
    warnThresholdMB: state.config.warnThresholdMB,
    criticalThresholdMB: state.config.criticalThresholdMB,
  };
}

function tick() {
  const cfg = state.config;
  const s = sample();
  const rssMB = s.rss / MB;

  if (rssMB >= cfg.criticalThresholdMB) {
    console.warn(
      `${LOG_PREFIX} RSS ${rssMB.toFixed(0)}MB >= critical ${cfg.criticalThresholdMB}MB`
    );
    if (cfg.autoGc) {
      const r = forceGc();
      if (r.ok) {
        console.warn(`${LOG_PREFIX} forced GC, freed ${r.freedMB.toFixed(1)}MB`);
      } else if (!state.gcAvailable) {
        console.warn(
          `${LOG_PREFIX} autoGc requested but ${r.reason}. ` +
          `Enable it via: NODE_OPTIONS=--expose-gc`
        );
      }
    }
    if (cfg.heapSnapshotOnCritical) {
      const now = Date.now();
      if (now - state.lastSnapshotAt >= cfg.snapshotCooldownMs) {
        state.lastSnapshotAt = now;
        const r = writeHeapSnapshot();
        if (r.ok) console.warn(`${LOG_PREFIX} heap snapshot written: ${r.file}`);
        else console.warn(`${LOG_PREFIX} heap snapshot failed: ${r.reason}`);
      }
    }
  } else if (rssMB >= cfg.warnThresholdMB) {
    const now = Date.now();
    if (now - state.lastWarnAt >= cfg.logWarnCooldownMs) {
      state.lastWarnAt = now;
      console.warn(
        `${LOG_PREFIX} RSS ${rssMB.toFixed(0)}MB >= warn ${cfg.warnThresholdMB}MB ` +
        `(heapUsed ${(s.heapUsed / MB).toFixed(0)}MB)`
      );
    }
  }
}

function startWatchdog() {
  if (state.timer) return;
  state.timer = setInterval(() => {
    try { tick(); } catch (e) {
      console.warn(`${LOG_PREFIX} sample error:`, e && e.message ? e.message : e);
    }
  }, state.config.sampleIntervalMs);
  // Never keep the event loop alive because of the watchdog.
  if (state.timer && typeof state.timer.unref === 'function') state.timer.unref();
}

function stopWatchdog() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

// ---------------------------------------------------------------------------
// Global API + optional /mem slash command
// ---------------------------------------------------------------------------

function installGlobalApi() {
  global.__iflowMemory = {
    stats: formatStats,
    gc: forceGc,
    snapshot: (dir) => writeHeapSnapshot(dir),
    getConfig: () => Object.assign({}, state.config),
    getSamples: () => state.samples.slice(),
    start: startWatchdog,
    stop: stopWatchdog,
  };
}

function renderStatsText() {
  const s = formatStats();
  const lines = [
    `RSS:        ${s.rssMB} MB`,
    `Heap used:  ${s.heapUsedMB} MB / ${s.heapTotalMB} MB`,
    `External:   ${s.externalMB} MB`,
    `Growth:     ${s.growthMB > 0 ? '+' : ''}${s.growthMB} MB over ${s.spanMin} min (${s.samples} samples)`,
    `Thresholds: warn ${s.warnThresholdMB} MB / critical ${s.criticalThresholdMB} MB`,
    `global.gc:  ${s.gcAvailable ? 'available' : 'unavailable (set NODE_OPTIONS=--expose-gc)'}`,
  ];
  return lines.join('\n');
}

function registerSlashCommand() {
  if (typeof global.registerSlashCommand !== 'function') return false;
  try {
    global.registerSlashCommand({
      name: 'mem',
      description: 'Show memory stats; /mem gc to force GC; /mem snapshot to dump a heap snapshot',
      handler: (args) => {
        const arg = (Array.isArray(args) ? args[0] : args) || '';
        const sub = String(arg).trim().toLowerCase();
        if (sub === 'gc') {
          const r = forceGc();
          return r.ok
            ? `Forced GC: freed ${r.freedMB.toFixed(1)} MB (RSS ${r.beforeMB.toFixed(0)} -> ${r.afterMB.toFixed(0)} MB)`
            : `GC unavailable: ${r.reason}`;
        }
        if (sub === 'snapshot' || sub === 'snap') {
          const r = writeHeapSnapshot();
          return r.ok ? `Heap snapshot written:\n${r.file}` : `Snapshot failed: ${r.reason}`;
        }
        return renderStatsText();
      },
    });
    return true;
  } catch (e) {
    console.warn(`${LOG_PREFIX} /mem registration failed:`, e && e.message ? e.message : e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function load() {
  if (state.loaded) return;
  state.loaded = true;

  try {
    state.config = loadConfig();
  } catch {
    state.config = Object.assign({}, DEFAULT_CONFIG);
  }

  // Always expose the manual API, even when the watchdog is disabled.
  installGlobalApi();
  registerSlashCommand();

  if (!state.config.enabled) {
    return;
  }

  state.gcAvailable = typeof global.gc === 'function';
  // Seed one sample immediately so /mem has data right away.
  try { sample(); } catch {}
  startWatchdog();

  if (!state.gcAvailable && state.config.autoGc) {
    console.log(
      `${LOG_PREFIX} loaded (watchdog on). Tip: run iFlow with ` +
      `NODE_OPTIONS=--expose-gc to enable automatic GC.`
    );
  }
}

module.exports = { load };
