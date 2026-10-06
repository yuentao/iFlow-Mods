/**
 * mcp-session-share-loader.cjs
 *
 * Decision layer for the mcp-session-share MOD (ACP mode only).
 *
 * Background (verified in the CLI 0.5.19 bundle, line-by-line):
 *   Every ACP session/new AND session/load builds a fresh Config via
 *   newSessionConfig() -> config.initialize() -> createToolRegistry() ->
 *   mcpClientManager.discoverAllMcpTools(). That method spawns a full stdio
 *   process chain (cmd -> npx-cli -> server -> watchdog, ~3 node processes
 *   per server on Windows) for EVERY configured MCP server. The harness's
 *   restoreSession probe (session/new followed by session/load) therefore
 *   DOUBLES the fleet, and because the ACP method table has no
 *   session/close, the discarded probe session's fleet lingers for the whole
 *   CLI process lifetime. Measured 2026-10-05: one VSCode window with 4
 *   configured npx servers left 58 node.exe processes.
 *
 * The patched discoverAllMcpTools() (bundle/iflow.js) keeps the original
 * spawn logic verbatim and wraps it with a process-wide POOL on globalThis
 * keyed by server name. Entry states:
 *   { phase:'pending', fp, promise, resolveReady, since }  - spawn claimed
 *   { phase:'ready',   fp, client }                        - live client
 *
 * acquire(manager, name, cfg) decides the caller's path:
 *   - no entry            -> CLAIM the spawn right (pending) -> {spawn:true}
 *   - pending (same fp)   -> await the claimer, then re-loop (adopt or claim)
 *   - ready + healthy     -> adopt: re-point the client at the new session's
 *                            toolRegistry/promptRegistry/workspaceContext/
 *                            config, re-announce via discover() ONLY (two
 *                            JSON-RPC round trips, zero spawn) -> {client}
 *   - ready + dead/stale  -> evict, claim -> {spawn:true}
 * settle(name, cfg, client, err) completes a claim: ready on success,
 * eviction on failure (waiters re-loop and one of them re-claims).
 *
 * Concurrency (verified against the harness flow): mcp-background-loader
 * fires discovery without awaiting, so restoreSession's probe newSession
 * and loadSession run discoverAllMcpTools() CONCURRENTLY in one CLI
 * process. Without the claim, both would see an empty pool and both would
 * spawn. With it, the first claims, the second awaits and adopts.
 *
 * Exit safety: the ACP SIGINT/SIGTERM path calls every session manager's
 * stop(), which disconnects adopted clients too (each manager holds the
 * reference in its own clients map; disconnect is idempotent), so child
 * processes are cleaned up on graceful shutdown.
 *
 * Scope / safety:
 *   - Active ONLY in ACP headless mode (--experimental-acp in argv). The
 *     interactive TUI and -p one-shot runs keep the upstream behaviour.
 *   - IFLOW_MCP_SESSION_SHARE=0|false disables the MOD entirely.
 *   - Loader missing / throwing -> falsy -> original code path runs (same
 *     discipline as mcp-background-loader and stream-toolcall-repair-loader).
 *
 * NOTE: this module MUST NOT write to console - in ACP mode stdout carries
 * the NDJSON protocol stream, and any stray line corrupts the wire.
 */

function isDisabledByEnv() {
  const v = process.env.IFLOW_MCP_SESSION_SHARE;
  return typeof v === 'string' && ['0', 'false'].includes(v.trim().toLowerCase());
}

function isAcpMode(argv) {
  return (argv ?? process.argv).some(
    (a) => typeof a === 'string' && (a === '--experimental-acp' || a.startsWith('--experimental-acp='))
  );
}

/**
 * Gate for the pool path. Unlike mcp-background-loader this method body has
 * no isNonInteractive parameter available (discoverAllMcpTools is also the
 * TUI's /mcp restart path), so the ACP flag in argv is the discriminator:
 * the TUI and -p one-shot runs never carry --experimental-acp.
 */
function shouldShare(argv) {
  if (isDisabledByEnv()) return false;
  return isAcpMode(argv);
}

/**
 * Recursive key-sort: object keys sorted so two identically-valued configs
 * built by different Config instances (settings.json parse vs ACP
 * newSession's MCPServer class instances) fingerprint the same regardless of
 * property insertion order. Functions are dropped (never serializable).
 * Throws on circular structures - callers treat that as "not shareable".
 */
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (typeof v[k] === 'function') continue;
      out[k] = normalize(v[k]);
    }
    return out;
  }
  return v;
}

function fingerprint(cfg) {
  if (cfg === undefined || cfg === null) return '';
  return JSON.stringify(normalize(cfg)) ?? '';
}

/**
 * Process-wide pool. globalThis rather than module scope so a duplicated
 * module instance (bundle + vendor copies in one process) still shares state.
 */
function getPool() {
  if (!globalThis.__iflowMcpShare) globalThis.__iflowMcpShare = new Map();
  return globalThis.__iflowMcpShare;
}

// A claim whose spawn never settles (process-level anomaly) must not wedge
// waiters forever. 120s is far beyond any healthy npx connect+discover, and
// the stale-claim takeover path keeps the pool self-healing.
const CLAIM_STALE_MS = 120000;

function isHealthy(client) {
  return (
    client &&
    typeof client.getStatus === 'function' &&
    client.getStatus() === 'connected'
  );
}

function disconnectQuietly(client) {
  if (!client) return;
  try {
    const p = client.disconnect();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // already gone
  }
}

function evict(pool, name) {
  const old = pool.get(name);
  pool.delete(name);
  if (old && old.phase === 'ready') disconnectQuietly(old.client);
  else if (old && old.phase === 'pending') old.resolveReady();
}

function claim(pool, name, fp) {
  let resolveReady;
  const promise = new Promise((r) => {
    resolveReady = r;
  });
  pool.set(name, { phase: 'pending', fp, promise, resolveReady, since: Date.now() });
}

function repoint(client, manager, cfg) {
  // The client's roots-callback closure reads this.workspaceContext
  // dynamically, so re-pointing the fields is enough - no re-connect.
  client.toolRegistry = manager.toolRegistry;
  client.promptRegistry = manager.promptRegistry;
  client.workspaceContext = manager.workspaceContext;
  client.config = manager.config;
  client.serverConfig = cfg;
}

/**
 * Decide whether this manager adopts a pooled client or spawns its own.
 * Returns { client } (adopted, re-pointed, re-announced) or { spawn: true }
 * (caller must run the original spawn path, then call settle()).
 *
 * Never throws after the claim is installed: every throw point sits before
 * pool.set, so a claim is always settled by its owner (the patched method
 * calls settle on both success and failure) or taken over when stale.
 */
async function acquire(manager, name, cfg) {
  const pool = getPool();
  let fp;
  try {
    fp = fingerprint(cfg);
  } catch {
    return { spawn: true }; // unserializable config -> never pooled
  }
  for (;;) {
    const entry = pool.get(name);
    if (!entry) {
      claim(pool, name, fp);
      return { spawn: true };
    }
    if (entry.phase === 'pending') {
      if (Date.now() - entry.since > CLAIM_STALE_MS) {
        pool.delete(name);
        entry.resolveReady();
        continue; // stale claim -> take over
      }
      // Wait for the claimer to settle (success OR failure - both resolve),
      // with a race timeout so a wedged claimer can never hang us.
      await Promise.race([
        entry.promise,
        new Promise((r) => setTimeout(r, CLAIM_STALE_MS).unref()),
      ]);
      continue; // re-check: ready -> adopt, cleared -> claim, still pending -> stale-takeover
    }
    // ready
    if (entry.fp !== fp || !isHealthy(entry.client)) {
      evict(pool, name);
      continue; // config changed or child died -> claim + respawn
    }
    repoint(entry.client, manager, cfg);
    try {
      await entry.client.discover();
      return { client: entry.client };
    } catch (err) {
      // Dead-but-unflipped transport: evict so the spawn fallback below
      // rebuilds this server and re-registers it via settle().
      evict(pool, name);
      continue;
    }
  }
}

/**
 * Complete a spawn attempt made after acquire() returned { spawn: true }.
 * Success: pending -> ready (waiters wake and adopt). Failure: drop the
 * claim so a waiter re-claims (or the next session spawns fresh).
 *
 * If the entry is no longer the one this caller claimed (concurrent
 * different-fingerprint spawn overwrote it, or it was evicted), the
 * client still belongs to the caller's own session - never disconnect it
 * here; the owning session's stop() will.
 */
function settle(name, cfg, client, err) {
  const pool = getPool();
  let fp;
  try {
    fp = fingerprint(cfg);
  } catch {
    fp = null;
  }
  const entry = pool.get(name);
  if (err || !client || fp === null) {
    if (entry && entry.phase === 'pending') {
      pool.delete(name);
      entry.resolveReady();
    }
    return;
  }
  if (entry && entry.phase === 'pending') {
    pool.set(name, { phase: 'ready', fp, client });
    entry.resolveReady();
    return;
  }
  // No claim (entry ready/absent): still publish the healthy client so later
  // sessions adopt it - but only when it matches what's pooled or nothing is
  // pooled. A different-fingerprint ready entry stays untouched (it belongs
  // to a live session with the other config).
  if (!entry || entry.fp === fp) {
    pool.set(name, { phase: 'ready', fp, client });
  }
}

module.exports = { shouldShare, isAcpMode, isDisabledByEnv, fingerprint, getPool, acquire, settle, evict };
