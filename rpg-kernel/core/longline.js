'use strict';
/**
 * 长线剧情数据（用户《实现包》§3.3–3.4、§4.2–4.3；《设计书》§3.3–3.7、§5.10）。
 *
 * 原则：**状态只由代码改，模型只能申请**。
 *   · 时钟：格数由代码按规则推进；满格「本轮必须发生」，写进下一轮提示词。
 *   · 伏笔账：模型在草稿里申请埋设/推进；代码记账、算到期、逾期强提示。
 *   · 关系值与恩怨账：模型申请 ±1/±2，代码夹紧到 [-5, 5] 并留痕。
 *   · 回合类型：记录最近几轮，连续三轮同类则要求换类型。
 *   · 无代价计数：玩家连续两轮顺利且无代价，下一轮强制引入代价。
 * 存在 state.longline 里，随存档走、随快照回滚。
 */

const TURN_TYPES = ['压力', '谈判', '行动', '揭示', '日常', '余波'];
const FS_STATES = ['埋设', '预示', '误导', '临近', '已回收', '已转化', '已作废'];
const FS_NEXT = {
  埋设: ['预示', '误导', '临近', '已回收', '已转化', '已作废'],
  预示: ['预示', '误导', '临近', '已回收', '已转化', '已作废'],
  误导: ['预示', '误导', '临近', '已回收', '已转化', '已作废'],
  临近: ['临近', '已回收', '已转化', '已作废'],
  已回收: [], 已转化: [], 已作废: [],
};
const OPEN = s => !['已回收', '已转化', '已作废'].includes(s);

function ensureLongline(state) {
  if (!state.longline) state.longline = { version: 1, clocks: [], foreshadows: [], relations: {}, turnTypes: [], noCostStreak: 0, firedClocks: [], seq: 0 };
  const L = state.longline;
  for (const k of ['clocks', 'foreshadows', 'turnTypes', 'firedClocks']) L[k] = L[k] || [];
  L.relations = L.relations || {};
  if (!L.seeded) seedFromFigure(state, L);
  return L;
}
const nextId = (L, p) => { L.seq = (L.seq || 0) + 1; return `${p}${String(L.seq).padStart(3, '0')}`; };

/* 人物档案里预置的时钟与伏笔种子（有则用；任意人物自动建档的也可带） */
function seedFromFigure(state, L) {
  L.seeded = true;
  let f = null;
  try { const fig = require('./figure-data'); f = fig.FIGURES[(state.protagonist || {}).name] || null; } catch (_) { /* 无档案 */ }
  if (!f) return;
  for (const c of (f.clocks || [])) L.clocks.push({ id: nextId(L, 'c'), filled: 0, ...JSON.parse(JSON.stringify(c)) });
  for (const s of (f.foreshadowSeeds || [])) {
    L.foreshadows.push({ id: nextId(L, 'f'), state: '埋设', planted: state.turn || 0, signals: [],
      earliest: (state.turn || 0) + (s.earliestIn || 3), latest: (state.turn || 0) + (s.latestIn || 15), ...JSON.parse(JSON.stringify(s)) });
  }
}

/* —— 世界推进（采纳草稿时由代码调用；不由模型决定）—— */
function advanceWorld(state, input, draft) {
  const L = ensureLongline(state);
  const turn = state.turn || 0;
  const text = `${input || ''}`;
  const events = [];
  for (const c of L.clocks) {
    if (c.done) continue;
    let delta = 0;
    for (const r of (c.rules || [])) {
      if (r.onKeywords && r.onKeywords.some(k => text.includes(k))) delta += r.delta;
      if (r.everyTurns && turn > 0 && turn % r.everyTurns === 0) delta += r.delta;
      if (r.onIdleKeywords && !r.onIdleKeywords.some(k => text.includes(k))) delta += r.delta;
    }
    if (!delta) continue;
    const before = c.filled;
    c.filled = Math.max(0, Math.min(c.segments, c.filled + delta));
    if (c.filled !== before) events.push({ kind: 'clock', id: c.id, name: c.name, from: before, to: c.filled });
    if (c.filled >= c.segments) {
      c.done = true; c.firedTurn = turn;
      L.firedClocks.push({ id: c.id, name: c.name, consequence: c.onFull, turn, handled: false });
      events.push({ kind: 'clock_full', id: c.id, name: c.name, consequence: c.onFull });
    }
  }
  // 无代价计数：模型须在 cost 字段写明本轮主角付出的代价；空着且玩家本轮有行动，记一次「无代价」
  if (String(input || '').trim()) {
    if (draft && String(draft.cost || '').trim()) L.noCostStreak = 0;
    else L.noCostStreak = (L.noCostStreak || 0) + 1;
  }
  L.lastEvents = events;
  return events;
}

/* —— 应用模型的「变更申请」（采纳时）：只收合法的，非法的记下理由 —— */
function applyPatch(state, draft) {
  const L = ensureLongline(state);
  const turn = state.turn || 0;
  const rejected = [];
  const names = new Set((state.npcs || []).map(n => n.name).concat(((draft && draft.newNpcs) || []).map(n => n.name)));
  // 回合类型
  if (draft && TURN_TYPES.includes(draft.turnType)) { L.turnTypes.push(draft.turnType); L.turnTypes = L.turnTypes.slice(-8); }
  // 关系值：每人每轮 |Δ|≤2，夹紧到 [-5,5]，必须写原因
  for (const rc of ((draft && draft.relationChanges) || [])) {
    if (!rc || !names.has(rc.name)) { rejected.push(`关系变更：查无此人「${rc && rc.name}」`); continue; }
    const d = Math.max(-2, Math.min(2, Number(rc.delta) || 0));
    if (!d) continue;   // 0 = 不变，不算申请
    if (!String(rc.reason || '').trim()) { rejected.push(`关系变更「${rc.name}」：缺原因`); continue; }
    const r = L.relations[rc.name] || (L.relations[rc.name] = { value: 0, history: [] });
    r.value = Math.max(-5, Math.min(5, r.value + d));
    r.history.push({ turn, delta: d, reason: String(rc.reason).slice(0, 60) });
    r.history = r.history.slice(-12);
  }
  // 新埋伏笔
  for (const fp of ((draft && draft.foreshadowPlant) || []).slice(0, 2)) {
    if (!fp || !fp.surface || !fp.truth) { rejected.push('新伏笔：缺「表象」或「真相」'); continue; }
    if (L.foreshadows.filter(f => OPEN(f.state)).length >= 8) { rejected.push('新伏笔：活跃伏笔已满 8 个，先回收旧的'); continue; }
    const within = Math.max(3, Math.min(30, Number(fp.resolveWithin) || 12));
    L.foreshadows.push({ id: nextId(L, 'f'), type: fp.type || '人物秘密', surface: String(fp.surface).slice(0, 80), truth: String(fp.truth).slice(0, 120),
      state: '埋设', planted: turn, earliest: turn + Math.min(3, within), latest: turn + within, signals: [], related: fp.related || [] });
  }
  // 伏笔推进：只许沿合法路径
  for (const ch of ((draft && draft.foreshadowChanges) || [])) {
    const f = L.foreshadows.find(x => x.id === (ch && ch.id));
    if (!f) { rejected.push(`伏笔变更：查无编号「${ch && ch.id}」`); continue; }
    if (!(FS_NEXT[f.state] || []).includes(ch.to)) { rejected.push(`伏笔 ${f.id}：「${f.state}」不能直接变成「${ch.to}」`); continue; }
    f.state = ch.to;
    if (ch.signal) f.signals.push({ turn, text: String(ch.signal).slice(0, 60) });
    if (!OPEN(f.state)) { f.closedTurn = turn; f.closedHow = ch.how || ''; }
  }
  // 满格时钟：草稿里写明已兑现的，标记已处理
  for (const fc of L.firedClocks) if (!fc.handled && ((draft && draft.clocksHandled) || []).includes(fc.id)) fc.handled = true;
  L.lastRejected = rejected;
  return { rejected };
}

/* —— 给 GM 的提示块：只给「本轮必须知道的」，不倒全账 —— */
function renderLongline(state, presentNames = []) {
  const L = ensureLongline(state);
  const turn = state.turn || 0;
  const lines = [];
  const fired = L.firedClocks.filter(c => !c.handled);
  if (fired.length) {
    lines.push('【时钟已满——本轮必须发生，不得拖延】');
    for (const c of fired) lines.push(`· ${c.id}「${c.name}」：${c.consequence}（写完后在 clocksHandled 里填 ${c.id}）`);
  }
  const live = L.clocks.filter(c => !c.done);
  if (live.length) {
    lines.push('【正在逼近的事（只写征兆，不报格数）】');
    for (const c of live) lines.push(`· ${c.name}：${c.filled}/${c.segments}${c.omens && c.omens.length ? '；可写的征兆：' + c.omens.join('、') : ''}`);
  }
  const open = L.foreshadows.filter(f => OPEN(f.state));
  const overdue = open.filter(f => turn >= f.latest);
  const ready = open.filter(f => turn >= f.earliest && turn < f.latest);
  if (overdue.length) {
    lines.push('【逾期伏笔——本轮必须处理：回收（兑现/反转/代价/落空）或转化，在 foreshadowChanges 里申请】');
    for (const f of overdue) lines.push(`· ${f.id}（${f.state}）表象：${f.surface}｜真相（GM 机密）：${f.truth}`);
  }
  if (ready.length) {
    lines.push('【可回收的伏笔（可预示、可误导、可回收；每次预示要有新信息）】');
    for (const f of ready) lines.push(`· ${f.id}（${f.state}）表象：${f.surface}｜真相（GM 机密）：${f.truth}`);
  }
  const rel = Object.entries(L.relations).filter(([n]) => !presentNames.length || presentNames.includes(n));
  if (rel.length) {
    lines.push('【在场人物对主角的关系值（-5 仇 ~ +5 死忠）与最近恩怨——人物态度须与此一致，不得昨日结仇今日热情】');
    for (const [n, r] of rel.slice(0, 6)) lines.push(`· ${n}：${r.value}；${r.history.slice(-3).map(h => `第${h.turn}轮${h.delta > 0 ? '+' : ''}${h.delta}（${h.reason}）`).join('；')}`);
  }
  const tt = L.turnTypes.slice(-3);
  if (tt.length === 3 && tt.every(t => t === tt[0])) lines.push(`【节奏】最近三轮都是「${tt[0]}」回合，本轮换一种（${TURN_TYPES.filter(t => t !== tt[0]).join('/')}）。`);
  if ((L.noCostStreak || 0) >= 2) lines.push(`【代价】主角已连续 ${L.noCostStreak} 轮顺利且无代价。本轮世界必须让他付出点什么（钱粮、人情、名声、把柄、有人记仇），并写进 cost 字段。`);
  if (!lines.length) return '';
  return ['=== 长线（代码记账；格数与状态由引擎决定，你只负责把它写成剧情） ===', ...lines].join('\n');
}

function summary(state) {
  const L = ensureLongline(state);
  return {
    clocks: L.clocks.map(c => ({ id: c.id, name: c.name, filled: c.filled, segments: c.segments, done: !!c.done })),
    foreshadows: L.foreshadows.map(f => ({ id: f.id, surface: f.surface, state: f.state, planted: f.planted, latest: f.latest })),
    relations: L.relations, turnTypes: L.turnTypes, noCostStreak: L.noCostStreak, lastRejected: L.lastRejected || [],
  };
}

module.exports = { ensureLongline, advanceWorld, applyPatch, renderLongline, summary, TURN_TYPES, FS_STATES };
