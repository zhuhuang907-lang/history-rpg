'use strict';
/**
 * 大模型调用的「护栏」：让 DeepSeek 这类接口在长局里稳定可用。
 * 针对它的典型短板：
 *   · Key 失效 / 欠费（401/402/403）：重试毫无意义 → 熔断 10 分钟，后续调用立刻失败、不再每次卡 3 分钟；
 *   · 高峰期限流 / 服务繁忙（429/5xx/超时）：退避重试（尊重 Retry-After），最多两次；
 *   · 并发一多就被限：同一适配器同时最多 2 个请求，其余排队；
 *   · JSON 时好时坏：要求「只输出 JSON」的调用自动开 JSON 模式，返回后再做宽松修复，
 *     仍不合法就让模型自己修一次（低温、短输出）；
 *   · 抽取类调用（低温/只要 JSON）结果短期缓存，同样的问题不重复花钱；正文生成不缓存（「重来」要新文本）。
 * 统计：调用数、失败、重试、token 用量、熔断状态，可在 /api/health 查看。
 */

const BREAKER_MS = 10 * 60 * 1000;
const MAX_CONCURRENT = 2;

/**
 * DeepSeek 的高峰按北京时间算（白天到午夜最挤，凌晨最空）。美国玩家的白天恰好落在北京凌晨，
 * 是一天里最快、最稳的时段。高峰时：并发降到 1、超时放宽，避免排队请求互相拖垮。
 */
function beijingHour(now = Date.now()) { return new Date(now + 8 * 3600 * 1000).getUTCHours() + new Date(now + 8 * 3600 * 1000).getUTCMinutes() / 60; }
function peakInfo(now = Date.now()) {
  const h = beijingHour(now);
  const offPeak = h >= 0.5 && h < 8.5;                     // 北京 00:30–08:30
  return { beijingHour: Math.floor(h), peak: !offPeak, label: offPeak ? '北京凌晨·低谷（最快）' : (h >= 9 && h < 23 ? '北京白天·高峰' : '北京深夜·次高峰') };
}
const maxConcurrent = () => (peakInfo().peak ? 1 : MAX_CONCURRENT);
const CACHE_MS = 10 * 60 * 1000;

const state = new Map(); // adapterId -> { active, queue, openUntil, why, stats }
const cache = new Map();

function slot(id) {
  if (!state.has(id)) state.set(id, { active: 0, queue: [], openUntil: 0, why: '', lat: [], stats: { calls: 0, ok: 0, fail: 0, retries: 0, cached: 0, repaired: 0, promptTokens: 0, completionTokens: 0 } });
  return state.get(id);
}

async function acquire(s) {
  if (s.active < maxConcurrent()) { s.active++; return; }
  await new Promise(res => s.queue.push(res));
  s.active++;
}
function release(s) { s.active--; const n = s.queue.shift(); if (n) n(); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isAuth = m => /HTTP (401|402|403)\b/.test(m);
const isTransient = m => /HTTP (408|409|425|429|500|502|503|504)\b|timeout|aborted|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(m);
const wantsJson = p => /只(输出|用|回答?)\s*JSON|只输出\s*json|JSON\s*格式输出|输出合法\s*JSON/i.test(`${p.system || ''}\n${String(p.prompt || '').slice(-1500)}`);

function stripThink(t) { return String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(); }

/** 宽松修复：去代码围栏、取最外层 {}/[]、去尾逗号、中文引号 → 英文引号 */
function looseJson(text) {
  let t = stripThink(text);
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = Math.min(...['{', '['].map(c => { const i = t.indexOf(c); return i < 0 ? Infinity : i; }));
  if (a === Infinity) return null;
  const close = t[a] === '{' ? '}' : ']';
  const b = t.lastIndexOf(close);
  if (b <= a) return null;
  let s = t.slice(a, b + 1);
  const tries = [s, s.replace(/,\s*([}\]])/g, '$1'), s.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1')];
  for (const x of tries) { try { JSON.parse(x); return x; } catch { /* next */ } }
  return null;
}

function cacheKey(id, p, cfg) {
  return `${id}|${cfg.model || ''}|${p.temperature ?? ''}|${p.maxTokens ?? ''}|${p.system || ''}|${p.prompt || ''}`;
}

function guard(adapter) {
  if (!adapter || adapter.__guarded || adapter.kind !== 'llm' || adapter.id === 'skeleton') return adapter;
  const raw = adapter.call.bind(adapter);
  const wrapped = Object.create(adapter);
  wrapped.__guarded = true;
  wrapped.call = async (params, cfg = {}) => {
    const s = slot(adapter.id);
    s.stats.calls++;
    if (!cfg.__noBreaker && Date.now() < s.openUntil) {
      s.stats.fail++;
      throw new Error(`HTTP 401 ${adapter.id} 已暂停调用（${s.why}），${Math.ceil((s.openUntil - Date.now()) / 60000)} 分钟后自动重试；请到「设置」核对 API Key 或余额。`);
    }
    const json = params.json ?? wantsJson(params);
    const cacheable = json || (params.temperature != null && params.temperature <= 0.3);
    const key = cacheable ? cacheKey(adapter.id, params, cfg) : null;
    if (key) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) { s.stats.cached++; s.stats.ok++; return hit.res; }
    }
    await acquire(s);
    try {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          let res;
          // 自适应超时：按最近 20 次耗时的最大值 ×2.5 估计（不低于默认），高峰再放宽 1.5 倍
          const recent = s.lat.slice(-20);
          if (!cfg.timeoutMs && recent.length >= 3) {
            const est = Math.max(...recent) * 2.5 * (peakInfo().peak ? 1.5 : 1);
            cfg = { ...cfg, timeoutMs: Math.min(300000, Math.max(90000, Math.round(est))) };
          }
          const t0 = Date.now();
          try { res = await raw({ ...params, json }, cfg); }
          catch (e) {
            // 有的兼容接口不认 response_format：去掉 JSON 模式再试一次
            if (json && /HTTP 400/.test(String(e.message)) && /response_format|json/i.test(String(e.message))) res = await raw({ ...params, json: false }, cfg);
            else throw e;
          }
          s.lat.push(Date.now() - t0); if (s.lat.length > 50) s.lat.shift();
          const u = res && res.meta && res.meta.usage;
          if (u) { s.stats.promptTokens += u.prompt_tokens || 0; s.stats.completionTokens += u.completion_tokens || 0; }
          res = { ...res, text: stripThink(res.text) };
          if (json) {
            const fixed = looseJson(res.text);
            if (fixed) res.text = fixed;
            else if (!params.__repair) {
              // 让模型自己把格式修好：低温、短输出，比整轮重跑便宜得多
              const rep = await wrapped.call({ system: '你是 JSON 修复器。把用户给的内容改成合法 JSON，保持原有字段与内容，不增删信息。只输出 JSON。', prompt: String(res.text).slice(0, 12000), temperature: 0, maxTokens: params.maxTokens, __repair: true, json: true }, cfg);
              const ok = looseJson(rep.text);
              if (ok) { res.text = ok; s.stats.repaired++; }
            }
          }
          s.stats.ok++;
          s.openUntil = 0;
          if (key) { cache.set(key, { at: Date.now(), res }); if (cache.size > 300) cache.delete(cache.keys().next().value); }
          return res;
        } catch (e) {
          lastErr = e;
          const m = String(e && e.message || e);
          if (isAuth(m)) { s.openUntil = Date.now() + BREAKER_MS; s.why = /402/.test(m) ? '余额不足' : 'Key 无效或未授权'; break; }
          if (!isTransient(m) || attempt === 2) break;
          s.stats.retries++;
          const ra = Number((m.match(/retry-after[^0-9]*(\d+)/i) || [])[1]);
          await sleep(Math.min(20000, ra ? ra * 1000 : 2000 * (attempt + 1) + Math.random() * 1000));
        }
      }
      s.stats.fail++;
      throw lastErr;
    } finally { release(s); }
  };
  return wrapped;
}

function stats() {
  const out = {};
  for (const [id, s] of state) out[id] = { ...s.stats, avgMs: s.lat.length ? Math.round(s.lat.reduce((a, b) => a + b, 0) / s.lat.length) : null, active: s.active, queued: s.queue.length, breaker: Date.now() < s.openUntil ? { open: true, why: s.why, until: new Date(s.openUntil).toISOString() } : { open: false } };
  return { peak: peakInfo(), adapters: out };
}

module.exports = { peakInfo, guard, stats, looseJson, stripThink, wantsJson };
