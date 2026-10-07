/**
 * api-config-isolation-loader.cjs
 *
 * Decision layer for the api-config-isolation-refactor MOD.
 *
 * Background (verified in the CLI 0.5.19 bundle, line-by-line):
 *   The core settings module resolves the USER settings file as
 *   `eJ = join(homedir(), ".iflow", "settings.json")` hard-coded to homedir
 *   (it does NOT honour IFLOW_HOME). `saveSettings` (BMi) is the single
 *   choke point every `settings.setValue("User", ...)` funnels through, and
 *   it serialises the WHOLE in-memory User settings back to that shared
 *   file. When the iFlow-harness VSCode extension authenticates the child
 *   CLI (openai-compatible creds), the pushed apiKey/baseUrl/modelName get
 *   persisted into the shared ~/.iflow/settings.json — leaking the panel's
 *   API config to every other process (terminal CLI, other editors).
 *
 * The patched saveSettings() body requires this module and calls
 * intercept(t) with the {path, settings} payload:
 *   - returns undefined                  -> write proceeds untouched
 *   - returns a new {path, settings}     -> that object is written instead
 *   - returns null                       -> the write is skipped
 * Loader missing / throwing -> the original behaviour is preserved (safe
 * fallback, same discipline as mcp-background-loader).
 *
 * Isolation semantics (harness mode only):
 *   The panel-owned fields (selectedAuthType, apiKey, baseUrl, searchApiKey,
 *   modelName, currentApiProfile) are NEVER written from the child's memory.
 *   Instead whatever value the file on disk ALREADY has for those keys is
 *   preserved verbatim — so terminal users' credentials survive untouched
 *   (a plain delete would wipe them) while the panel's credentials never
 *   leak. Every other field (apiProfiles catalogue, language, approvalMode,
 *   mcpServers, tokensLimit…) persists normally.
 *
 * Scope:
 *   - Active ONLY when IFLOW_HARNESS is truthy (set by the harness
 *     extension's spawn env) AND the write target is exactly the user-level
 *     ~/.iflow/settings.json. Project-level settings writes and every other
 *     process keep the upstream behaviour.
 *   - IFLOW_API_ISOLATION=0|false explicitly disables the MOD (restores
 *     upstream behaviour).
 *
 * NOTE: this module MUST NOT write to console - in ACP mode stdout carries
 * the NDJSON protocol stream, and any stray line corrupts the wire.
 */

const STRIP_KEYS = ["selectedAuthType", "apiKey", "baseUrl", "searchApiKey", "modelName", "currentApiProfile"];

function isDisabledByEnv() {
  const v = process.env.IFLOW_API_ISOLATION;
  return typeof v === "string" && ["0", "false"].includes(v.trim().toLowerCase());
}

function isHarnessMode() {
  const v = process.env.IFLOW_HARNESS;
  return typeof v === "string" && v !== "" && !["0", "false"].includes(v.trim().toLowerCase());
}

// The exact user-settings path the CLI's core module writes (its own
// resolution is hard-coded homedir, mirrored here).
function userSettingsPath() {
  const path = require("node:path");
  const os = require("node:os");
  return path.join(os.homedir(), ".iflow", "settings.json");
}

function isUserSettingsFile(p) {
  if (typeof p !== "string" || !p) return false;
  const path = require("node:path");
  try {
    return path.resolve(p) === userSettingsPath();
  } catch {
    return false;
  }
}

/**
 * @param {{path: string, settings: object}} t the saveSettings payload
 * @returns {undefined | {path: string, settings: object} | null}
 *   undefined = untouched, object = write this instead, null = skip write
 */
function intercept(t) {
  if (isDisabledByEnv() || !isHarnessMode()) return undefined;
  if (!t || typeof t !== "object" || !isUserSettingsFile(t.path)) return undefined;
  const s = t.settings;
  if (!s || typeof s !== "object") return undefined;
  if (!STRIP_KEYS.some((k) => k in s)) return undefined; // nothing to isolate
  // Preserve the on-disk values of the panel-owned keys (terminal users'
  // creds survive verbatim); drop them from the child's memory view.
  let disk = {};
  try {
    const fs = require("node:fs");
    if (fs.existsSync(t.path)) disk = JSON.parse(fs.readFileSync(t.path, "utf-8")) || {};
  } catch {
    disk = {}; // unreadable/invalid — dropping the keys beats leaking them
  }
  const merged = {};
  for (const k of Object.keys(s)) {
    if (!STRIP_KEYS.includes(k)) merged[k] = s[k];
  }
  for (const k of STRIP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(disk, k)) merged[k] = disk[k];
  }
  return { path: t.path, settings: merged };
}

module.exports = { intercept, STRIP_KEYS };