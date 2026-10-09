'use strict';
/**
 * 检索适配器层：给「四层核查」提供真实的外部证据。
 *
 * 统一合约：
 *   search(query, cfg) -> { provider, query, results:[{title,url,snippet,source}], tookMs }
 *
 * 关键点：这一层只负责把**原文(original content)**搬回来，不做任何判断。
 * 判断在 core/verify.js 里做，而且永远是三态定性，从不谎称"已验证无误"。
 *
 * 免费无 key：wikipedia / wikidata / searxng（自建）
 * 需要 key ：tavily / serper / bing / bocha(博查)
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'search.json');

const DEFAULT_CONFIG = {
  provider: 'wikipedia',
  providers: {
    wikipedia: { lang: 'zh', limit: 5 },
    wikidata: { lang: 'zh', limit: 5 },
    searxng: { baseUrl: 'http://127.0.0.1:8080' },
    tavily: { apiKey: '', depth: 'basic' },
    serper: { apiKey: '', gl: 'cn', hl: 'zh-cn' },
    bing: { apiKey: '', market: 'zh-CN' },
    bocha: { apiKey: '', count: 5 },
  },
};

function ensureDirs() { fs.mkdirSync(CACHE_DIR, { recursive: true }); }

/* 2026-10-08 修：用户接入的博查 Key 被清空、后端被改回维基。两个根因——
   ① 旧 loadConfig 只要 JSON 解析失败（例如文件被别的程序存成带 BOM 的 UTF-8），就**用默认值覆盖整个文件**；
   ② 旧 saveConfig 收到空配置（apitest_all.js 就发 {}）会把后端设回 wikipedia、把所有 Key 写成空串。
   现在：读失败只备份坏文件、不覆盖；保存时与磁盘上的旧配置合并，空 Key 不会冲掉已有 Key。 */
async function readConfigFile() {
  try {
    const txt = (await fsp.readFile(CONFIG_FILE, 'utf8')).replace(/^﻿/, '');   // 去 BOM
    return { raw: JSON.parse(txt), exists: true };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { raw: null, exists: false };
    // 文件在、但读不懂：备份一份，绝不覆盖（里面可能有用户的 Key）
    try { await fsp.copyFile(CONFIG_FILE, CONFIG_FILE + `.unreadable-${Date.now()}.bak`); } catch { /* 忽略 */ }
    return { raw: null, exists: true, broken: true };
  }
}
function mergeConfig(base, over) {
  return {
    provider: (over && over.provider) || (base && base.provider) || DEFAULT_CONFIG.provider,
    providers: Object.fromEntries(Object.entries(DEFAULT_CONFIG.providers).map(([k, v]) => {
      const b = (base && base.providers && base.providers[k]) || {};
      const o = (over && over.providers && over.providers[k]) || {};
      const m = { ...v, ...b };
      // 空串/空白不覆盖已有值（防止「什么都没填就点确定」把 Key 冲掉）；要清除 Key 须显式传 clearKey:true
      for (const [kk, vv] of Object.entries(o)) if (vv !== '' && vv != null) m[kk] = vv;
      if (o.clearKey) m.apiKey = '';
      delete m.clearKey;
      return [k, m];
    })),
    fallback: (over && over.fallback) || (base && base.fallback) || ['wikipedia'],
  };
}

async function loadConfig() {
  ensureDirs();
  const { raw, exists } = await readConfigFile();
  if (!exists) {
    await fsp.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    return mergeConfig(null, null);
  }
  return mergeConfig(raw, null);
}

async function saveConfig(cfg) {
  ensureDirs();
  const { raw, broken } = await readConfigFile();
  if (broken) throw new Error('检索配置文件读不懂，已另存备份；为防丢失 Key，本次不写入，请检查 data/search.json');
  // 空配置（{} 或只有空字段）一律视为「不改」，原样返回
  if (!cfg || (!cfg.provider && !cfg.providers && !cfg.fallback)) return mergeConfig(raw, null);
  const merged = mergeConfig(raw, cfg);
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

async function cacheRead(key) {
  try { return JSON.parse(await fsp.readFile(path.join(CACHE_DIR, `${key}.json`), 'utf8')); } catch { return null; }
}
async function cacheWrite(key, val) {
  try { await fsp.writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(val), 'utf8'); } catch { /* 缓存失败不影响主流程 */ }
}

async function http(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${text.slice(0, 300)}`);
  let json = null;
  try { json = JSON.parse(text); } catch { /* 允许纯文本响应 */ }
  return { json, text, status: res.status };
}

// 公开 API（含维基）对突发请求会返回 429/503，退避重试两次再判定失败
async function httpRetry(url, opt) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try { return await http(url, opt); }
    catch (e) {
      lastErr = e;
      if (!/HTTP (429|503|502|504)/.test(String(e.message))) throw e;
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/* 各后端实现                                                          */
/* ------------------------------------------------------------------ */

const PROVIDERS = {
  wikipedia: {
    id: 'wikipedia',
    displayName: '维基百科检索（免费，无需 key）',
    free: true,
    note: '权威度够用、覆盖到人物生卒年与地名沿革，但中文条目偏简略，晚唐五代、宋代中下层人物常缺。',
    async search(q, cfg) {
      const lang = cfg.lang || 'zh';
      const u = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=${cfg.limit || 5}&srsearch=${encodeURIComponent(q)}`;
      const { json } = await httpRetry(u);
      const hits = json?.query?.search || [];
      return hits.map(h => ({
        title: h.title,
        url: `https://${lang}.wikipedia.org/wiki/?curid=${h.pageid}`,
        snippet: String(h.snippet || '').replace(/<[^>]+>/g, ''),
        source: `${lang}.wikipedia.org`,
      }));
    },
  },

  wikidata: {
    id: 'wikidata',
    displayName: 'Wikidata 实体检索（免费，无需 key）',
    free: true,
    note: '查重名最快：同一姓名在世界各地的项目都会被拉出来，适合判断"这个名字是不是已经被某个真人占了"。',
    async search(q, cfg) {
      const lang = cfg.lang || 'zh';
      const u = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=${lang}&limit=${cfg.limit || 5}&search=${encodeURIComponent(q)}`;
      const { json } = await httpRetry(u);
      return (json?.search || []).map(h => ({
        title: h.label || h.id,
        url: `https://www.wikidata.org/wiki/${h.id}`,
        snippet: h.description || '',
        source: 'wikidata.org',
      }));
    },
  },

  searxng: {
    id: 'searxng',
    displayName: 'SearXNG 自建实例（免费，需自己部署）',
    free: true,
    note: '零成本、无配额、能翻多个搜索引擎。代价是要自己跑一个实例，且实例必须开启 JSON 输出。',
    async search(q, cfg) {
      const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
      if (!base) throw new Error('未配置 SearXNG 地址');
      const { json } = await httpRetry(`${base}/search?format=json&q=${encodeURIComponent(q)}`);
      return (json?.results || []).slice(0, cfg.limit || 5).map(h => ({
        title: h.title, url: h.url, snippet: h.content || '', source: 'searxng',
      }));
    },
  },

  tavily: {
    id: 'tavily',
    displayName: 'Tavily（为 LLM 设计的搜索 API，需 key）',
    free: false,
    note: '返回的就是干净的摘要，最适合给核查用。注册给免费额度，够跑几十轮。',
    async search(q, cfg) {
      if (!cfg.apiKey) throw new Error('未配置 Tavily API Key');
      const { json } = await http('https://api.tavily.com/search', {
        method: 'POST',
        body: { api_key: cfg.apiKey, query: q, max_results: cfg.limit || 5, search_depth: cfg.depth || 'basic' },
      });
      return (json?.results || []).map(h => ({ title: h.title, url: h.url, snippet: h.content || '', source: 'tavily' }));
    },
  },

  serper: {
    id: 'serper',
    displayName: 'Serper.dev（Google 结果，需 key）',
    free: false,
    note: 'Google 索引，中文史料和地方志站点召回较好。有免费额度。',
    async search(q, cfg) {
      if (!cfg.apiKey) throw new Error('未配置 Serper API Key');
      const { json } = await http('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': cfg.apiKey },
        body: { q, gl: cfg.gl || 'cn', hl: cfg.hl || 'zh-cn', num: cfg.limit || 5 },
      });
      return (json?.organic || []).map(h => ({ title: h.title, url: h.link, snippet: h.snippet || '', source: 'serper' }));
    },
  },

  bing: {
    id: 'bing',
    displayName: 'Bing Search API / Azure（需 key）',
    free: false,
    note: '微软官方，稳定。Azure 免费层每月有额度。',
    async search(q, cfg) {
      if (!cfg.apiKey) throw new Error('未配置 Bing API Key');
      const u = `https://api.bing.microsoft.com/v7.0/search?mkt=${cfg.market || 'zh-CN'}&count=${cfg.limit || 5}&q=${encodeURIComponent(q)}`;
      const { json } = await http(u, { headers: { 'Ocp-Apim-Subscription-Key': cfg.apiKey }, method: 'GET' });
      return (json?.webPages?.value || []).map(h => ({ title: h.name, url: h.url, snippet: h.snippet || '', source: 'bing' }));
    },
  },

  bocha: {
    id: 'bocha',
    displayName: '博查 AI 搜索（国产，中文语境最好，需 key）',
    free: false,
    note: '国产搜索 API，中文语境与国内站点覆盖最好，按次计费便宜。做中国史模拟优先选它。注意：博查在 key 无效时仍返回 HTTP 200，错误藏在响应体的 code 字段里 —— 本适配器已检查 body.code，会把真实原因报出来。',
    async search(q, cfg) {
      if (!cfg.apiKey) throw new Error('未配置博查 API Key');
      const { json, status } = await http('https://api.bochaai.com/v1/web-search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: { query: q, count: Number(cfg.count) || 5, summary: true, freshness: 'noLimit' },
      });
      // 博查的关键坑：鉴权失败/参数错误时 HTTP 仍是 200，错误在 body.code / body.message
      const code = json && json.code;
      if (code !== undefined && String(code) !== '200') {
        throw new Error(`博查返回错误 code=${code}：${(json && json.message) || '（无说明）'}${String(code) === '401' ? '（API Key 无效或未生效，请到博查控制台核对）' : ''}`);
      }
      if (json && json.message && !json.data) throw new Error(`博查返回：${json.message}`);
      const pages = json?.data?.webPages?.value || json?.data?.value || [];
      return pages.map(h => ({
        title: h.name, url: h.url, snippet: h.summary || h.snippet || '', source: 'bocha',
      }));
    },
  },
};

async function listProviders() {
  const cfg = await loadConfig();
  return Object.values(PROVIDERS).map(p => ({
    id: p.id, displayName: p.displayName, free: p.free, note: p.note,
    configured: isConfigured(p.id, cfg.providers?.[p.id] || {}),
  })).concat([{ id: 'off', displayName: '关闭检索（退化成只做本地审查）', free: true, note: '没有启用检索时，一切史实类结论都标「信息缺口」。', configured: true }]);
}

function isConfigured(id, cfg) {
  if (id === 'wikipedia' || id === 'wikidata' || id === 'off') return true;
  if (id === 'searxng') return !!cfg.baseUrl;
  return !!cfg.apiKey;
}

/**
 * 统一检索入口。后端选择规则（2026-10-08 起）：
 *   ① 用设置里选定的后端（如博查）；调用方显式传 opts.provider 时才用别的（只用于 Wikidata 查重名这种专门用途）；
 *   ② 选定后端报错或零结果时，按 cfg.fallback（默认 ['wikipedia']）依次兜底，并在结果里标明「兜底」；
 *   ③ 选定后端没配好（如博查没填 Key）时，直接走兜底，并把原因写进 note——不再悄悄换后端。
 */
async function search(query, opts = {}) {
  const cfg = await loadConfig();
  const primary = opts.provider || cfg.provider;
  const r = await searchOne(query, primary, cfg, opts);
  if (opts.provider || opts.noFallback || (r.results && r.results.length)) return r;
  for (const fb of (cfg.fallback || ['wikipedia'])) {
    if (fb === primary || !PROVIDERS[fb] || !isConfigured(fb, cfg.providers?.[fb] || {})) continue;
    const r2 = await searchOne(query, fb, cfg, opts);
    if (r2.results && r2.results.length) {
      return { ...r2, fallbackFrom: primary, note: `首选后端「${primary}」${r.error ? '出错：' + r.error : '无结果'}，本次改用「${fb}」兜底` };
    }
  }
  return r;
}

async function searchOne(query, providerId, cfg, opts = {}) {
  if (providerId === 'off') {
    return { provider: 'off', query, results: [], tookMs: 0, error: '检索已关闭' };
  }
  if (PROVIDERS[providerId] && !isConfigured(providerId, cfg.providers?.[providerId] || {})) {
    return { provider: providerId, query, results: [], tookMs: 0, error: `「${PROVIDERS[providerId].displayName}」未配置（多半是 Key 没填）` };
  }
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`未知检索后端：${providerId}`);
  const pcfg = cfg.providers?.[providerId] || {};

  const key = hash(`${providerId}|${pcfg.limit || ''}|${query}`);
  if (!opts.noCache) {
    const hit = await cacheRead(key);
    if (hit) return { ...hit, cached: true };
  }

  const t0 = Date.now();
  try {
    const results = await provider.search(query, pcfg);
    const out = { provider: providerId, query, results, tookMs: Date.now() - t0, at: new Date().toISOString() };
    if (results.length) await cacheWrite(key, out);   // 空结果不缓存，免得一次网络抖动就永远查不到
    return out;
  } catch (e) {
    // 检索失败不等于"没有同名" —— 必须如实报回，让上层标「信息缺口」
    return { provider: providerId, query, results: [], tookMs: Date.now() - t0, error: String(e.message || e) };
  }
}

/**
 * Wikidata SPARQL：用来挖「末年真人极多」那种情况。
 * 通用搜索只能给你一堆条目，SPARQL 能按 生卒年 / 朝代 / 官职 / 亲属关系 精确筛，
 * 并且直接返回结构化的生卒年，不用从正文里猜。
 */
/* Wikidata 查询服务的脾气：同一来源并发或过快就 429，偶尔 502/504、超时；
   连不上时（离线、被墙）每次都要等满超时。对策：
   · 串行 + 至少 1.2 秒间隔（官方建议「别并发」）；
   · 429/5xx/超时退避重试两次，尊重 Retry-After；
   · 连续失败 3 次熔断 5 分钟，期间立即返回错误，由本地人物库兜底，不拖慢开局；
   · 成功结果永久缓存（史实不变），失败不缓存。 */
const WD = { last: 0, chain: Promise.resolve(), fails: 0, openUntil: 0, stats: { queries: 0, cached: 0, ok: 0, fail: 0, retries: 0 } };
function wikidataStats() { return { ...WD.stats, consecutiveFails: WD.fails, paused: Date.now() < WD.openUntil ? new Date(WD.openUntil).toISOString() : null }; }

async function sparqlOnce(query) {
  const wait = WD.last + 1200 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  WD.last = Date.now();
  const res = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query), {
    // Wikidata 要求带 User-Agent，否则直接 403
    headers: { 'User-Agent': 'PivotEngine/0.2 (local history-rpg tool)', accept: 'application/sparql-results+json' },
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`SPARQL HTTP ${res.status} :: ${text.slice(0, 200)}`); e.retryAfter = Number(res.headers.get('retry-after')) || 0; e.status = res.status; throw e; }
  return JSON.parse(text);
}

async function sparql(query, { noCache } = {}) {
  const key = hash('sparql|' + query);
  WD.stats.queries++;
  if (!noCache) { const hit = await cacheRead(key); if (hit) { WD.stats.cached++; return { ...hit, cached: true }; } }
  const t0 = Date.now();
  if (Date.now() < WD.openUntil) {
    WD.stats.fail++;
    return { provider: 'wikidata-sparql', rows: [], tookMs: 0, error: `Wikidata 连续失败，暂停查询至 ${new Date(WD.openUntil).toLocaleTimeString('zh-CN')}（改用本地人物库）` };
  }
  // 串行排队
  const run = WD.chain.then(async () => {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try { return await sparqlOnce(query); }
      catch (e) {
        lastErr = e;
        const transient = e.status === 429 || e.status >= 500 || /timeout|aborted|fetch failed|ECONNRESET/i.test(String(e.message));
        if (!transient || i === 2) break;
        WD.stats.retries++;
        await new Promise(r => setTimeout(r, Math.min(30000, e.retryAfter ? e.retryAfter * 1000 : 1500 * 2 ** i)));
      }
    }
    throw lastErr;
  });
  WD.chain = run.catch(() => {});
  try {
    const json = await run;
    const rows = (json.results?.bindings || []).map(b => Object.fromEntries(
      Object.entries(b).map(([k, v]) => [k, v.value])
    ));
    const out = { provider: 'wikidata-sparql', rows, tookMs: Date.now() - t0, at: new Date().toISOString() };
    await cacheWrite(key, out);
    WD.fails = 0; WD.stats.ok++;
    return out;
  } catch (e) {
    WD.stats.fail++;
    if (++WD.fails >= 3) { WD.openUntil = Date.now() + 5 * 60 * 1000; WD.fails = 0; }
    return { provider: 'wikidata-sparql', rows: [], tookMs: Date.now() - t0, error: String(e.message || e) };
  }
}

module.exports = { wikidataStats, PROVIDERS, listProviders, search, sparql, loadConfig, saveConfig, isConfigured };
