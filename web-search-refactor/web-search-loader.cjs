// web-search-loader.cjs — iFlow-Mods web-search-refactor loader (2026-10-15).
//
// Why (probed 2026-10-15 on the custom.8 vendor bundle):
//  - web_search tool class (Name="web_search") is registered at the single site
//    bB()==="aone"?new j0e(this.config):new u3(this.config); the iFlow variant
//    (u3) POSTs {keywords,num} to https://platform.iflow.cn/api/search/webSearch
//    with Authorization Bearer config.getSearchApiKey(), which falls back to the
//    profile apiKey (getSearchApiKey(){return this.searchApiKey??this.contentGeneratorConfig?.apiKey}).
//  - That endpoint is alive but iFlow-key-only: a third-party OpenAI-compatible
//    profile key gets {"success":false,"code":"90402","message":"无效的API Key"}
//    (verified via direct POST without auth: same shape) => the tool always
//    errors on third-party profiles — the "web_search no longer usable" symptom.
//
// What: patchClass(u3) replaces the CLASS PROTOTYPE executeInternal (covers every
// instance: main-session ToolRegistry createToolRegistry() r(u3,this) site AND
// SubAgentManager initializeAvailableTools site).
// (default iflow -> bing -> ddg). Upstream runs FIRST so iFlow-login users keep
// the official endpoint; auth-reject/empty falls through to scraping.
// Bing b_algo HTML scrape verified reachable from the CN dev box (www.bing.com
// and cn.bing.com each returned 10+ b_algo blocks); DDG html endpoint was
// unreachable there (VPN/abroad users only, best-effort parse).
//
// Config ~/.iflow/web-search.json (seeded by the harness from iflow-defaults):
//   {engines:[...], num, timeoutMs, bingHosts:[...]}
// Env overrides: IFLOW_WS_ENGINES="bing,ddg"; IFLOW_WEB_SEARCH=0|false reverts.
//
// Return contract matches upstream exactly:
//   {llmContent, returnDisplay, sources:[{web:{uri,title}}]}
// with per-item block "\n[N] title: …\ndate: …\nlink: …\nsnippet: …\n".

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULTS = {
  engines: ["iflow", "bing", "ddg"],
  num: 15,
  timeoutMs: 15000,
  bingHosts: ["www.bing.com", "cn.bing.com"],
};
const UA = "Mozilla/5.29 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit 605 (KHTML, like Safari) AppleWebKit 537.36.99.61 (KHTML, like Safari)";

let cfgCache = null;
function dbg() { return (process.env.IFLOW_WS_DEBUG || "") === "1"; }

function cfg() {
  try {
    const base = process.env.IFLOW_HOME || os.homedir();
    const p = path.join(base, ".iflow", "web-search.json");
    const st = fs.statSync(p);
    if (cfgCache && cfgCache.mtime === st.mtimeMs) return cfgCache.value;
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    cfgCache = { mtime: st.mtimeMs, value: parsed };
    return parsed;
  } catch (e) {
    return DEFAULTS;
  }
}

function envList(name) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return null;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function decodeEntities(s) {
  if (!s) return "";
  let out = s;
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)));
  out = out.replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)));
  out = out.replace(/&nbsp;/g, " ");
  out = out.replace(/&ensp;/g, " ");
  out = out.replace(/&emsp;/g, " ");
  out = out.replace(/&hellip;/g, "…");
  out = out.replace(/&quot;/g, '"');
  out = out.replace(/&apos;|&#39;/g, "'");
  out = out.replace(/&lt;/g, "<");
  out = out.replace(/&gt;/g, ">");
  out = out.replace(/&amp;/g, "&");
  return out;
}

function cleanText(s) {
  if (!s) return "";
  const t = decodeEntities(s.replace(/<[^>]*>/g, " "));
  const c = t.replace(/\s+/g, " ").trim();
  return c.length > 500 ? c.slice(0, 500) : c;
}

function timeFilter(tbs) {
  if (!tbs) return null;
  const m = /qdr:(\d*)([dwmy])/.exec(tbs);
  if (!m) return null;
  const n = m[1] ? parseInt(m[1]) : 1;
  if (n > 1) return null;
  return m[2];
}

async function htmlFetch(url, outerSignal, timeoutMs, headers, form) {
  if (outerSignal && outerSignal.aborted) throw new Error("aborted");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  if (outerSignal) {
    try { outerSignal.addEventListener("abort", () => ac.abort()); } catch (e) {}
  }
  try {
    const opts = {
      method: form ? "POST" : "GET",
      headers: Object.assign({ "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7" }, headers || {}),
      signal: ac.signal,
    };
    if (form) opts.body = form;
    const r = await fetch(url, opts);
    const text = await r.text();
    if (!r.ok) throw new Error("HTTP " + r.status);
    if (!text || text.length < 200) throw new Error("empty page");
    return text;
  } finally {
    clearTimeout(t);
  }
}

function parseBing(html, num) {
  const out = [];
  const segs = html.split(/<li[^>]+class="b_algo/).slice(1);
  for (const seg of segs) {
    if (out.length >= num) break;
    const s = seg.slice(0, 2500);
    let url = null, title = null;
    const lm = /<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/.exec(s);
    if (lm) { url = lm[1]; title = cleanText(lm[2]); }
    if (!url) {
      const lm2 = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{4,300}?)<\/a>/.exec(s);
      if (lm2) { url = lm2[1]; title = cleanText(lm2[2]); }
    }
    if (!url || !title) continue;
    let snippet = null;
    const sm = /<div class="b_caption"><p class="[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(s) || /<p class="b_(?:lineclamp\d+|snippet)[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(s);
    if (sm) snippet = cleanText(sm[1]);
    let date = null;
    if (snippet) {
      const dm = /^(\d{4}年\d{1,2}月\d{1,2}日|\w{3} \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/.exec(snippet);
      if (dm) {
        date = dm[1];
        let rest = snippet.slice(dm[1].length);
        const bi = rest.indexOf("·");
        if (bi >= 0 && bi < 8) rest = rest.slice(bi + 1);
        snippet = rest.trim() || snippet;
      }
    }
    out.push({ url, title, snippet, date });
  }
  return out;
}

async function bingSearch(q, num, tbs, outerSignal, timeoutMs, hosts) {
  let lastErr = null;
  const list = hosts && hosts.length ? hosts : DEFAULTS.bingHosts;
  for (const host of list) {
    try {
      let url = "https://" + host + "/search?q=" + encodeURIComponent(q) + "&count=" + Math.min(Math.max(num, 1), 30) + "&setmkt=zh-CN&setlang=zh-CN";
      const tf = timeFilter(tbs);
      if (tf === "d") url += "&filters=" + encodeURIComponent('ex1:"ez1"');
      else if (tf === "w") url += "&filters=" + encodeURIComponent('ex1:"ez2"');
      else if (tf === "m") url += "&filters=" + encodeURIComponent('ex1:"ez3"');
      const html = await htmlFetch(url, outerSignal, timeoutMs, null, null);
      const items = parseBing(html, num);
      if (items.length > 0) return items;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return [];
}

function parseDdg(html, num) {
  const out = [];
  const snippets = [];
  const snRe = /<a[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m2;
  while ((m2 = snRe.exec(html)) !== null) snippets.push(cleanText(m2[1]));
  const linkRe = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let mm, i = 0;
  while ((mm = linkRe.exec(html)) !== null && out.length < num) {
    let href = mm[1];
    if (href.startsWith("//")) href = "https:" + href;
    let url = href;
    const um = /[?&]uddg=([^&]+)/.exec(href);
    if (um) { try { url = decodeURIComponent(um[1]); } catch (e) {} }
    if (!/^https?:/i.test(url)) continue;
    out.push({ url, title: cleanText(mm[2]), snippet: snippets[i++] || null, date: null });
  }
  return out;
}

async function ddgSearch(q, num, tbs, outerSignal, timeoutMs) {
  let form = "q=" + encodeURIComponent(q) + "&kl=wt-wt";
  const tf = timeFilter(tbs);
  if (tf) form += "&df=" + tf;
  const html = await htmlFetch("https://html.duckduckgo.com/html/", outerSignal, timeoutMs, { "Content-Type": "application/x-www-form-urlencoded" }, form);
  return parseDdg(html, num);
}

function format(q, items) {
  let A = "";
  const src = [];
  items.forEach((it, i) => {
    const t = it.title || "Untitled";
    const u = it.url || "No link";
    const d = it.date || "No time";
    const sn = it.snippet || "No snippet";
    A += "\n[" + (i + 1) + "] title: " + t + "\n";
    A += "date: " + d + "\n";
    A += "link: " + u + "\n";
    A += "snippet: " + sn + "\n";
    if (it.url) src.push({ web: { uri: it.url, title: t } });
  });
  return {
    llmContent: 'Web search results for query "' + q + '":\n' + A,
    returnDisplay: "Searched web: " + q + " (" + items.length + " results)",
    sources: src,
  };
}

function disabled() {
  const v = (process.env.IFLOW_WEB_SEARCH || "").toLowerCase();
  return v === "0" || v === "false";
}

const patchedProtos = new WeakSet();

function patchClass(cls) {
  if (disabled()) return;
  let proto = null;
  try { proto = cls.prototype; } catch (e) { return; }
  if (!proto || typeof proto.executeInternal !== "function") return;
  if (patchedProtos.has(proto)) return;
  patchedProtos.add(proto);
  if (dbg()) console.error("[ws-loader] patching class prototype executeInternal");
  const orig = proto.executeInternal;
  proto.executeInternal = async function (params, outerSignal, logReq, logResp, telemetry) {
    const self = this;
    if (dbg()) console.error("[ws-loader] override ENTER q=" + (params && params.query));
    if (!params || !params.query || String(params.query).trim() === "") {
      return { llmContent: "Invalid parameters: query is required.", returnDisplay: "Invalid parameters" };
    }
    const q = String(params.query);
    const c = cfg();
    const num = typeof params.num === "number" && Number.isFinite(params.num) ? params.num : (typeof c.num === "number" ? c.num : 15);
    const timeoutMs = typeof c.timeoutMs === "number" ? c.timeoutMs : 15000;
    let engines = Array.isArray(c.engines) && c.engines.length ? c.engines : DEFAULTS.engines;
    const envE = envList("IFLOW_WS_ENGINES");
    if (envE) engines = envE;
    const t0 = Date.now();
    let lastUpstream = null;
    const errs = [];
    for (const eng of engines) {
      try {
        if (eng === "iflow") {
          const r = await orig.call(self, params, outerSignal, logReq, logResp, telemetry);
          if (r && Array.isArray(r.sources) && r.sources.length > 0) return r;
          lastUpstream = r;
          continue;
        }
        let items = null;
        if (eng === "bing") items = await bingSearch(q, num, params.tbs, outerSignal, timeoutMs, c.bingHosts);
        else if (eng === "ddg") items = await ddgSearch(q, num, params.tbs, outerSignal, timeoutMs);
        if (items && items.length > 0) {
          if (logReq) { try { logReq({ engine: eng, query: q }); } catch (e) {} }
          if (telemetry) { try { telemetry(Date.now() - t0, true, void 0, items.length, q); } catch (e) {} }
          return format(q, items);
        }
      } catch (e) {
        if (dbg()) console.error("[ws-loader] engine err:", eng, e && e.message || String(e));
        errs.push(eng + ": " + (e && e.message ? e.message : String(e)));
      }
    }
    if (dbg()) console.error("[ws-loader] final: engines=" + engines.join(",") + " errs=" + errs.length);
    if (errs.length > 0) {
      const msg = errs.join("; ");
      return {
        llmContent: 'Error during web search for query "' + q + '": ' + msg,
        returnDisplay: "Web search failed: " + q,
      };
    }
    if (lastUpstream) return lastUpstream;
    return {
      llmContent: 'No web search results for query "' + q + '".',
      returnDisplay: "No results",
    };
  };
}

exports.patchClass = patchClass;
exports.disabled = disabled;
