/**
 * acp-context-report-loader.cjs
 *
 * Decision + write layer for the acp-context-report-refactor MOD.
 *
 * Background (verified in the CLI 0.5.19 bundle, line-by-line):
 *   GeminiClient.startChat() assembles the FULL system instruction right
 *   before constructing the chat:
 *     `let m=this.config.getUserMemory(),d; ... d=await P0e(this.config,m),
 *      this.appendSystemPrompt&&(d=d+'\r\n'+this.appendSystemPrompt); ...
 *      this.chat=new K(this.config,this.getContentGenerator(),{systemInstruction:d,...})`
 *   `d` is the final system prompt the model receives. P0e() ends with
 *   `return `${core}${windowsWarning}\n\n---\n${userMemory.trim()}`` — the
 *   joined hierarchical memory (global memory.md + every AGENTS.md/IFLOW.md,
 *   each delimited by "--- Context from: <path> ---" markers) is ALREADY
 *   embedded in it (probed: systemPrompt 71954ch fully contains userMemory
 *   45189ch which fully contains every context file). Reporting the memory
 *   or per-file bodies separately would duplicate the same bytes three times
 *   in the harness card, so the report carries ONLY `systemPrompt`.
 *   None of this ever reaches the ACP wire — the editor panel cannot show the
 *   user what the model actually sees.
 *
 * The patched startChat() call site requires this module and calls
 * report(config, systemPrompt, userMemory); the loader writes a JSON snapshot
 * to the file named by IFLOW_HARNESS_CONTEXT_FILE (atomic temp+rename,
 * overwrite per startChat call — startChat runs on session/new, session/load
 * and approval-mode changes, so the file always holds the CURRENT request
 * context). iflow-harness reads it to render the "auto-injected context"
 * card. Loader missing / throwing / gate off -> the call is a no-op and the
 * bundle behaves exactly like upstream.
 *
 * Scope:
 *   - Reports ONLY under --experimental-acp AND only when
 *     IFLOW_HARNESS_CONTEXT_FILE is set (the harness panel sets it per
 *     window). TUI and -p one-shot runs never write anything.
 *   - IFLOW_ACP_CONTEXT_REPORT=0|false explicitly disables the MOD.
 *
 * NOTE: this module MUST NOT write to console - in ACP mode stdout carries
 * the NDJSON protocol stream, and any stray line corrupts the wire.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isDisabledByEnv() {
  const v = process.env.IFLOW_ACP_CONTEXT_REPORT;
  return typeof v === 'string' && ['0', 'false'].includes(v.trim().toLowerCase());
}

function isAcpMode(argv) {
  return (argv ?? process.argv).some(
    (a) => typeof a === 'string' && (a === '--experimental-acp' || a.startsWith('--experimental-acp='))
  );
}

function readSafe(fn) {
  try {
    return typeof fn === 'function' ? fn() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the context report. Never throws: every failure path (missing env,
 * gate off, serialization, disk) degrades to "no report written", leaving the
 * previous file in place (the harness treats a stale file as best-effort).
 */
function report(config, systemPrompt, userMemory, argv) {
  try {
    if (isDisabledByEnv() || !isAcpMode(argv)) return;
    const out = process.env.IFLOW_HARNESS_CONTEXT_FILE;
    if (!out) return;
    // userMemory is intentionally NOT reported: the final systemPrompt
    // (P0e's return value) already embeds the full joined hierarchical memory
    // including every context-file body (see header). `d` is what the model
    // receives — reporting it alone is complete transparency without
    // duplicating the same bytes.
    const payload = {
      version: 2,
      capturedAt: new Date().toISOString(),
      cwd: readSafe(() => config && config.getTargetDir && config.getTargetDir()) || null,
      model: readSafe(() => config && config.getModel && config.getModel()) || null,
      systemPrompt: typeof systemPrompt === 'string' ? systemPrompt : null,
    };
    const dir = path.dirname(out);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.ctx-report-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, out);
  } catch {
    /* never disturb the agent loop */
  }
}

module.exports = { report };
