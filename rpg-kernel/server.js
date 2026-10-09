'use strict';
/** 零依赖 HTTP 服务：静态托管 + JSON API。Node 22+。 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const engine = require('./core/engine');
const adapters = require('./adapters/index');
const search = require('./adapters/search');
const verify = require('./core/verify');
const battle = require('./core/battle');
const events = require('./core/events');
const eraVocab = require('./core/eraVocab');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function send(res, code, obj, isJson = true) {
  res.writeHead(code, { 'content-type': isJson ? 'application/json; charset=utf-8' : MIME['.html'] });
  res.end(isJson ? JSON.stringify(obj) : String(obj));
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await fsp.readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': MIME['.html'] });
    res.end('404');
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const routes = {
  'GET /api/health': async () => ({ ok: true, node: process.version, llm: require('./adapters/guard').stats(), wikidata: require('./adapters/search').wikidataStats ? require('./adapters/search').wikidataStats() : null }),
  'GET /api/rulepacks': async () => engine.listRulepacks(),
  'GET /api/saves': async () => engine.listSaves(),
  'GET /api/adapters': async () => adapters.listAdapters(),

  async 'POST /api/save'(body) {
    return engine.createSave(body);
  },
  async 'POST /api/save/custom'(body) {
    return engine.createCustomSave(body);
  },
  async 'POST /api/save/delete'(body) {
    return engine.deleteSave(body.saveId);
  },
  async 'POST /api/state'(body) {
    return engine.loadState(body.saveId);
  },
  async 'POST /api/turn'(body) {
    // 允许调用方关掉自动改写：body.autoRepair = false。
    // 「自己会改」是用户反复抱怨的一点——程序替模型改正文必须可以关闭，
    // 且改过之后必须留痕（autoRepaired / autoRepairReason / originalScene）。
    const r = await engine.runTurn(body || {});
    // 若适配器掉到了本地骨架，正文会是占位符——必须明确告知，
    // 否则用户只看到「AI 没反馈内容」，完全查不出原因。
    const scene = String((r && r.draft && r.draft.scene) || '');
    if (/骨架输出/.test(scene)) {
      return {
        ...r,
        placeholder: true,
        why: '当前未接入叙事框架：模型适配器不可用（多半是 Key 未配置或未选定）。请到「模型设置」里选定适配器并填好 API Key，再用本回合重试。',
      };
    }
    return r;
  },
  async 'POST /api/apply'(body) {
    const s = await engine.applyDraft(body);
    // 拒绝采纳时必须原样透出。过去这里一律包成 { ok:true, state }，
    // 于是「过期草稿 / 剧情作弊 / 剧情硬伤」三道拦截在界面上全都显示「成功」——
    // 明明被拦下了，玩家却以为生效了。这是实打实的功能 bug。
    if (s && s.ok === false) return s;
    // 预取：玩家读新局面、批案牍的这段时间里，后台先把下一轮必查的史料查好放进缓存。
    // 下一轮真正检索时直接命中缓存，回合更快，也不怕那一刻检索源抽风。
    setImmediate(async () => {
      try {
        const qs = require('./core/factcheck').planPreSearch(s, '');
        for (const q of qs) await search.search(q, { noCache: false }).catch(() => null);
      } catch (_) { /* 预取失败无妨 */ }
    });
    return { ok: true, state: s };
  },
  /* ---- 朝政 / 案牍（不依赖大模型） ---- */
  async 'POST /api/court'(body) {
    const court = require('./core/court');
    const s = await engine.loadState(body.saveId);
    court.generate(s);
    await engine.writeState(s);
    return { ok: true, ...court.view(s) };
  },
  async 'POST /api/court/decide'(body) {
    const court = require('./core/court');
    const s = await engine.loadState(body.saveId);
    const r = court.decide(s, body.id, body.option);
    if (!r.ok) return r;
    court.generate(s);
    await engine.writeState(s);
    return { ok: true, text: r.text, ...court.view(s), state: s };
  },
  async 'POST /api/thread'(body) {
    return engine.updateThread(body);
  },
  async 'POST /api/npc'(body) {
    return engine.updateNpc(body);
  },
  async 'POST /api/identity'(body) {
    return engine.changeIdentity(body);
  },
  /* ---- 纠正记录库 ---- */
  // 任意真实人物自动建档（模型 API + 检索 + 程序校验）；已有档案直接返回
  async 'POST /api/figure/generate'(body) { return engine.generateFigure(body || {}); },
  // GM 规范第九、十章：档案卡 / 速查表 / 人物表（同时写入 历史RPG存档/<存档名>/）
  async 'POST /api/gm-cards'(body) { return engine.getGmCards((body || {}).saveId); },
  // 《设计书》§7.6：玩家一键标记（好看/出戏/错史/无聊）
  async 'POST /api/flag'(body) { return engine.flagTurn(body || {}); },
  // 《设计书》§8.12：统计面板
  async 'POST /api/stats'(body) { return engine.getStats((body || {}).saveId); },
  async 'POST /api/correction'(body) { return engine.addCorrection(body); },
  async 'POST /api/correction/list'(body) { return engine.getCorrections(body.saveId); },
  /* ---- 人判断打勾（由用户填，系统不自评） ---- */
  async 'POST /api/human-check'(body) { return engine.setHumanChecks(body); },
  /* ---- 版本化档案卡 ---- */
  async 'POST /api/cards'(body) { return engine.listCards(body.saveId); },
  async 'POST /api/archive-card'(body) {
    const s = await engine.loadState(body.saveId);
    return { card: engine.archiveCard(s) };
  },
  async 'POST /api/adapter-test'(body) {
    // 未配 Key / 认证失败 / 网络不通，都要如实告诉玩家哪一步不行，
    // 不能把 HTTP 401 的原始堆栈甩到界面上
    try {
      return await adapters.testAdapter(body.adapterId, body.config);
    } catch (e) {
      const m = String(e && e.message || e);
      let hint = '';
      if (/401|Unauthorized|Authentication/i.test(m)) hint = '（API Key 未配置或已失效，请核对后重试）';
      else if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(m)) hint = '（网络不通，请检查代理或网络后重试）';
      return { ok: false, why: `适配器「${body.adapterId || '?'}」测试失败：${m} ${hint}`.trim() };
    }
  },
  'GET /api/adapter-config': async () => adapters.loadAdapterConfig(),
  async 'POST /api/adapter-config'(body) {
    return adapters.saveAdapterConfig(body);
  },

  /* ---- 检索与事实核查 ---- */
  'GET /api/search/providers': async () => ({
    providers: await search.listProviders(),
    current: await verify.providerStatus(),
  }),
  'GET /api/search/config': async () => search.loadConfig(),
  async 'POST /api/search/config'(body) {
    await search.saveConfig(body.config || {});
    return search.loadConfig();
  },
  async 'POST /api/search/test'(body) {
    const r = await search.search(body.query || '苏轼', { provider: body.provider, noCache: true });
    return { provider: r.provider, tookMs: r.tookMs, error: r.error, count: (r.results || []).length, top: (r.results || [])[0] || null };
  },
  async 'POST /api/verify/npc'(body) { return verify.verifyNpcName(body); },
  async 'POST /api/verify/realperson'(body) { return verify.verifyRealPersonDeep(body); },
  async 'POST /api/verify/candidates'(body) { return verify.findCandidates(body); },
  'GET /api/lore': async () => engine.listLore(),
  async 'POST /api/lore'(body) { return engine.saveLore(body); },
  async 'POST /api/world/update'(body) {
    const s = await engine.loadState(body.saveId);
    if (body.household) s.household = { ...(s.household || {}), ...body.household };
    if (body.geography) s.geography = { ...(s.geography || {}), ...body.geography };
    if (body.anchors) s.anchors = { ...(s.anchors || {}), ...body.anchors };
    await engine.writeState(s);
    return s;
  },
  /* ---- 战阵 ---- */
  'GET /api/battle/catalog': async () => ({ formations: battle.listFormations(), tactics: battle.listTactics() }),
  async 'POST /api/battle/simulate'(body) {
    const A = {
      name: body.ourName || '我军', troops: Number(body.ourTroops) || 1000,
      morale: Number(body.ourMorale), training: Number(body.ourTraining),
      formationId: body.ourFormation, tacticId: body.ourTactic || 'none',
    };
    const B = {
      name: body.enemyName || '敌军', troops: Number(body.enemyTroops) || 1000,
      morale: Number(body.enemyMorale), training: Number(body.enemyTraining),
      formationId: body.enemyFormation || 'fangyuan', tacticId: body.enemyTactic || 'none',
    };
    if (body.ourSupply != null && body.ourSupply !== '') A.supply = Number(body.ourSupply);
    if (body.ourNavy != null) A.navy = Number(body.ourNavy);
    return battle.resolveBattle(A, B, { terrain: body.terrain, weather: body.weather, seed: body.seed || String(Date.now()), crossing: body.crossing || undefined, walls: Number(body.walls) || 0 });
  },
  /* ---- 突发事件预览（引擎每轮自行掷，此处供玩家查看本局事件史） ---- */
  async 'POST /api/events/log'(body) {
    const s = await engine.loadState(body.saveId);
    return { eventLog: s.eventLog || [], current: s.currentEvent || null, variety: events.varietyEstimate() };
  },

  /* ---- 时代词汇 ---- */
  'GET /api/era-vocab': async () => ({ count: eraVocab.MAP.length, entries: eraVocab.listModern() }),
  async 'POST /api/era-vocab/translate'(body) {
    return { input: body.text || '', hits: eraVocab.scanModern(body.text || ''), block: eraVocab.renderTranslation(body.text || '') };
  },

  async 'POST /api/world/seed'(body) {
    // 开局自动生成世界：真实历史人物（免费 Wikidata）+ 真实地理检索 + 当时的真实历史地图
    return engine.seedWorld({ saveId: body.saveId, adapterId: body.adapterId });
  },
  async 'POST /api/world/fill'(body) {
    // 让所选叙事框架按史实拟一份家庭/地理，结果标 unverified，由玩家核实后才算数
    const { resolveAdapter, loadAdapterConfig } = require('./adapters/index');
    const saved = await loadAdapterConfig();
    const { adapter, config } = await resolveAdapter(body.adapterId || 'deepseek', saved.configs?.[body.adapterId || 'deepseek'] || {});
    const ask = `你要为一次历史模拟拟资料。时代：${body.era}（公元 ${body.gregorianYear} 年）。地点：${body.place}。主角：${body.name}，${body.role}。
请只用 JSON 回答，不要任何解释文字，格式：
${body.what === 'geography'
        ? '{"地形":"","水系":"","道路驿站":"","距州治":"","邻境":"","物产":"","常发灾异":"","note":"不确定处写「不知」，不要编造"}'
        : '{"clan":"","members":[{"name":"","relation":"","age":0,"status":"在世","role":"","attitude":"","note":""}],"property":{"田":"","宅":"","奴婢":""},"obligations":[""]}'}
要求：所有内容必须与该朝代该地的真实情况相符；人物的家人若是真实历史人物则用真名，若是虚构则取一个该时代合理的姓名并注明。不确定的一律写「不知」。`;
    const r = await adapter.call({ system: '你是历史资料编纂助手。只输出 JSON。', prompt: ask }, config);
    let data = null;
    try {
      let t = String(r.text).trim();
      const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) t = fence[1].trim();
      data = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    } catch { return { error: '框架返回的不是合法 JSON：' + String(r.text).slice(0, 200) }; }
    return { data, unverified: true };
  },
  /* ---- 世界运行：24 项世界状态 / 经济 / 信息 / NPC 动向 / 分歧 ---- */
  async 'POST /api/world/panel'(body) { return engine.getWorld(body.saveId); },
  async 'POST /api/world/replot'(body) { return engine.replotSave(body || {}); },
  /* ---- 人物长线核实：全名籍体检（不只主角） ---- */
  async 'POST /api/world/figures'(body) { return engine.auditFigures((body || {}).saveId); },
  /* ---- 开局初始化检查（内部审计，与玩家正文分离） ---- */
  async 'POST /api/init/check'(body) { return engine.checkInit((body || {}).saveId, body || {}); },
  /* ---- 行为能力闸门：他此刻能做什么、不能做什么、政务由谁决 ---- */
  async 'POST /api/capability'(body) {
    try {
      const capability = require('./core/capability');
      const state = await engine.loadState((body || {}).saveId);
      const c = capability.capabilityOf(state);
      return { ok: true, ...c, prompt: capability.renderCapability(state) };
    } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
  },
  /* ---- 剧情系统：玩家可见层 / 后台日志（两者分离，不得混） ---- */
  async 'POST /api/plot/list'(body) { return engine.getPlot((body || {}).saveId); },
  async 'POST /api/plot/audit'(body) { return engine.getPlotAudit((body || {}).saveId); },
  async 'POST /api/plot/effect'(body) { return engine.recordPlotEffect(body || {}); },
  /* ---- 档案馆：按 身份/时代/地理 差异化的、带来源/可信度的历史底盘 ----
     档案馆是本局唯一的底盘（state.archive），回合之间联通，不是每回合另起一份。 */
  async 'POST /api/archive'(body) {
    const saveId = (body || {}).saveId;
    try {
      const ctx = await engine.getArchive(saveId);
      return { ok: true, saveId, archive: ctx };
    } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
  },
  /** 随时调阅：支持按板块取（identity/era/factions/persons/geography/numeric/vocab） */
  async 'POST /api/archive/query'(body) {
    const b = body || {};
    try {
      const ctx = await engine.getArchive(b.saveId);
      if (!ctx) return { ok: false, why: '本局尚无档案馆，请先开局（seed）' };
      if (!b.section) return { ok: true, saveId: b.saveId, sections: Object.keys(ctx), archive: ctx };
      const key = String(b.section);
      return { ok: true, saveId: b.saveId, section: key, value: ctx[key] ?? null };
    } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
  },
  /** 删档连带删馆 + 清理孤儿残留 */
  async 'POST /api/archive/sweep'(body) {
    try { return { ok: true, ...(await engine.sweepArchives((body || {}).saveIds)) }; }
    catch (e) { return { ok: false, why: String(e && e.message || e) }; }
  },
  /* ---- 快照与回滚（规范第八十三至八十五章） ---- */
  async 'POST /api/snapshot/list'(body) { return engine.getSnapshots(body.saveId); },
  async 'POST /api/snapshot/now'(body) { return engine.snapshotNow(body.saveId); },
  async 'POST /api/snapshot/rollback'(body) { return engine.rollbackSave(body); },
  async 'POST /api/snapshot/repair'(body) { return engine.getRepairPlan(body.saveId); },
  async 'POST /api/snapshot/impact'(body) { return engine.getImpact(body.saveId, body.code); },
  /* ---- 历史锚点 / 因果链 / 反事实检验 ---- */
  async 'POST /api/history/anchor'(body) { return engine.addHistoryAnchor(body); },
  async 'POST /api/history/causal'(body) { return engine.addCausal(body); },
  async 'POST /api/history/counterfactual'(body) { return engine.runCounterfactual(body); },
  /* ---- NPC 决策：他到底答不答应 ---- */
  async 'POST /api/npc/decide'(body) { return engine.npcDecide(body); },
  /* ---- 档案核定：按搜索结果核定主角真实身份（修复「点错成皇帝」/ 身份不随搜索变） ---- */
  async 'POST /api/dossier/identify'(body) { return engine.identifyDossier(body); },
  async 'POST /api/dossier/apply'(body) { return engine.applyDossierToSave(body); },
  async 'POST /api/dossier/state'(body) { return engine.getDossier(body); },

  async 'POST /api/verify/person'(body) { return verify.verifyPerson(body); },
  async 'POST /api/verify/place'(body) { return verify.verifyPlace(body); },
  async 'POST /api/verify/term'(body) { return verify.verifyTerm(body); },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') body = await readBody(req);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return serveStatic(req, res, url.pathname);
  try {
    const out = await handler(body, url.searchParams);
    send(res, 200, out);
  } catch (e) {
    // 业务错误（参数不对、找不到、未配置 Key）统一回 {ok:false, why}，
    // 让前端能看懂原因；旧版一律 500 + 堆栈，界面上只显示 undefined。
    // 堆栈留在服务端日志里排障，不进响应。
    console.error(`[${key}]`, e && e.stack || e);
    send(res, 200, { ok: false, why: String(e && e.message || e) });
  }
});

engine.ensureDirs();
fs.mkdirSync(adapters.ADAPTER_DIR, { recursive: true });

server.listen(PORT, HOST, () => {
  console.log(`枢引擎 running: http://${HOST}:${PORT}`);
});
