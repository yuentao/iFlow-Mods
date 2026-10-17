'use strict';
// mcp-status-loader.cjs — mcp-status-refactor Mod (iFlow CLI 0.5.19 fork)
//
// Exposes the ACP method `_iflow/mcp/status`: the per-server connection
// state + tool/prompt counts that `/mcp list` already renders in the TUI
// (the Djt status map written by vk(), the discovery state Rjt(), the
// toolRegistry tools stamped with serverName, the promptRegistry counts),
// plus the tool DECLARATIONS (name/description/schema) so a client can
// render a detail view and estimate the context the server injects, and
// the last connection error captured on the k2n failure path.
//
// Gating: `_iflow/mcp/status` only answers under --experimental-acp and
// IFLOW_MCP_STATUS not in {0,false}; otherwise {available:false,reason}.
// The record/recordError taps are always-on (Map writes only, no output).
// NEVER write console — ACP stdout carries the NDJSON wire.

// name -> last connection error message (captured at the k2n catch site).
const errors = new Map();
// Mirror of the bundle's Djt status map, fed by the vk() tap. Used only
// when attach() never ran (MCP module not yet initialized); the attached
// live reader (Ese) is preferred because it also reflects the default.
const statuses = new Map();

let readStatus = null; // Ese: (name) => 'connected'|'connecting'|'disconnected'
let readDiscovery = null; // Rjt: () => 'not_started'|'in_progress'|'completed'

function attach(ese, rjt) {
  try {
    if (typeof ese === 'function') readStatus = ese;
    if (typeof rjt === 'function') readDiscovery = rjt;
  } catch (e) {}
}

function record(name, status) {
  try {
    if (typeof name === 'string' && typeof status === 'string') statuses.set(name, status);
  } catch (e) {}
}

function recordError(name, err) {
  try {
    const msg = err && err.message ? String(err.message) : String(err);
    if (typeof name === 'string') errors.set(name, msg.slice(0, 500));
  } catch (e) {}
}

// Same buckets the CLI's own error classifier uses (bundle: protocol_error /
// network_error / timeout / unknown), plus spawn_failed for ENOENT command
// launches — the single most common misconfiguration (missing binary).
function classifyError(msg) {
  const r = String(msg || '').toLowerCase();
  if (r.includes('enoent')) return 'spawn_failed';
  if (r.includes('timeout')) return 'timeout';
  if (r.includes('protocol')) return 'protocol_error';
  if (r.includes('fetch') || r.includes('network')) return 'network_error';
  return 'unknown';
}

function enabled() {
  if (!process.argv.includes('--experimental-acp')) return false;
  const v = process.env.IFLOW_MCP_STATUS;
  return !(v === '0' || v === 'false');
}

// Per-server tools JSON cap: a pathological schema dump must not blow the
// 8MB NDJSON frame cap of the ACP client. Over the cap the schema is
// dropped (name/description stay) and schemaOmitted flags the degradation.
const TOOLS_JSON_BUDGET = 4 * 1024 * 1024;

function toolViews(tools) {
  const out = [];
  let budget = TOOLS_JSON_BUDGET;
  for (const t of tools) {
    let description;
    try {
      description = typeof t.description === 'string' ? t.description.slice(0, 2000) : undefined;
    } catch (e) {}
    let schema;
    try {
      schema = t.schema ? t.schema.parametersJsonSchema ?? t.schema.parameters : undefined;
    } catch (e) {}
    const view = { name: String(t.name ?? ''), description };
    if (schema !== undefined) {
      let json;
      try {
        json = JSON.stringify(schema);
      } catch (e) {
        json = undefined;
      }
      if (json !== undefined && json.length <= budget) {
        view.schema = schema;
        budget -= json.length;
      } else {
        view.schemaOmitted = true;
      }
    }
    out.push(view);
  }
  return out;
}

// Resolve a Config: prefer the requested session's (its discovery fleet owns
// the toolRegistry the client should count), fall back to the agent's startup
// config (settings card opened before any session exists).
function resolveConfig(agent, params) {
  try {
    const sid = params && params.sessionId;
    const sessions = agent && agent.sessions;
    if (sid && sessions && sessions.get) {
      const sess = sessions.get(sid);
      if (sess && typeof sess.getConfig === 'function') {
        const c = sess.getConfig();
        if (c && typeof c.getMcpServers === 'function') return c;
      }
    }
  } catch (e) {}
  const cfg = agent && agent.config;
  return cfg && typeof cfg.getMcpServers === 'function' ? cfg : null;
}

async function status(agent, params) {
  if (!enabled()) return { available: false, reason: 'disabled', servers: {} };
  let config;
  try {
    config = resolveConfig(agent, params);
  } catch (e) {
    config = null;
  }
  if (!config) return { available: false, reason: 'no_config', servers: {} };
  try {
    const serversCfg = config.getMcpServers() || {};
    let registry = null;
    let promptRegistry = null;
    try {
      if (typeof config.getToolRegistry === 'function') registry = await config.getToolRegistry();
    } catch (e) {}
    try {
      if (config.getPromptRegistry) promptRegistry = await config.getPromptRegistry();
    } catch (e) {}
    const allTools = registry && registry.getAllTools ? registry.getAllTools() : [];
    const out = Object.create(null);
    for (const name of Object.keys(serversCfg)) {
      const st = readStatus ? readStatus(name) : statuses.get(name) || 'disconnected';
      let tools = [];
      let promptViews = [];
      try {
        tools = allTools.filter((t) => t && t.serverName === name);
      } catch (e) {}
      try {
        if (promptRegistry && promptRegistry.getPromptsByServer)
          promptViews = (promptRegistry.getPromptsByServer(name) || []).map((p) => ({
            name: String(p && p.name ? p.name : ''),
            description: p && typeof p.description === 'string' ? p.description.slice(0, 2000) : undefined,
          }));
      } catch (e) {}
      const entry = { status: st, toolCount: tools.length, promptCount: promptViews.length, tools: toolViews(tools), prompts: promptViews };
      if (serversCfg[name] && serversCfg[name].disabled) entry.disabled = true;
      const err = errors.get(name);
      if (err && st !== 'connected') {
        entry.error = err;
        entry.errorKind = classifyError(err);
      }
      out[name] = entry;
    }
    try {
      const blocked = typeof config.getBlockedMcpServers === 'function' ? config.getBlockedMcpServers() || [] : [];
      for (const b of blocked) {
        if (b && b.name && !out[b.name])
          out[b.name] = { status: 'disconnected', toolCount: 0, promptCount: 0, tools: [], prompts: [], blocked: true };
      }
    } catch (e) {}
    return {
      available: true,
      discoveryState: readDiscovery ? readDiscovery() : 'unknown',
      servers: out,
    };
  } catch (e) {
    return { available: false, reason: 'probe_failed', servers: {} };
  }
}

module.exports = { attach, record, recordError, status };
