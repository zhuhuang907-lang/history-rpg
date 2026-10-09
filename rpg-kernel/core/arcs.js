'use strict';
/**
 * 篇章制、路线分、章末账单、中盘检查点、对手幕后行动（《设计书》§3.1、§3.8、§4.6）。
 *
 * 一个存档是一「季」：约 4 个篇章 × 每章 10 回合。篇章五拍按回合比例由代码判定，
 * 每轮把「本章目标 + 当前这一拍要做什么」写进提示词顶部（防主线漂移，§3.9）。
 * 路线分：模型每轮可申请给终局势 ±1（须写理由），代码累计；检查点（季进度约 30%/60%/85%）
 * 由代码生成「主线进度评估」，写进前情回顾与提示词。
 * 章末：代码汇总这一章的得失（关系变化、伏笔回收、时钟、玩家标记），存为「章末账单」。
 * 全部状态在 state.arcs 里，随存档、随快照。
 */

const CHAPTER_LEN = 10;
const SEASON_CHAPTERS = 4;
const ENDINGS = ['登顶', '隐退', '殉道', '崩盘', '改朝'];
const BEATS = [
  { name: '起', upTo: 0.15, task: '交代本章局面与目标，抛出第一个压力' },
  { name: '承', upTo: 0.40, task: '第一次交手，有胜有负，暴露对手的实力与关系' },
  { name: '转', upTo: 0.65, task: '代价显现、秘密揭开或局势反转，原来的目标变得复杂' },
  { name: '合', upTo: 0.85, task: '高潮：逼出一个必须做的大抉择（两边都想要、各有可见代价）' },
  { name: '余', upTo: 1.01, task: '余波：结算得失、世界变化，埋下下一章的钩子' },
];

function goalNow(state) {
  try {
    const c = state.clock || {};
    const t = require('./figure-data').tensionAt((state.protagonist || {}).name, c.gregorianYear, c.month);
    if (t) return t.name;
  } catch (_) { /* 无档案 */ }
  const live = ((state.plot && state.plot.arcs) || []).filter(a => ['triggered', 'developing', 'stalemate', 'escalating'].includes(a.status));
  return live.length ? live[live.length - 1].title : '在此立足';
}

function ensureArcs(state) {
  if (!state.arcs || !state.arcs.chapters) {
    state.arcs = { version: 1, chapters: [], routeScores: Object.fromEntries(ENDINGS.map(e => [e, 0])), routeLog: [], checkpoints: [], bills: [] };
  }
  const A = state.arcs;
  if (!A.chapters.length) openChapter(state, A);
  if (!A.opponents) initOpponents(state, A);   // 与第 1 章同时建卡，幕后行动从开章起算
  return A;
}
function openChapter(state, A) {
  const no = A.chapters.length + 1;
  A.chapters.push({ no, goal: goalNow(state), startTurn: state.turn || 0, length: CHAPTER_LEN,
    snapshot: snapshotForBill(state) });
}
function current(state) { const A = ensureArcs(state); return A.chapters[A.chapters.length - 1]; }
function beatOf(state) {
  const ch = current(state);
  const r = Math.max(0, (state.turn || 0) - ch.startTurn);
  const frac = r / ch.length;
  const b = BEATS.find(x => frac < x.upTo) || BEATS[BEATS.length - 1];
  return { ...b, round: r + 1, of: ch.length, chapter: ch };
}

/* 章末账单要对比的起点 */
function snapshotForBill(state) {
  const L = state.longline || {};
  return {
    relations: Object.fromEntries(Object.entries(L.relations || {}).map(([k, v]) => [k, v.value])),
    clocks: Object.fromEntries((L.clocks || []).map(c => [c.name, c.filled])),
    openForeshadows: (L.foreshadows || []).filter(f => !['已回收', '已转化', '已作废'].includes(f.state)).map(f => f.id),
    flags: (state.playerFlags || []).length,
    grain: state.economy && state.economy.treasury && state.economy.treasury.grainShi,
    cash: state.economy && state.economy.treasury && state.economy.treasury.cashGuan,
  };
}
function chapterBill(state, ch) {
  const now = snapshotForBill(state), was = ch.snapshot || {};
  const L = state.longline || {};
  const rel = Object.entries(now.relations).map(([k, v]) => [k, v - ((was.relations || {})[k] || 0)]).filter(([, d]) => d);
  const clocks = Object.entries(now.clocks).map(([k, v]) => [k, v - ((was.clocks || {})[k] || 0)]).filter(([, d]) => d);
  const closed = (L.foreshadows || []).filter(f => (was.openForeshadows || []).includes(f.id) && !['埋设', '预示', '误导', '临近'].includes(f.state));
  const planted = (L.foreshadows || []).filter(f => f.planted >= ch.startTurn);
  const flags = (state.playerFlags || []).slice(was.flags || 0);
  const fb = {}; for (const f of flags) fb[f.flag] = (fb[f.flag] || 0) + 1;
  const d = (a, b) => (a != null && b != null ? a - b : null);
  return {
    chapter: ch.no, goal: ch.goal, turns: `${ch.startTurn + 1}–${state.turn}`,
    得失: [d(now.grain, was.grain) ? `官仓粮 ${d(now.grain, was.grain) > 0 ? '+' : ''}${d(now.grain, was.grain)} 石` : '', d(now.cash, was.cash) ? `钱 ${d(now.cash, was.cash) > 0 ? '+' : ''}${d(now.cash, was.cash)} 贯` : ''].filter(Boolean),
    态度变化: rel.map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`),
    伏笔回收: closed.map(f => `${f.surface}（${f.closedHow || f.state}）`),
    新埋伏笔: planted.map(f => f.surface),
    时钟: clocks.map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v} 格`),
    玩家标记: fb,
    路线分: { ...ensureArcs(state).routeScores },
  };
}

/* 季进度检查点：约 30%/60%/85% */
function checkpointDue(state) {
  const A = ensureArcs(state);
  const total = CHAPTER_LEN * SEASON_CHAPTERS;
  const pct = (state.turn || 0) / total;
  for (const p of [0.3, 0.6, 0.85]) if (pct >= p && !A.checkpoints.some(c => c.at === p)) return p;
  return null;
}
function assessment(state) {
  const A = ensureArcs(state);
  const ranked = Object.entries(A.routeScores).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const why = A.routeLog.filter(r => r.ending === top[0]).slice(-3).map(r => r.reason);
  return top[1] > 0 ? `眼下的走向最接近「${top[0]}」（${top[1]} 分）${why.length ? '：' + why.join('；') : ''}。其次「${ranked[1][0]}」（${ranked[1][1]}）。`
    : '走向尚未分明：还没有哪个结局方向占上风。';
}

/* —— 采纳时由代码调用 —— */
function onAccept(state, draft) {
  const A = ensureArcs(state);
  const turn = state.turn || 0;
  const rej = [];
  // 路线分：每项 ±1，须有理由
  for (const [k, v] of Object.entries((draft && draft.routeDelta) || {})) {
    if (!ENDINGS.includes(k)) continue;
    const dlt = Math.max(-1, Math.min(1, Number(v && v.delta != null ? v.delta : v) || 0));
    const reason = String((v && v.reason) || (draft.routeReason || '')).slice(0, 60);
    if (!dlt) continue;
    if (!reason) { rej.push(`路线分「${k}」缺理由`); continue; }
    A.routeScores[k] += dlt;
    A.routeLog.push({ turn, ending: k, delta: dlt, reason });
  }
  A.routeLog = A.routeLog.slice(-60);
  // 检查点
  const cp = checkpointDue(state);
  if (cp) A.checkpoints.push({ at: cp, turn, text: assessment(state) });
  // 篇章到头：出账单、开新章
  const ch = current(state);
  let bill = null;
  if (turn + 1 - ch.startTurn >= ch.length) {
    bill = chapterBill({ ...state, turn: turn + 1 }, ch);
    A.bills.push(bill);
    A.bills = A.bills.slice(-12);
    ch.endTurn = turn + 1;
    openChapter({ ...state, turn: turn + 1 }, A);
  }
  return { rejected: rej, checkpoint: cp, bill };
}

/* —— 给 GM 的提示块（放在世界块最前，§3.9「篇章目标写进每轮提示词的顶部」）—— */
function renderArcs(state) {
  const A = ensureArcs(state);
  const b = beatOf(state);
  const lines = [`=== 本季第 ${b.chapter.no} 章「${b.chapter.goal}」｜第 ${b.round}/${b.of} 回合｜这一拍：${b.name} ===`,
    `这一拍要做的：${b.task}。`];
  if (b.name === '合') lines.push('本章的大抉择就在这几回合：把它逼到主角面前（不替他选）。');
  const last = A.bills[A.bills.length - 1];
  if (last && last.chapter === b.chapter.no - 1 && b.round <= 2) {
    lines.push(`上一章「${last.goal}」的账：${[...last.态度变化, ...last.伏笔回收.map(x => '回收：' + x), ...last.时钟].join('；') || '无大变化'}。本章开头要接住这些后果。`);
  }
  const cp = A.checkpoints[A.checkpoints.length - 1];
  if (cp && (state.turn || 0) - cp.turn <= 1) lines.push(`【主线进度评估】${cp.text}`);
  lines.push(`路线分（终局势，玩家看不到具体数字）：${Object.entries(A.routeScores).map(([k, v]) => `${k}${v}`).join(' ')}。玩家本轮若有关键抉择，在 routeDelta 里申请 ±1 并写理由。`);
  return lines.join('\n');
}

/* —— 对手卡与幕后行动（§4.6）：每个重要对手每三轮至少一次「不在玩家面前」的行动 —— */
function initOpponents(state, A) {
  A.opponents = [];
  const start = (A.chapters[0] && A.chapters[0].startTurn) || 0;
  try {
    const f = require('./figure-data').FIGURES[(state.protagonist || {}).name];
    for (const o of ((f && f.opponents) || [])) A.opponents.push({ ...JSON.parse(JSON.stringify(o)), lastOffstage: start });
  } catch (_) { /* 无档案 */ }
}
function ensureOpponents(state) {
  return ensureArcs(state).opponents;
}
function renderOpponents(state) {
  const ops = ensureOpponents(state);
  const turn = state.turn || 0;
  const c = state.clock || {};
  const alive = ops.filter(o => { try { const st = require('./figure-data').isAliveAt(o, c.gregorianYear, c.month); return st; } catch (_) { return true; } });
  const due = alive.filter(o => turn - (o.lastOffstage || 0) >= 3);
  if (!alive.length) return '';
  const lines = ['=== 对手卡（GM 机密；对手有脑子，不无故降智） ==='];
  for (const o of alive) lines.push(`· ${o.name}：想要「${o.wants}」；底牌「${o.cards}」；弱点「${o.weakness}」；他眼中的主角「${o.view}」；他的下一步「${o.next}」；他会犯的错「${o.mistake}」`);
  if (due.length) lines.push(`【本轮必须】${due.map(o => o.name).join('、')} 已三轮没有动静：让他的一次幕后行动以后果的形式出现（来信、传闻、有人被调走、物价变了……），写完在 offstage 里填他的名字。`);
  return lines.join('\n');
}
function onAcceptOpponents(state, draft) {
  const ops = ensureOpponents(state);
  for (const nm of ((draft && draft.offstage) || [])) {
    const o = ops.find(x => x.name === nm);
    if (o) o.lastOffstage = state.turn || 0;
  }
}

module.exports = { ensureArcs, beatOf, renderArcs, onAccept, chapterBill, assessment, renderOpponents, onAcceptOpponents, ENDINGS, BEATS, CHAPTER_LEN };
