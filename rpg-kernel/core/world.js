'use strict';
/**
 * 世界状态机
 *
 * 对应规范第三章（世界不是场景，而是状态系统）、第四十七章（环境独立运行）、
 * 第六十至六十二章（季节/天气/市场）、第九十二章（宏观—中观—微观三层）。
 *
 * 要点：
 *   1. 世界状态结构化（24 项），任何重大事件后都要更新对应项；
 *   2. 玩家什么都不做，世界也继续跑（税收、农事、物价、天气、疫病、军队调动）；
 *   3. 每一轮都能给出「这一轮世界到底改了什么」的差异（供 P15 回归审计）。
 */
const { eco, initEconomy, tickEconomy } = require('./economy');

/* 二十四项世界状态及其默认值 */
function pad(v) { return v == null || v === '' ? '?' : v; }
function stripYear(label) {
  let t = String(label || '?').trim();
  // 「大业十一年（已跨年…）」这类附注先去掉，避免把说明文字也带进来
  t = t.replace(/（[^）]*）/g, '').trim();
  return /[年载]$/.test(t) ? t : (t === '?' ? t : t + '年');
}

const SECTIONS = [
  // 年号本身常已带「年」（如「大业十一年」），不能再补一个「年」
  ['时间', s => `${stripYear((s.clock && s.clock.yearLabel) || '?')}${pad(s.clock && s.clock.month)}月${pad(s.clock && s.clock.day)}日（${(s.clock && s.clock.season) || '?'}）`],
  ['地理', s => (s.location && s.location.full) || '未登记'],
  ['政治', s => `政权：${(s.location && s.location.polity) || '未登记'}；控制者：${(s.location && s.location.controller) || '未登记'}`],
  ['行政', s => `治所在 ${(s.location && s.location.full) || '?'}；主官 ${(s.npcs || [])[0] ? (s.npcs[0].name + '（' + (s.npcs[0].role || '') + '）') : '未登记'}`],
  ['人口', s => (s.economy && s.economy.population ? `${s.economy.population.households} 户 / ${s.economy.population.total} 口` : '未登记')],
  ['家族', s => (((s.household && s.household.members) || []).length ? `${(s.household.members || []).length} 人已登记` : '未登记')],
  ['人物', s => `${(s.npcs || []).length} 人已登记`],
  ['势力', s => (((s.factions && s.factions.items) || []).length ? `${(s.factions.items || []).length} 个势力` : '未登记')],
  ['军事', s => (s.economy ? `总兵 ${s.economy.military.total}（战兵 ${s.economy.military.combat}）` : '未登记')],
  ['财政', s => (s.economy ? `钱 ${s.economy.treasury.cashGuan} 贯 / 粮 ${s.economy.treasury.grainShi} 石` : '未登记')],
  ['经济', s => (s.economy ? `粮价 ${s.economy.market.grainWenPerShi} 文/石；税率 ${Math.round(s.economy.treasury.taxRate * 100)}%` : '未登记')],
  ['粮食', s => (s.economy ? `官仓 ${s.economy.treasury.grainShi} 石；本境民田年产约 ${s.economy.population.annualGrainShi} 石（非官府所有）` : '未登记')],
  ['农业', s => (s.economy ? `${s.economy.agriculture.phase}${s.economy.agriculture.busy ? '（农忙）' : ''}` : '未登记')],
  ['交通', s => (s.world && s.world.交通) ? s.world.交通 : '依地理推算（见地理栏）'],
  ['城防', s => (s.world && s.world.城防) || '依规模推算'],
  ['法律', s => '依本朝律令；身份不同则量刑不同'],
  ['社会秩序', s => (s.world && s.world.社会秩序) || '平常'],
  ['情报', s => (((s.facts || []).length) ? `${(s.facts || []).length} 条已登记（F1–F5 分层）` : '未登记')],
  ['外交', s => (s.world && s.world.外交) || '未登记'],
  ['礼制', s => (s.world && s.world.礼制) || '依本朝礼制'],
  ['技术', s => (s.world && s.world.技术) || '依本朝工艺水平'],
  ['疾病', s => (s.world && s.world.疾病) || '无'],
  ['气候', s => (s.world && s.world.气候) || '正常'],
  ['历史事件', s => (((s.historyAnchors || []).length) ? `${(s.historyAnchors || []).length} 个锚点` : '未登记')],
  ['未解决事件', s => `${((s.threads || []).filter(t => !t.status || t.status === 'open')).length} 条未了`],
];

function ensureWorld(state) {
  state.world = state.world || {};
  if (!state.economy) initEconomy(state);
  const W = state.world;
  if (!W.社会秩序) W.社会秩序 = '平常';
  if (!W.气候) W.气候 = '正常';
  if (!W.疾病) W.疾病 = '无';
  if (!W.城防) {
    const sc = (state.economy && state.economy.scale) || '县城';
    W.城防 = sc === '都城' ? '三重城垣，守备严整' : sc === '州府城' ? '城垣完整，有戍卒' : sc === '县城' ? '土城矮薄，门楼朽坏' : '无城，仅有栅寨';
  }
  if (!W.交通) W.交通 = '陆路为主，雨天泥泞；河道可通舟';
  if (!W.礼制) W.礼制 = '依本朝礼制，尊卑有序';
  if (!W.技术) W.技术 = '依本朝工艺，无越代之物';
  if (!W.外交) W.外交 = '未登记';
  if (!state.facts) state.facts = [];
  if (!state.historyAnchors) state.historyAnchors = [];
  if (!state.macro) state.macro = { 朝廷: '政令例行', 邻郡: '无事', 边衅: '无' };
  return state.world;
}

/* 确定性随机：同一存档同一轮次结果一致（不引入不可复现的世界） */
function seeded(a, b) {
  let h = 2166136261 ^ (a || 0);
  const s = String(b || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const WEATHER = ['晴', '多云', '阴', '小雨', '大雨', '风', '霜', '雪'];
const WEATHER_BY_SEASON = {
  春: ['晴', '多云', '小雨', '阴', '风'],
  夏: ['晴', '多云', '大雨', '小雨', '阴'],
  秋: ['晴', '多云', '阴', '风', '霜'],
  冬: ['阴', '雪', '霜', '风', '晴'],
};

function rollWeather(state) {
  const c = state.clock || {};
  const rnd = seeded((c.gregorianYear || 0) * 31 + (c.month || 1), `${state.meta && state.meta.id}|${state.turn}|weather`);
  const pool = WEATHER_BY_SEASON[c.season] || WEATHER;
  return pool[Math.floor(rnd() * pool.length) % pool.length];
}

/**
 * 推进世界（玩家什么都不做也要跑的部分）。
 * 返回这一轮世界自身发生的变化清单，供界面「本轮 · 世界已向前走」与 P15 回归审计使用。
 */
function tickWorld(state, days) {
  ensureWorld(state);
  const c = state.clock || {};
  const W = state.world;
  const changes = [];

  // 季节
  // 月份是农历：正二三月为春（孟春、仲春、季春），十至腊月为冬。旧表按公历把正月、二月算作冬
  const season = ['春', '春', '春', '夏', '夏', '夏', '秋', '秋', '秋', '冬', '冬', '冬'][((c.month || 1) - 1) % 12];
  if (c.season !== season) { changes.push(`季节：${c.season || '?'} → ${season}`); c.season = season; }

  // 天气（每轮一次）
  const w = rollWeather(state);
  if (W.气候 !== w) { changes.push(`气候：${W.气候} → ${w}`); W.气候 = w; }
  if (w === '大雨' || w === '雪') {
    W.交通 = '道路泥泞/封冻，行旅迟缓，辎重难行';
    changes.push('交通受阻：' + W.交通);
  } else {
    W.交通 = '陆路可通；雨天泥泞；河道可通舟';
  }

  // 经济与农业
  for (const t of tickEconomy(state, days)) changes.push(t);

  // 疫病：夏秋湿热 + 人口密集 + 灾情，才可能起疫；不得凭空生病（规范第五十九章）
  const e = eco(state);
  const hot = season === '夏' || season === '秋';
  const rnd2 = seeded((c.gregorianYear || 0) * 7 + (c.month || 1), `${state.meta && state.meta.id}|${state.turn}|plague`);
  if (hot && rnd2() < 0.06) { W.疾病 = '时疫初起（湿热所致，多在低洼坊巷）'; changes.push('疾病：' + W.疾病); }
  else if (W.疾病 !== '无' && season === '冬') { W.疾病 = '无'; changes.push('疾病：疫情随寒消退'); }

  // 宏观三层（第九十二章）：朝廷 / 邻郡 / 边衅，各自独立运行
  const rnd3 = seeded((c.gregorianYear || 0) * 13 + (c.month || 1), `${state.meta && state.meta.id}|${state.turn}|macro`);
  const MACRO_EVENTS = ['朝廷例行磨勘', '转运使巡行', '邻郡移文催征', '边报迟滞', '漕运受阻', '朝中人事调整', '无大事'];
  const mv = MACRO_EVENTS[Math.floor(rnd3() * MACRO_EVENTS.length) % MACRO_EVENTS.length];
  if (mv !== '无大事') { state.macro.朝廷 = mv; changes.push('宏观：' + mv); }

  // 社会秩序随粮价与灾情浮动
  const price = e.market.grainWenPerShi;
  const unrest = price > 420 ? '米贵民怨，市有争斗' : price > 360 ? '物价偏高，民有怨言' : '平常';
  if (W.社会秩序 !== unrest) { changes.push(`社会秩序：${W.社会秩序} → ${unrest}`); W.社会秩序 = unrest; }

  state.worldChanges = changes;
  return changes;
}

/* 世界状态摘要（提示词用，克制在十几行，别把提示词撑爆） */
function renderWorld(state) {
  ensureWorld(state);
  const pick = ['时间', '地理', '政治', '人口', '财政', '粮食', '农业', '军事', '交通', '社会秩序', '气候', '情报', '未解决事件'];
  const lines = [];
  for (const [k, f] of SECTIONS) if (pick.includes(k)) lines.push(`· ${k}：${f(state)}`);
  const m = state.macro || {};
  lines.push(`· 宏观：朝廷 ${m.朝廷 || '?'}；邻郡 ${m.邻郡 || '?'}；边衅 ${m.边衅 || '?'}`);
  return '=== 世界状态（结构化，任何大事后必须更新对应项） ===\n' + lines.join('\n');
}

/* 状态差异：给 P15 回归审计用（规范第八十一章 P15） */
function worldDiff(before, after) {
  const flat = (s) => {
    const e = s && s.economy;
    return {
      时间: `${(s.clock && s.clock.yearLabel) || ''}${(s.clock && s.clock.month) || ''}月${(s.clock && s.clock.day) || ''}日`,
      地点: (s.location && s.location.full) || '',
      控制者: (s.location && s.location.controller) || '',
      钱: e ? e.treasury.cashGuan : null,
      粮: e ? e.treasury.grainShi : null,
      兵: e ? e.military.total : null,
      人口: e ? e.population.total : null,
      人物数: (s.npcs || []).length,
      死者: ((s.dead || []).length) || 0,
      线索数: (s.threads || []).length,
      事实数: (s.facts || []).length,
      身份: s.identityModule || '',
      社会秩序: (s.world && s.world.社会秩序) || '',
      气候: (s.world && s.world.气候) || '',
    };
  };
  const a = flat(before || {}), b = flat(after || {});
  const rows = [];
  for (const k of Object.keys(b)) {
    if (String(a[k]) !== String(b[k])) rows.push({ 项: k, 前: a[k], 后: b[k] });
  }
  return rows;
}

module.exports = { ensureWorld, tickWorld, renderWorld, worldDiff, SECTIONS, rollWeather, seeded };
