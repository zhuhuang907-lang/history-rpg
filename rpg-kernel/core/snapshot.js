'use strict';
/**
 * 快照 / 回滚 / 最早错误修复（规范第八十三至八十五章）
 *
 * 核心立场：
 *   错误不是"改掉本轮那句话"就算完。它在最早出现的地方就已经开始污染状态了。
 *   所以流程是：
 *     ① 每 N 轮和每次重大事件后自动存一份快照（完整深拷贝，不是档案卡）
 *     ② 发现错误 → 定位**最早**出现这个错误的轮次（不是最近一次）
 *     ③ 回滚到那之前的最后一个干净快照
 *     ④ 列出从那时起被污染的状态项，逐项回溯
 *     ⑤ 用修正过的设定重跑
 *
 *   只改最后一句的后果：账目、人物生死、地盘、信息知情人都已经基于错误滚了好几轮。
 */

/* ============================ 快照存取 ============================ */

/* 深拷贝：存档里全是 JSON 安全的结构。
   归档用的 cards（每轮一张档案卡，最多 200 张）和长 log 不进快照——
   否则 40 份快照能把存档撑到几十 MB。回滚要的是"状态"，不是"流水"。 */
const SKIP_IN_SNAPSHOT = ['cards', 'snapshots', 'liveHistory', 'eventLog', 'searches'];
function clone(o) {
  let flat;
  try { flat = JSON.parse(JSON.stringify(o)); } catch { return o; }
  if (!flat || typeof flat !== 'object') return flat;
  for (const k of SKIP_IN_SNAPSHOT) delete flat[k];
  if (Array.isArray(flat.log) && flat.log.length > 40) flat.log = flat.log.slice(-40);
  return flat;
}

function keyFacts(state) {
  return {
    turn: state.turn || 0,
    at: `${(state.clock && state.clock.yearLabel) || ''}${(state.clock && state.clock.month) || ''}月${(state.clock && state.clock.day) || ''}日`,
    gYear: (state.clock && state.clock.gregorianYear) || 0,
    location: (state.location && state.location.full) || '',
    controller: (state.location && state.location.controller) || '',
    identity: state.identityModule || '',
    npcs: (state.npcs || []).length,
    dead: (state.dead || []).map(d => d.name || d),
    threads: (state.threads || []).length,
    facts: (state.facts || []).length,
    cash: state.economy ? state.economy.treasury.cashGuan : null,
    grain: state.economy ? state.economy.treasury.grainShi : null,
    troops: state.economy ? state.economy.military.total : null,
    pop: state.economy ? state.economy.population.total : null,
    divLevel: state.divergence ? state.divergence.level : 0,
  };
}

function snapshot(state, { label = '', force = false, every = 5 } = {}) {
  state.snapshots = state.snapshots || [];
  const t = state.turn || 0;
  const last = state.snapshots[state.snapshots.length - 1];
  // 每 every 轮一份；重大事件（易主/死人/身份变更）后强制一份
  if (!force && last && (t - last.turn) < every) return null;
  const snap = {
    id: `S${state.snapshots.length + 1}`,
    turn: t,
    label: label || '',
    at: `${(state.clock && state.clock.yearLabel) || ''}${(state.clock && state.clock.month) || ''}月${(state.clock && state.clock.day) || ''}日`,
    facts: keyFacts(state),
    state: clone(state),
  };
  state.snapshots.push(snap);
  // 只留最近 12 份：够回滚到"最早错误之前"，又不至于把存档撑爆
  if (state.snapshots.length > 12) state.snapshots = state.snapshots.slice(-12);
  return { id: snap.id, turn: snap.turn, at: snap.at };
}

function listSnapshots(state) {
  return (state.snapshots || []).map(s => ({ id: s.id, turn: s.turn, at: s.at, label: s.label, facts: s.facts }));
}

/* ============================ 最早错误定位 ============================
   错误来源三处：
     state.passHistory（十遍扫描 P0–P9 命中记录）
     state.auditHistory（三层审查 + P10–P15 命中记录）
     state.corrections（人工纠正记录）
   同一个错误码可能连着出了好几轮，要的是**第一次**。 */
function findEarliestError(state, code) {
  const hits = [];
  const scan = (list, kind) => {
    for (const h of (list || [])) {
      const codes = Array.isArray(h.codes) ? h.codes : [h.code];
      if (codes.some(c => c && (c === code || String(c).startsWith(code)))) {
        hits.push({ kind, turn: h.turn, at: h.at || '', codes });
      }
    }
  };
  scan(state.passHistory, '十遍扫描');
  scan(state.auditHistory, '审查');
  scan(state.corrections && state.corrections.ledger, '人工纠正');
  if (!hits.length) return null;
  hits.sort((a, b) => (a.turn || 0) - (b.turn || 0));
  return { code, 最早轮次: hits[0].turn, 出处: hits[0].kind, 共出现: hits.length, 全部: hits };
}

/* ============================ 受影响状态回溯 ============================
   从最早错误那一轮开始，逐份快照比对外层指标，列出**被这个错误污染到现在**的东西。 */
const CMP = [
  ['时点', 'at'], ['公元年', 'gYear'], ['地点', 'location'], ['控制者', 'controller'], ['身份', 'identity'],
  ['现钱', 'cash'], ['存粮', 'grain'], ['兵力', 'troops'], ['人口', 'pop'],
  ['人物数', 'npcs'], ['死者', 'dead'], ['线索数', 'threads'], ['事实数', 'facts'], ['偏离度', 'divLevel'],
];
function flatDiff(a, b) {
  const rows = [];
  for (const [label, k] of CMP) {
    const x = a ? a[k] : undefined, y = b ? b[k] : undefined;
    if (JSON.stringify(x) !== JSON.stringify(y)) rows.push({ 项: label, 前: x, 后: y });
  }
  return rows;
}

function impacted(state, code) {
  const e = findEarliestError(state, code);
  if (!e) return { ok: false, why: `没有找到「${code}」的历史记录` };
  const snaps = (state.snapshots || []).filter(s => s.turn >= e.最早轮次);
  const rows = [];
  let prev = null;
  for (const s of snaps) {
    if (prev) for (const d of flatDiff(prev.facts, s.facts)) rows.push({ 轮次: s.turn, 时点: s.at, ...d });
    prev = s;
  }
  // 当前状态 vs 最早错误发生前最后一个干净快照
  const clean = (state.snapshots || []).filter(s => s.turn < e.最早轮次).pop();
  const now = keyFacts(state);
  const poll = [];
  // 「时点/公元年」只是时间在走，不算被污染，剔除
  if (clean) {
    for (const d of flatDiff(clean.facts, now)) {
      if (d.项 === '时点' || d.项 === '公元年') continue;
      poll.push({ 项: d.项, 错误前: d.前, 现在: d.后 });
    }
  }
  return {
    ok: true, code, 最早轮次: e.最早轮次, 出处: e.出处, 共出现: e.全部.length,
    干净快照: clean ? { id: clean.id, turn: clean.turn, at: clean.at } : null,
    被污染的状态项: poll,
    逐轮变化: rows.slice(-24),
  };
}

/* ============================ 回滚 ============================ */
function rollback(state, byIdOrTurn) {
  const list = state.snapshots || [];
  const snap = list.find(s => s.id === byIdOrTurn) || list.find(s => String(s.turn) === String(byIdOrTurn));
  if (!snap) return { ok: false, why: `没有找到快照 ${byIdOrTurn}` };
  const restored = clone(snap.state);
  // 快照本身与纠正记录要保留：否则回滚后连"为什么回滚"都忘了
  restored.snapshots = list;
  restored.corrections = state.corrections;
  restored.rolledBackFrom = { turn: state.turn, at: `${(state.clock && state.clock.yearLabel) || ''}${(state.clock && state.clock.month) || ''}月${(state.clock && state.clock.day) || ''}日`, toSnap: snap.id, toTurn: snap.turn };
  return { ok: true, state: restored, snap: { id: snap.id, turn: snap.turn, at: snap.at } };
}

/* ============================ 一键「修最早那个错」 ============================
   给界面用：找到当前最严重且最早的错误，返回「建议回滚到哪 + 要重设什么」。 */
function repairPlan(state) {
  const buckets = [];
  const collect = (list, kind) => {
    for (const h of (list || [])) {
      const codes = Array.isArray(h.codes) ? h.codes : [h.code];
      for (const c of codes) if (c) buckets.push({ code: c, turn: h.turn, kind });
    }
  };
  collect(state.passHistory, '十遍扫描');
  collect(state.auditHistory, '审查');
  if (!buckets.length) {
    // 干巴巴一句「没有记录到任何错误」会被当成功能坏了。如实说明**为什么**没有、以及什么时候会有。
    const t = (state && state.turn) || 0;
    return {
      ok: false,
      why: t === 0
        ? '这个档还没跑过回合，没有可供定位的错误记录。跑几轮之后，这里会指出「最早一次出错是在第几轮」，并给出该回退到的干净快照。'
        : `已跑 ${t} 轮，十遍扫描（P0–P9）与三层审查（P10–P15）都没有记录到错误。`,
      turn: t,
    };
  }
  // 同一码取最早一轮
  const byCode = new Map();
  for (const b of buckets) {
    const k = String(b.code).split('-')[0] + '-' + String(b.code).split('-')[1];
    const cur = byCode.get(k);
    if (!cur || (b.turn || 0) < (cur.turn || 0)) byCode.set(k, b);
  }
  const sorted = [...byCode.values()].sort((a, b) => (a.turn || 0) - (b.turn || 0));
  const first = sorted[0];
  const imp = impacted(state, first.code);
  const clean = (state.snapshots || []).filter(s => s.turn < first.turn).pop();
  return {
    ok: true,
    最早错误: first,
    建议回滚到: clean ? { id: clean.id, turn: clean.turn, at: clean.at } : null,
    被污染的状态项: (imp.被污染的状态项 || []),
    其余待修: sorted.slice(1, 6),
  };
}

/* ============================ 提示词用的「已知错误」提醒 ============================ */
function renderKnownErrors(state) {
  const p = repairPlan(state);
  if (!p.ok) return '';
  const lines = [];
  lines.push(`· 最早的错误：${p.最早错误.code}（第 ${p.最早错误.turn} 轮，出自${p.最早错误.kind}）`);
  if (p.建议回滚到) lines.push(`· 干净的起点：${p.建议回滚到.id}（第 ${p.建议回滚到.turn} 轮，${p.建议回滚到.at}）`);
  const poll = (p.被污染的状态项 || []).slice(0, 6);
  if (poll.length) lines.push('· 已被污染、回滚后须重设的：' + poll.map(x => `${x.项}（${x.错误前} → ${x.现在}）`).join('；'));
  return '=== 已知错误与回滚点（本轮写法须避开这些已犯过的错） ===\n' + lines.join('\n');
}

module.exports = { snapshot, listSnapshots, findEarliestError, impacted, rollback, repairPlan, renderKnownErrors, keyFacts, clone };
