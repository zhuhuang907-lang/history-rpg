'use strict';
/**
 * 档案馆（历史锚定协议）
 * ------------------------------------------------------------------
 * 把"按 身份 / 时代 / 地理 差异化、且来源可靠"的历史底盘，统一聚合成一份
 * 带「来源 + 可信度」标注的结构，并持久化到 data/archive/。
 *
 * 用户痛点：数据必须因 身份 / 时代 / 地理 而不同，且要"可靠搜索和估计"。
 * 这里每一项数据都标注它从哪来、可信度几何（offline / rulepack / wikidata /
 * search / estimate / generated），让引擎与玩家都能看清底层可靠性，而不是
 * 把"随机生成"和"已核实史实"混为一谈。
 *
 * 设计原则：
 *   1) 离线可跑 —— 君主(帝王年表)、派系(规则包)、数字上限(按时代折算)、
 *      时代观念，全部离线、高/中可靠，无需联网。
 *   2) 已联网取得的真实数据（geography / 同代真人）直接复用 state 里已有的，
 *      不重复检索，只补来源标注。
 *   3) 持久化 —— 每局底盘写入 data/archive/<saveId>.json，"档案馆"逐局累积
 *      已核实数据，跨会话复用。
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ARCHIVE_DIR = path.join(ROOT, '..', 'data', 'archive');

/* 来源约定
 *   offline   —— 离线年表/内置数据（秦→清帝王年表），高可靠
 *   rulepack  —— 规则包内置（eventsByEra / 派系框架 / 数字上限），中高
 *   wikidata  —— Wikidata 真实人物/地理，高
 *   search    —— 检索后端（博查等）补全，中
 *   estimate  —— 大模型估算（虚构人物年龄等），低
 *   generated —— 引擎生成（未联网核实），中低
 * 可信度：high | medium | low
 */
function ensureDir() {
  try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); } catch { /* 忽略 */ }
}

function stamp(value, source, confidence, note) {
  return { value, source: source || 'generated', confidence: confidence || 'medium', note: note || '' };
}

function safeRequire(p) {
  try { return require(p); } catch { return null; }
}

/* 时代观念：eraVocab 是"现代→古代"通用转译，对所有前现代通用；
   这里只挑"观念"类条目（若规则包有分区），让用户看到本局被要求遵循的时代观念底线。 */
function pickEraVocab(map) {
  if (!Array.isArray(map)) return [];
  const concept = map.filter(e => e.cat === '观念');
  const pool = concept.length ? concept : map;
  return pool.slice(0, 8).map(e => ({ modern: e.m, ancient: e.a, cat: e.cat || '' }));
}

/**
 * 聚合本局历史底盘。纯离线可跑；已联网取得的真实数据直接复用 state。
 * @param {object} state 游戏状态
 * @param {object} pack  规则包（用于 eventsByEra）
 * @returns {object} 带来源/可信度标注的上下文
 */
function worldContext(state, pack) {
  const clock = state.clock || {};
  const loc = state.location || {};
  const idm = state.identityModule || 'official';
  const year = Number(clock.gregorianYear) || 0;
  const polity = loc.polity || '';
  const eraLabel = clock.yearLabel || '';
  const place = loc.full || '';

  const ctx = {
    identity: idm,
    eraLabel, gregorianYear: year, polity, place,
    ruler: null,
    eraEvents: [],
    factions: [],
    numericCeiling: null,
    eraVocab: [],
    geography: null,
    persons: [],
    generatedAt: new Date().toISOString(),
  };

  // —— 当朝天子：离线帝王年表（覆盖秦→清任意政权+公元年），高可靠 ——
  const eraData = safeRequire('./era-data');
  if (eraData && eraData.resolveRuler) {
    const r = eraData.resolveRuler(polity, year);
    if (r) {
      ctx.ruler = stamp({
        name: r.name, title: r.title || '皇帝',
        age: r.born ? year - r.born + 1 : null,
        born: r.born || null, died: r.died || null, polity: r.polity || polity,
      }, 'offline', 'high', '离线帝王年表（秦→清），按政权+公元年精确定位该年在位君主');
    }
  }
  if (!ctx.ruler && state.reigningSovereign) {
    ctx.ruler = stamp({ name: state.reigningSovereign }, 'generated', 'medium', '由引擎依年号/年代锚定的当朝天子');
  }

  // —— 天下大势：规则包内置真实事件（按 时代 区分），或 state.eraEvents ——
  const evs = (pack && pack.eventsByEra && state.eraPresetId && pack.eventsByEra[state.eraPresetId])
    || state.eraEvents || [];
  ctx.eraEvents = (Array.isArray(evs) ? evs : []).map(e => {
    const text = (typeof e === 'string') ? e : (e.text || e.event || JSON.stringify(e));
    return stamp(text, 'rulepack', 'medium', '规则包内置真实事件（按本局时代选取）');
  });

  // —— 派系/内斗：已按 时代+身份 生成（FACTION_PAIRS） ——
  ctx.factions = (state.factions || []).map(f => stamp(f, 'rulepack', 'medium', '按朝代党争框架生成，成员须依史实指认，引擎不随机塞人'));

  // —— 数字上限：按 时代 折算 ——
  const numeric = safeRequire('./numeric');
  if (numeric && numeric.renderNumericGuide) {
    ctx.numericCeiling = stamp(numeric.renderNumericGuide(state), 'rulepack', 'medium', '按行政级别与本局时代折算的量级上限（先算再写）');
  }

  // —— 时代观念：按 时代 适用（前现代通用，依规则包观念类条目） ——
  const eraVocab = safeRequire('./eraVocab');
  if (eraVocab && eraVocab.MAP) ctx.eraVocab = pickEraVocab(eraVocab.MAP);

  // —— 地理：已是真实检索结果（维基正文抽取），保留来源 ——
  if (state.geography) {
    const src = (state.geography.source && state.geography.source !== '') ? 'wikidata' : 'generated';
    ctx.geography = stamp(state.geography, src, src === 'wikidata' ? 'high' : 'low', '真实地理检索，未查到的字段为「不详」，不编造');
  }

  // —— 同代真人：已是真实检索结果（Wikidata） ——
  const persons = [].concat(state.npcs || [], state.historicalNpcs || [])
    .filter(n => n && n.source === 'historical');
  ctx.persons = persons.slice(0, 24).map(n => stamp({
    name: n.name, role: n.role || '', age: (n.age == null ? null : n.age),
    nativePlace: n.nativePlace || '', born: n.born || null, died: n.died || null, qid: n.qid || '',
  }, 'wikidata', 'high', 'Wikidata 真实同代人物'));

  return ctx;
}

/** 档案文件名（与 saveId 一一对应） */
function archiveFile(saveId) {
  return path.join(ARCHIVE_DIR, `${String(saveId).replace(/[^\w.-]/g, '_')}.json`);
}

/**
 * 持久化：把本局底盘写入 data/archive/<saveId>.json
 * 注意：档案馆**不是**每回合另起一份。它是本局的**唯一底盘**，
 *   · 权威副本在 world state 里（state.archive），回合之间随之更新；
 *   · 这里是它的磁盘镜像，供随时调阅，不作为第二个事实来源。
 */
function saveArchive(saveId, ctx) {
  ensureDir();
  const file = archiveFile(saveId);
  try { fs.writeFileSync(file, JSON.stringify(ctx, null, 2), 'utf8'); return file; } catch { return null; }
}

function loadArchive(saveId) {
  const file = archiveFile(saveId);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 删档连带删档案馆：档案馆依附于存档存在，存档没了它就没有意义 */
function deleteArchive(saveId) {
  const file = archiveFile(saveId);
  try {
    fs.unlinkSync(file);
    return { ok: true, deleted: file };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, missing: true };
    return { ok: false, why: String(e && e.message || e) };
  }
}

/** 清理孤儿：存档已不在、档案馆却还在的残留（本库一度积了 23 份） */
function sweepOrphans(knownSaveIds) {
  ensureDir();
  const alive = new Set((knownSaveIds || []).map(x => String(x).replace(/[^\w.-]/g, '_')));
  let files = [];
  try { files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json')); } catch { return { removed: 0, kept: 0, files: [] }; }
  const orphan = files.filter(f => !alive.has(f.replace(/\.json$/, '')));
  for (const f of orphan) {
    try { fs.unlinkSync(path.join(ARCHIVE_DIR, f)); } catch { /* 单个删不掉不影响其余 */ }
  }
  return { removed: orphan.length, kept: files.length - orphan.length, files: orphan };
}

function srcTag(s) { return `来源:${s.source}·可信:${s.confidence}`; }
function rulerText(r) {
  const v = r.value;
  const age = (v.age == null) ? '' : `${v.age}岁`;
  return `${v.name}（${v.title || '皇帝'}${age ? '，' + age : ''}） 〔${srcTag(r)}〕`;
}
function geoText(g) {
  const v = g.value || {};
  const keys = ['地形', '水系', '道路驿站', '距州治', '邻境', '物产', '常发灾异'];
  const parts = keys.filter(k => v[k] && v[k] !== '不详').map(k => `${k}:${v[k]}`);
  return (parts.length ? parts.join('；') : '（详见档案地理栏）') + ` 〔${srcTag(g)}〕`;
}

/** 给 GM 提示词用的可读底盘（带来源/可信度标注） */
/**
 * 把底盘渲染成给模型的提示词块。
 *
 * 旧实现的毛病：这里第一行就是 `worldContext(state, pack)`——**每回合现算一份**，
 * 于是同一局里同时存在三份互不联通的底盘：
 *   ① seed 时落盘的 data/archive/<saveId>.json（快照，之后再不更新）
 *   ② state.archive（seed 时写进存档的那份）
 *   ③ 本函数每回合现算的 ctx（模型实际看到的）
 * 三份会随世界推进各自漂移，所谓"档案馆"并不存在，只是每回合临时拼的一段文字。
 *
 * 改法：**单一事实来源 = state.archive**。
 *   有就直接用，不再重算；只有在它还没建（老档）时才现算一次并回填，
 *   之后回合之间始终读同一份，从而真正联通。
 */
function renderArchiveBlock(state, pack, opts = {}) {
  let ctx = (state && state.archive) || null;
  if (!ctx && opts != null && typeof opts === 'object' && opts.ctx) ctx = opts.ctx;   // 显式指定时从之
  if (!ctx) ctx = worldContext(state, pack);   // 老档兜底：现算一次
  if (state && !state.archive) state.archive = ctx; // 回填，保证下次起就用同一份
  const L = [];
  L.push('=== 历史底盘（按 身份 / 时代 / 地理 差异化提供，每项标注来源与可信度） ===');
  L.push(`身份：${ctx.identity}｜时代：${ctx.eraLabel || '?'}（公元 ${ctx.gregorianYear || '?'} 年）｜政权：${ctx.polity || '?'}｜地点：${ctx.place || '?'}`);
  if (ctx.ruler) L.push(`当朝天子：${rulerText(ctx.ruler)}`);
  if (ctx.eraEvents.length) L.push('天下大势：\n' + ctx.eraEvents.map(e => `  · ${e.value} 〔${srcTag(e)}〕`).join('\n'));
  if (ctx.factions.length) L.push('派系/内斗：\n' + ctx.factions.map(f => {
    const name = (f.value && (f.value.name || f.value.label)) || JSON.stringify(f.value);
    return `  · ${name} 〔${srcTag(f)}〕`;
  }).join('\n'));
  if (ctx.numericCeiling && ctx.numericCeiling.value) L.push('数字量级（先算再写）：\n' + String(ctx.numericCeiling.value).split('\n').map(x => '  ' + x).join('\n') + `\n  〔${srcTag(ctx.numericCeiling)}〕`);
  if (ctx.eraVocab.length) L.push('时代观念底线（不可出现现代观念）：' + ctx.eraVocab.map(v => `${v.modern}→${v.ancient}`).join('；'));
  if (ctx.geography) L.push(`地理：${geoText(ctx.geography)}`);
  if (ctx.persons.length) L.push(`同代真人（前 ${ctx.persons.length} 位）：${ctx.persons.map(p => `${p.value.name}(${p.value.role || '?'})`).join('、')}`);
  L.push('（凡标「估计/生成」的字段，须在剧情中谨慎对待；标「离线/维基」的方为已核实史实。）');
  // 明确告诉模型：这是本局唯一、跨回合一致的历史底盘，不是每回合临时拼的一段字。
  // 旧实现每回合现算一份，模型会以为底盘随回合漂移，于是敢自行补充"史实"。
  L.push('【重要】以上档案馆是本局唯一权威底盘，各回合均指向同一份，不会逐回合变化；');
  L.push('需要查证身份、年号、地理、数字量级、观念底线或同代真人时，一律以此为准，不得另行臆造，也不得改写。');
  return L.join('\n');
}

module.exports = { worldContext, saveArchive, loadArchive, deleteArchive, sweepOrphans, archiveFile, renderArchiveBlock, stamp, ensureDir, ARCHIVE_DIR };
