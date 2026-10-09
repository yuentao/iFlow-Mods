/**
 * acp-compress-persist-loader.cjs
 *
 * Decision layer for the acp-compress-persist-refactor MOD.
 *
 * Background (verified in the CLI 0.5.19 bundle, line-by-line):
 *   AcpSession.prompt() handles "/..." prompts via handleAcpSlashCommand() and
 *   EARLY-RETURNS (`if(y.shouldEndTurn)return{stopReason:"end_turn"}`) BEFORE
 *   the per-turn `finally { await this.saveSessionState() }` that normally
 *   persists the session. A slash `/compress` rewrites the in-memory chat
 *   history (executeFullCompression -> updateClientAfterCompression ->
 *   startChat(newHistory)) but never persists it: the ACP session file
 *   (~/.iflow/acp/sessions/<id>.json) keeps the PRE-compression history.
 *   The next `session/load` replays setHistory(fullHistory) and the model
 *   context re-inflates to the uncompressed size. Probed (iflow-harness,
 *   2026-10-08): two compressions of the same session both reported
 *   originalTokenCount 114057 — the first compression had been silently
 *   reverted by a keep-session profile switch (session/load).
 *
 * The patched call site requires this module right after the slash command
 * was handled and calls shouldPersist(cmdText); true makes prompt() await
 * this.saveSessionState() before the early return. saveSessionState is the
 * CLI's own persist path (idempotent, serializes the CURRENT chat — after a
 * successful compression that is the compressed history). Loader missing /
 * throwing -> the original (unpersisted) behaviour is preserved (safe
 * fallback, same discipline as mcp-background-loader).
 *
 * Scope:
 *   - Persists ONLY for compression commands (built-in `compress` plus its
 *     alt names `summarize` / `compact`). Other slash commands do not mutate
 *     chatHistory; the AUTO-compress path runs inside the normal prompt loop
 *     whose finally already saves.
 *   - Persisting after a FAILED compression just rewrites the current
 *     (unchanged) history — harmless, and it keeps the session file's
 *     lastActivity fresh.
 *   - IFLOW_SLASH_PERSIST=0|false explicitly disables the MOD (restores
 *     upstream behaviour).
 *
 * This call site only exists on the ACP prompt path — TUI and -p one-shot
 * compression go through their own persist paths and are unaffected.
 *
 * NOTE: this module MUST NOT write to console - in ACP mode stdout carries
 * the NDJSON protocol stream, and any stray line corrupts the wire.
 */

const COMPRESSION_COMMANDS = new Set(["compress", "summarize", "compact"]);

function isDisabledByEnv() {
  const v = process.env.IFLOW_SLASH_PERSIST;
  return typeof v === 'string' && ['0', 'false'].includes(v.trim().toLowerCase());
}

/**
 * True when `cmdText` (the trimmed prompt text, guaranteed to start with "/"
 * at the call site) invokes the built-in compression command. Mirrors the
 * CLI's own slash parsing closely enough for the gate: first segment before
 * a command separator, first whitespace token, case-insensitive.
 */
function shouldPersist(cmdText) {
  if (isDisabledByEnv()) return false;
  if (typeof cmdText !== 'string' || cmdText.charCodeAt(0) !== 47 /* '/' */) return false;
  const firstSegment = cmdText.slice(1).split(/[&;\r\n]/)[0];
  const name = (firstSegment.trim().split(/\s+/)[0] || '').toLowerCase();
  return COMPRESSION_COMMANDS.has(name);
}

module.exports = { shouldPersist };
