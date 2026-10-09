'use strict';
/**
 * 纠正记录库 + 违规计数。
 *
 * 用户反复指出的失误（「改一处漏一处」「数字忽大忽小」「悄悄替他收尾」…），
 * 必须**沉淀成一张单子**，每轮开头逐条对照 —— 不能只靠 AI 自觉。
 *
 * 存在存档里（每个存档独立），因为不同局的坑可能不同。
 * 若某类错误重复出现，count 递增，提示升级。
 */

/* 预置的「常见失误模式」（来自用户清单第十三节），开局即入表，count 从 0 起 */
const PRESET_PITFALLS = [
  { key: 'claim_checked', label: '嘴上说检查过、实际没检查', tier: 'human' },
  { key: 'missed_ripple', label: '改一处、漏掉牵动的其他处（年份/官职/关系未联动）', tier: 'table' },
  { key: 'silent_action', label: '悄悄替玩家收尾或替他做决定', tier: 'machine' },
  { key: 'time_leap', label: '一轮跳太远（快进）', tier: 'machine' },
  { key: 'number_drift', label: '数字忽大忽小、无量级依据', tier: 'table' },
  { key: 'placeholder', label: '次要人物用占位符（某官员/一位将领）', tier: 'machine' },
  { key: 'relation_drift', label: '前几轮建立的关系/年龄后面写错', tier: 'table' },
  { key: 'repeat_after_correction', label: '被指出后又犯同样的错', tier: 'human' },
  { key: 'summary_style', label: '写成摘要而不是场景', tier: 'human' },
  { key: 'modern_terms', label: '出现后世词汇或现代观念', tier: 'machine' },
  { key: 'omniscient', label: '未卜先知 / 上帝视角', tier: 'human' },
  { key: 'dead_revive', label: '死人复活或人物无故消失', tier: 'table' },
];

function blankLedger() {
  return { corrections: [], counts: Object.fromEntries(PRESET_PITFALLS.map(p => [p.key, 0])), labels: {} };
}

function getLedger(state) {
  const l = state.ledger || {};
  return {
    corrections: Array.isArray(l.corrections) ? l.corrections : [],
    counts: { ...Object.fromEntries(PRESET_PITFALLS.map(p => [p.key, 0])), ...(l.counts || {}) },
    labels: l.labels || {},
  };
}

/* 从纠正原文里抽出「错 → 对」（红线 R10：订正不得回退，要能由程序比对）。
   认这几种写法：「A→B」「A 应为/应该是/改成/改为 B」「不是A，是B」「把A改成B」。抽不出就只作提示词提醒。 */
function parsePair(text) {
  const s = String(text || '').trim();
  const clean = x => String(x || '').replace(/^[「“"'\s]+|[」”"'\s。，,；;]+$/g, '').trim();
  let m = s.match(/^(.{2,20}?)\s*(?:→|->|=>)\s*(.{1,20})$/)
    || s.match(/^(?:把)?(.{2,20}?)\s*(?:应为|应该是|应作|改成|改为)\s*(.{1,20})$/)
    || s.match(/不是(.{2,20}?)[，,]?\s*(?:而)?是(.{1,20})/);
  if (!m) return null;
  const wrong = clean(m[1]), right = clean(m[2]);
  return wrong.length >= 2 && wrong !== right ? { wrong, right } : null;
}

/** 记一条用户纠正。key 可指定失误类型（用于计数），缺省归入 repeat_after_correction。 */
function addCorrection(state, { text, key, turn }) {
  const l = getLedger(state);
  if (!text) return l;
  l.corrections.push({ text: String(text).slice(0, 300), key: key || 'repeat_after_correction', turn: turn || state.turn || 0, at: new Date().toISOString(), ...(parsePair(text) || {}) });
  if (l.corrections.length > 100) l.corrections = l.corrections.slice(-100);
  const k = key || 'repeat_after_correction';
  l.counts[k] = (l.counts[k] || 0) + 1;
  if (!l.labels[k]) l.labels[k] = (PRESET_PITFALLS.find(p => p.key === k) || {}).label || k;
  state.ledger = l;
  return l;
}

/** 某类失误计数 +1（由审查器每轮调用） */
function bumpCount(state, key) {
  const l = getLedger(state);
  l.counts[key] = (l.counts[key] || 0) + 1;
  if (!l.labels[key]) l.labels[key] = (PRESET_PITFALLS.find(p => p.key === key) || {}).label || key;
  state.ledger = l;
  return l.counts[key];
}

/** 重复 ≥3 次的失误类型（需升级提示） */
function escalated(state) {
  const l = getLedger(state);
  return Object.entries(l.counts).filter(([, v]) => v >= 3).map(([k, v]) => ({ key: k, label: l.labels[k] || k, count: v }));
}

/** 给 GM 的段落：每轮开头逐条对照（这是用户明确要求的「必须对照」） */
function renderLedger(state) {
  const l = getLedger(state);
  const esc = escalated(state);
  const lines = ['=== 纠正记录库（每轮动笔前逐条对照，不得再犯） ==='];
  if (l.corrections.length) {
    lines.push('用户此前的纠正（最近 12 条）：');
    lines.push(l.corrections.slice(-12).map(c => `· 第${c.turn}轮：${c.text}`).join('\n'));
  } else {
    lines.push('（本局暂无纠正记录）');
  }
  const hot = Object.entries(l.counts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (hot.length) {
    lines.push('已发生过的失误类型（次数）：' + hot.map(([k, v]) => `${l.labels[k] || k}×${v}`).join('；'));
  }
  if (esc.length) {
    lines.push('⚠ 反复出现的失误（须特别留神）：' + esc.map(e => `${e.label}（${e.count} 次）`).join('；'));
  }
  lines.push('要求：本轮落笔前，先想一遍上述每一条「我是否又犯了」；如果某条不适用，也确认一遍再说。');
  return lines.join('\n');
}

module.exports = { PRESET_PITFALLS, getLedger, addCorrection, bumpCount, escalated, renderLedger, parsePair };
