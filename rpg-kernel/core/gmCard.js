'use strict';
/**
 * 用户 GM 规范（history-rpg-gm v5.0）第九、十章：档案卡 / 速查表 / 人物表。
 * 全部由存档数据生成（不让模型自报），每回合采纳后静默覆盖写入：
 *   历史RPG存档/<存档名>/速查表.md、人物表.md、档案卡.md
 * 「GM 机密」（即将发生的史事）只写进速查表与档案卡文件，不进玩家正文。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '历史RPG存档');

const safe = s => String(s || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
const line = (k, v) => `${k}：${v == null || v === '' ? '（未登记）' : v}`;

function npcLine(n, turnNow) {
  return [n.name, n.age != null ? `${n.age}岁` : '年龄未详', n.role || n.background || '身份未详',
    n.nativePlace || '籍贯未详', n.source === 'historical' ? '真实' : '虚构',
    n.status === '已故' ? '已故' : (n.contact ? '已交往' : '未交往'),
    n.tie || '', n.firstSeenTurn != null ? `首见于第${n.firstSeenTurn}回合` : (turnNow != null ? '开局在册' : '')]
    .filter(Boolean).join('，');
}

function quickSheet(state) {
  const c = state.clock || {}, p = state.protagonist || {}, L = state.location || {};
  const e = state.economy || {};
  const figure = require('./figure-data');
  const far = (state.npcs || []).filter(n => n.source === 'historical' && !n.contact && n.status !== '已故');
  const pending = (state.eraEventsPending || []).map(ev => {
    const months = ((ev.y - (c.gregorianYear || 0)) * 12) + ((ev.m || 12) - (c.month || 1));
    return `· ${ev.y}年${ev.m ? ev.m + '月' : ''}（约 ${Math.max(0, months)} 个月后）：${ev.text}`;
  });
  let ethics = [];
  try { const er = require('./ethics').eraOf(state); if (er) ethics = er.given; } catch (_) { /* 无底表 */ }
  const fictional = (state.npcs || []).filter(n => n.source !== 'historical').map(n => n.name);
  return [
    `# 时代速查表 · ${(state.meta && state.meta.title) || ''}`,
    '',
    '## 时间锚点',
    line('年号', `${c.yearLabel || '?'}（公历 ${c.gregorianYear || '?'} 年）${c.month || '?'}月${c.day || '?'}日，${c.season || ''}`),
    line('主角年龄', `${p.name || '?'}，${p.age != null ? p.age : '?'}岁（虚岁）`),
    '',
    '## 权力格局',
    ...(state.factions || []).map(f => `· ${f.title}：${f.stake || ''}`),
    ...far.map(n => `· ${n.name}（${n.age != null ? n.age + '岁，' : ''}${n.role || ''}${n.seat ? '，在' + n.seat : ''}）`),
    '',
    '## 本地实况',
    line('所在', `${L.full || '?'}（${L.polity || '?'}，控制者 ${L.controller || '?'}）`),
    line('主角名分', figure.titleAt(p.name, c.gregorianYear) || p.role),
    line('盘子', e.scale ? `${e.scale}；户约 ${e.population && e.population.households}，兵约 ${e.military && e.military.total}，马 ${e.military && e.military.horses}（引擎估算量级，史无确数者不得当史实引用）` : ''),
    '',
    '## 物价与数字锚点',
    line('粮价', e.market ? `${e.market.grainWenPerShi} 文/石` : ''),
    line('官仓', e.treasury ? `粮 ${e.treasury.grainShi} 石，钱 ${e.treasury.cashGuan} 贯` : ''),
    line('说明', (e.estimate && e.estimate.note) || ''),
    '',
    '## 思想与禁忌',
    ...(ethics.length ? ethics.map(x => `· ${x}`) : ['（本时代伦理底表待补）']),
    '',
    '## GM 机密：即将到来的历史事件（角色不知）',
    ...(pending.length ? pending : ['（年表中暂无后续事件）']),
    '',
    '## 本档已用虚构人名',
    fictional.length ? fictional.join('、') : '（无）',
  ].join('\n');
}

function rosterSheet(state) {
  return [`# 人物表 · ${(state.meta && state.meta.title) || ''}`, '',
    ...(state.npcs || []).map(n => npcLine(n, state.turn))].join('\n');
}

function profileCard(state) {
  const c = state.clock || {}, p = state.protagonist || {}, L = state.location || {}, e = state.economy || {};
  const figure = require('./figure-data');
  const key = (state.npcs || []).filter(n => n.contact || n.firstSeenTurn > 0);
  const open = (state.threads || []).filter(t => !t.status || t.status === 'open');
  const arcs = ((state.plot && state.plot.arcs) || []).filter(a => !['resolved', 'terminated'].includes(a.status));
  const done = (state.figureLog || []).slice(-10).map(x => `· ${x.year ? x.year + '年 ' : ''}${x.text}`);
  const recent = (state.log || []).filter(l => l.speaker === 'GM').slice(-3)
    .map(l => `· 第${l.turn}回合（${l.time || ''}）：${String(l.text || '').replace(/\s+/g, '').slice(0, 120)}…`);
  return [
    `【档案卡·${(state.meta && state.meta.title) || ''}·第${state.turn || 0}回合】`,
    line('时间', `${c.yearLabel || '?'}，公历 ${c.gregorianYear || '?'} 年，${c.month || '?'}月${c.day || '?'}日，${c.season || ''}`),
    line('地点', L.full),
    line('主角', `${p.name || '?'}，${p.age != null ? p.age : '?'}岁，${figure.titleAt(p.name, c.gregorianYear) || p.role || ''}${state.protagonistDead ? '（已故）' : ''}`),
    line('权力与资源', e.military ? `兵约 ${e.military.total}，马 ${e.military.horses}；官仓粮 ${e.treasury && e.treasury.grainShi} 石、钱 ${e.treasury && e.treasury.cashGuan} 贯（估算量级）` : ''),
    '关键人物：',
    ...(key.length ? key.map(n => '　' + npcLine(n)) : ['　（尚无）']),
    '未解决线索：',
    ...(open.length ? open.map(t => `　· ${t.title}（第${t.lastTouchedTurn || 0}回合起）`) : ['　（无）']),
    ...(arcs.length ? arcs.map(a => `　· 剧情：${a.title}（${a.status}，第${a.turn}回合起）`) : []),
    '已发生的重要后果：',
    ...(done.length ? done : ['　（尚无）']),
    'GM 机密（玩家可选择不看）：',
    ...((state.eraEventsPending || []).slice(0, 6).map(ev => `　· ${ev.y}年${ev.m ? ev.m + '月' : ''}：${ev.text}`)),
    line('已用虚构人名', (state.npcs || []).filter(n => n.source !== 'historical').map(n => n.name).join('、') || '（无）'),
    line('玩家标记（近十回合）', (() => {
      const f = (state.playerFlags || []).slice(-10); if (!f.length) return '（尚无）';
      const by = {}; for (const x of f) by[x.flag] = (by[x.flag] || 0) + 1;
      return Object.entries(by).map(([k, v]) => `${k}${v}`).join('、') + (f.some(x => x.note) ? '；' + f.filter(x => x.note).slice(-3).map(x => `第${x.turn}轮〔${x.flag}〕${x.note}`).join('；') : '');
    })()),
    '最近三回合摘要：',
    ...(recent.length ? recent : ['　（尚未开始）']),
  ].join('\n');
}

/** 写入（覆盖）三个文件；返回内容与路径 */
function writeCards(state) {
  let recap = '';
  try { recap = require('./recap').buildRecap(state); } catch (_) { /* 回顾失败不影响出卡 */ }
  const out0 = { 速查表: quickSheet(state), 人物表: rosterSheet(state), 档案卡: profileCard(state), 前情回顾: recap };
  // 自测脚本建的临时档不落盘（否则 历史RPG存档 里满是「版本锁测试」「剧情模块端到端」）
  const id = String((state.meta && state.meta.id) || ''), title = String((state.meta && state.meta.title) || '');
  if (process.env.RPG_NO_CARDS === '1' || /^(selftest|plot-e2e|xjlong|mxs|ver|diag|agetest|stress|t-)/.test(id) || /测试|端到端|自测|长线/.test(title)) return out0;
  const dir = path.join(ROOT, safe((state.meta && (state.meta.title || state.meta.id))));
  const out = { ...out0 };
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(out)) fs.writeFileSync(path.join(dir, `${k}.md`), v, 'utf8');
    out.dir = dir;
  } catch (e) { out.error = String(e.message || e); }
  return out;
}

module.exports = { writeCards, quickSheet, rosterSheet, profileCard };
