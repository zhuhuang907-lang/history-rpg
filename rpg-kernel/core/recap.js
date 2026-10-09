'use strict';
/**
 * 前情回顾（《设计书》§2.6、《实现包》§6.9）：由档案馆数据直接拼出，不经模型、不写新剧情。
 * 固定内容：上一轮的停点、当前处境、三条最紧迫的线索、相关人物的当前态度、玩家已立的立场、本篇章目标。
 * 缺项明说「信息缺口」，不编造。不超过约 400 字。
 */
function lastSentence(text) {
  const s = String(text || '').replace(/「用户决定」/g, '').trim();
  const parts = s.split(/(?<=[。！？」])/).map(x => x.trim()).filter(Boolean);
  return parts.slice(-2).join('') || '';
}

function buildRecap(state) {
  const c = state.clock || {}, p = state.protagonist || {}, L = state.location || {};
  const gap = '（信息缺口）';
  try { require('./plot').ensurePlot(state); } catch (_) { /* 先跑旧档剧情清理，免得把作废的线当紧迫事 */ }
  const lastGM = (state.log || []).filter(l => l.speaker === 'GM').slice(-1)[0];
  const stop = lastGM ? lastSentence(lastGM.text).slice(0, 90) : '（尚未开始，第一回合）';
  let situation = '';
  try { const fd = require('./figure-data').dossierAt(p.name, c.gregorianYear, c.month); situation = fd && fd.situation ? fd.situation.text : ''; } catch (_) { /* 无档案 */ }
  // 最紧迫的三件：满格时钟 > 逾期伏笔 > 进行中的剧情 > 未了线索
  const urgent = [];
  try {
    const ll = require('./longline').ensureLongline(state);
    for (const f of ll.firedClocks.filter(x => !x.handled)) urgent.push(`${f.name}：已到眼前`);
    for (const k of ll.clocks.filter(x => !x.done && x.filled >= x.segments - 2)) urgent.push(`${k.name}：日渐逼近`);
    for (const f of ll.foreshadows.filter(x => !['已回收', '已转化', '已作废'].includes(x.state) && (state.turn || 0) >= x.latest)) urgent.push(f.surface);
  } catch (_) { /* 无长线数据 */ }
  for (const a of ((state.plot && state.plot.arcs) || []).filter(a => ['triggered', 'developing', 'stalemate', 'escalating'].includes(a.status))) urgent.push(a.title);
  for (const t of (state.threads || []).filter(t => !t.status || t.status === 'open')) urgent.push(t.label || String(t.title || '').slice(0, 16));
  const top3 = [...new Set(urgent)].slice(0, 3);
  // 人物态度：有关系值的优先
  let rel = [];
  try { rel = Object.entries(require('./longline').ensureLongline(state).relations).map(([n, r]) => `${n}（${r.value > 0 ? '+' : ''}${r.value}${r.history.length ? '，' + r.history.slice(-1)[0].reason : ''}）`); } catch (_) { /* 无 */ }
  if (!rel.length) rel = (state.npcs || []).filter(n => n.contact).slice(0, 4).map(n => `${n.name}（${n.role || ''}，态度未登记）`);
  const stance = (state.decisions || []).slice(-3).map(d => String(d.text || '').slice(0, 24));
  // 篇章目标与当前一拍、最近一次主线进度评估（§2.6 固定内容之「本篇章的目标」）
  let goal = '', assess = '';
  try {
    const ar = require('./arcs'); const b = ar.beatOf(state);
    goal = `第${b.chapter.no}章「${b.chapter.goal}」，第${b.round}/${b.of}回合（${b.name}）`;
    const A = ar.ensureArcs(state); const cp = A.checkpoints[A.checkpoints.length - 1]; if (cp) assess = cp.text;
  } catch (_) {
    try { const t = require('./figure-data').tensionAt(p.name, c.gregorianYear, c.month); goal = t ? t.name : ''; } catch (__) { /* 无 */ }
  }

  const out = [
    `【前情回顾 · 第${state.turn || 0}回合后】`,
    `此刻：${c.yearLabel || gap}${c.month ? c.month + '月' : ''}${c.day ? c.day + '日' : ''}，${L.full || gap}；${p.name || gap}，${p.age != null ? p.age + '岁' : gap}。`,
    `上回停在：${stop || gap}`,
    `眼下处境：${situation || gap}`,
    `最紧迫的事：${top3.length ? top3.join('；') : gap}`,
    `身边人的态度：${rel.length ? rel.slice(0, 4).join('、') : gap}`,
    `你已立下的主张：${stance.length ? stance.join('；') : '（尚未明确表态）'}`,
    `本篇章：${goal || gap}`,
    ...(assess ? [`主线走向：${assess}`] : []),
  ];
  return out.join('\n');
}

module.exports = { buildRecap };
