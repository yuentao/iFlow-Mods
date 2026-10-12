/**
 * agent-cancel-loader.cjs
 *
 * Decision layer for the agent-cancel-refactor MOD.
 *
 * Background (verified in the CLI 0.5.19 bundle, line-by-line):
 *   Every SubAgent gets its OWN AbortController in createAndExecuteAgent():
 *   `h=new sut(p.id,3e5,new AbortController,R=>{...ABORTED})`. The parent
 *   signal propagates ONE way only (`o.addEventListener("abort",()=>h.abort
 *   ("parent_aborted"))`) — nothing on the outside can reach `h`, and the
 *   ACP method table has no per-agent cancel (session/cancel aborts the
 *   whole turn's pendingPrompt). Meanwhile the agent loop
 *   (executeAgentWithSession) feeds the PARENT signal `o` to
 *   sendMessageStream/executeToolCallsWithSession — aborting `h` alone
 *   would not interrupt in-flight LLM requests or shell tools.
 *
 * The patched call sites (see apply-patch.mjs) wire the missing path:
 *   1. register(d, p.id, h) right after the parent-abort listener —
 *      process-level registry keyed by BOTH the wire agentId (`d`, what
 *      the panel sees on update.agentId) and the instanceManager id
 *      (`p.id`, what executeWithRetry receives). This is the only site
 *      that require()s the loader; every other site goes through
 *      globalThis.__iflowAgentCancel with optional chaining, so a
 *      missing loader is a silent no-op everywhere.
 *   2. mergedSignal(e.agentId, o) at executeAgentWithSession entry —
 *      the loop's LLM stream and tool execution run on
 *      AbortSignal.any([parent, agent]), so aborting one agent cancels
 *      its in-flight fetch/shell without touching siblings or the parent.
 *   3. `_iflow/agent/cancel` case in the ACP method table —
 *      cancelAgent({sessionId, agentId}) aborts the registry entry. The
 *      agent's own catch already treats an aborted signal as a graceful
 *      stop (returns wasInterrupted:true), so the parent agent keeps
 *      running with an interrupted-task result.
 *   4. isAborted(e) short-circuit in executeWithRetry's catch — without
 *      it a user abort is retried 3x with ~7s of backoff before the
 *      graceful branch is reached.
 *   5. unregister(d, p.id) in the finally cleanup.
 *
 * Gate: active only under --experimental-acp and unless
 * IFLOW_AGENT_CANCEL=0|false. Loader missing / throwing at any injection
 * site -> original upstream behaviour (safe fallback, same discipline as
 * mcp-session-share-loader).
 *
 * NOTE: this module MUST NOT write to console - in ACP mode stdout carries
 * the NDJSON protocol stream, and any stray line corrupts the wire.
 */

"use strict";

/** wire agentId (`subagent-...`) and instanceManager id (`agent_...`) -> sut */
const registry = new Map();

function isDisabledByEnv() {
  const v = process.env.IFLOW_AGENT_CANCEL;
  return typeof v === "string" && ["0", "false"].includes(v.trim().toLowerCase());
}

/**
 * ACP-only gate (same rationale as mcp-session-share: the subagent flow is
 * also reachable from the TUI, so gate on argv, not env alone).
 */
function isEnabled() {
  if (isDisabledByEnv()) return false;
  return process.argv.includes("--experimental-acp");
}

function register(wireId, instanceId, timeoutCtrl) {
  if (!isEnabled()) return;
  if (!timeoutCtrl || typeof timeoutCtrl.abort !== "function") return;
  if (typeof wireId === "string" && wireId) registry.set(wireId, timeoutCtrl);
  if (typeof instanceId === "string" && instanceId) registry.set(instanceId, timeoutCtrl);
}

function unregister(wireId, instanceId) {
  if (typeof wireId === "string") registry.delete(wireId);
  if (typeof instanceId === "string") registry.delete(instanceId);
}

function lookup(agentId) {
  if (typeof agentId !== "string" || !agentId) return undefined;
  return registry.get(agentId);
}

/**
 * Handler for `_iflow/agent/cancel`. The wire agentId embeds the CLI
 * instanceId + timestamp and is globally unique, so no session scoping is
 * needed (sessionId is accepted for wire symmetry only). Never throws —
 * the method-table case returns this object as the JSON-RPC result.
 */
function cancelAgent(params) {
  if (!isEnabled()) return { stopped: false, reason: "disabled" };
  const h = lookup(params && params.agentId);
  if (!h) return { stopped: false, reason: "not_found" };
  try {
    h.abort("user_stopped");
    return { stopped: true };
  } catch (e) {
    return { stopped: false, reason: "abort_failed" };
  }
}

function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === "function") {
    try { return AbortSignal.any(list); } catch (e) { /* fall through */ }
  }
  // Fallback for Node < 20.3: manual composition. The listener lives for
  // the agent's lifetime only — acceptable.
  const controller = new AbortController();
  for (const s of list) {
    if (s.aborted) { controller.abort(); break; }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Called at executeAgentWithSession entry with the session's wire agentId
 * and the parent signal. Returns the merged signal, or `parentSignal`
 * unchanged when the agent is unknown or the MOD is disabled. Defensive:
 * never throws (call site relies on it inside an expression).
 */
function mergedSignal(agentId, parentSignal) {
  try {
    if (!isEnabled()) return parentSignal;
    const h = lookup(agentId);
    if (!h) return parentSignal;
    const agentSignal = h.getSignal ? h.getSignal() : undefined;
    if (!agentSignal) return parentSignal;
    return anySignal([parentSignal, agentSignal]) || parentSignal;
  } catch (e) {
    return parentSignal;
  }
}

/** True when the agent identified by `id` (either key) was aborted. */
function isAborted(id) {
  try {
    const h = lookup(id);
    if (!h) return false;
    return !!(h.getSignal && h.getSignal().aborted);
  } catch (e) {
    return false;
  }
}

module.exports = { register, unregister, cancelAgent, mergedSignal, isAborted, isEnabled };
