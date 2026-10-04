/**
 * mcp-background-loader.cjs
 *
 * Decision layer for the mcp-background-discovery-refactor MOD.
 *
 * Background (verified in the CLI 0.5.19 bundle, line-by-line):
 *   Config.initialize() -> createToolRegistry() -> await discoverAllTools(isNonInteractive)
 *   and isNonInteractive is constructed as `... || argv.experimentalAcp`, so
 *   --experimental-acp (ACP headless mode) hits the SYNCHRONOUS branch
 *   `await this.mcpClientManager.discoverAllMcpTools()`, which Promise.all()s
 *   every server's connect()+discover() with NO timeout. An npx-type server
 *   whose npm registry is unreachable hangs forever -> initialize() never
 *   resolves -> the ACP handshake never completes -> editor extensions block.
 *   The interactive TUI (isNonInteractive=false) already uses the
 *   fire-and-forget startMcpDiscoveryInBackground() path and is unaffected.
 *
 * The patched discoverAllTools() method body requires this module and calls
 * shouldBackground(isNonInteractive); true switches the call to the CLI's own
 * background discovery path. Loader missing / throwing -> falsy -> the original
 * behaviour is preserved (safe fallback, same discipline as
 * stream-toolcall-repair-loader).
 *
 * Scope:
 *   - Backgrounds ONLY when isNonInteractive===true AND --experimental-acp is
 *     present in argv. -p/--prompt one-shot runs keep the original
 *     synchronous wait, otherwise the process would exit before MCP tools
 *     ever register.
 *   - IFLOW_MCP_BACKGROUND=0|false explicitly disables the MOD (restores
 *     upstream behaviour).
 *
 * NOTE: this module MUST NOT write to console - in ACP mode stdout carries
 * the NDJSON protocol stream, and any stray line corrupts the wire.
 */

function isDisabledByEnv() {
  const v = process.env.IFLOW_MCP_BACKGROUND;
  return typeof v === 'string' && ['0', 'false'].includes(v.trim().toLowerCase());
}

function isAcpMode(argv) {
  return (argv ?? process.argv).some(
    (a) => typeof a === 'string' && (a === '--experimental-acp' || a.startsWith('--experimental-acp='))
  );
}

function shouldBackground(isNonInteractive, argv) {
  if (isDisabledByEnv()) return false;
  return isNonInteractive === true && isAcpMode(argv);
}

module.exports = { shouldBackground, isAcpMode, isDisabledByEnv };
