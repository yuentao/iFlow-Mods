# web-search-refactor

Replace the built-in `web_search` tool backend.

## Why (probed 2026-10-15, CLI 0.5.19 custom.8 bundle)

- The tool class (`Name="web_search"`, iFlow variant `u3`) POSTs
  `{keywords,num}` to `https://platform.iflow.cn/api/search/webSearch` with
  `Authorization: Bearer <config.getSearchApiKey()>`.
- `getSearchApiKey()` is `this.searchApiKey ?? contentGeneratorConfig?.apiKey`,
  so a third-party OpenAI-compatible profile sends ITS OWN key to the iFlow
  platform search endpoint.
- That endpoint is alive but iFlow-key-only: direct probe without auth returns
  `{"success":false,"code":"90402","message":"...invalid API key..."}`.
  Result: `web_search` always errors on third-party profiles ("no longer
  usable"), while iFlow-login users still work.

## What

Single-point patch at the main-session registration in
`createToolRegistry()`:

```
bB()==="aone"?r(j0e,this):r(u3,this)
```

The Aone branch stays untouched; `web-search-loader.cjs` `patchClass(u3)`
replaces the CLASS PROTOTYPE `executeInternal` (instance-level wrapping at the
other site — SubAgentManager `new u3(this.config)` — does NOT cover the
executed instance: `createToolRegistry()` re-instantiates via `r(cls,...)` ->
`new n(...o)`; prototype patch covers both sites' instances):

1. `iflow` — upstream call first (keeps the official endpoint for iFlow keys);
   accepted only when it returns non-empty `sources`.
2. `bing` — HTML scrape of `www.bing.com` (fallback `cn.bing.com`), `b_algo`
   blocks; verified reachable from the CN dev machine (10+ results per query).
3. `ddg` — `html.duckduckgo.com` POST form; best-effort parse, unreachable
   from the CN dev machine at probe time (for VPN/abroad users).

Return contract is byte-shaped like upstream:
`{llmContent, returnDisplay, sources:[{web:{uri,title}}]}` with per-item
block `[N] title: ... / date: ... / link: ... / snippet: ...`.

## Config

`~/.iflow/web-search.json` (seeded by iFlow-harness from
`vendor/iflow-defaults/`):

```json
{ "engines": ["iflow","bing","ddg"], "num": 15, "timeoutMs": 15000,
  "bingHosts": ["www.bing.com","cn.bing.com"] }
```

Env overrides: `IFLOW_WS_ENGINES="bing,ddg"` (comma list),
`IFLOW_WEB_SEARCH=0|false` reverts to upstream behavior entirely.

## Verification

- Loader unit test: fake instance + `IFLOW_WS_ENGINES=bing` -> 5 results,
  upstream auth-error result ignored and chain continued.
- `apply-patch.mjs` on the vendor bundle: anchor count 1, round-trip OK.
- `test/fixtures/probe-web-search.mjs` (iFlow-harness): full ACP round-trip
  with `IFLOW_WS_ENGINES=bing`, expects the loader returnDisplay marker
  (`Searched web:` in session/update tool_call_update — wire carries returnDisplay
  only) and no "Search capability"/`90402` text.

## Notes

- Tool registration gate `config.getSearchApiKey()` truthiness is unchanged:
  profiles with an EMPTY apiKey still do not expose web_search (out of scope).
- `web_fetch`/`xinliu_web_fetch` keep their own platform-proxy paths
  (web_fetch already has urlContext fallback) — not touched by this mod.
- After a CLI bundle version bump, re-derive the anchor
  (`apply-patch.mjs` hard-fails on drift).
