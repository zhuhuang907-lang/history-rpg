'use strict';
/**
 * 反迎合 / 反剧情作弊（第二批指令 · 高级机制 B）
 *
 * 要解决的问题：「AI 看起来什么都懂，却总是在关键地方犯错」——
 * 错误不在于它不懂史实，而在于它会**围着玩家的成功或失败偷偷改写规则**：
 *   · 玩家一提计划，NPC 就突然变蠢；
 *   · 玩家缺钱粮时，世界恰好冒出一笔来路不明的钱粮；
 *   · 玩家一查，证据恰好全堆在同一处；
 *   · 玩家犯错，系统临时放宽规则让他过；
 *   · 玩家占优，敌方凭空多出兵力；
 *   · 为了有戏，盟友毫无理由地背叛；
 *   · 为了让玩家失败，推翻已经确认的事实。
 *
 * 这些都不是「叙述风格」问题，而是**状态层面的作弊**，因此必须用确定性规则查，
 * 不能靠提示词求它自觉。本模块在 applyDraft 之前跑，命中硬规则即阻断并说明原因。
 *
 * 判定原则：只查「有没有依据」，不查「好不好看」。有来源、有前置条件的变化一律放行。
 */

/* 阈值：突变超过这个比例且没有对应事件/账目说明，就判为可疑 */
const TH = {
  resourceJumpPct: 0.25,   // 单项资源单轮增幅超过 25%
  troopJumpPct: 0.30,      // 兵力单轮增幅超过 30%
  evidenceBurst: 3,        // 单轮新增线索 ≥3 条且指向同一对象
};

/** 取一个数，取不到就返回 null（绝不猜一个数出来） */
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
const has = (o, k) => !!(o && Object.prototype.hasOwnProperty.call(o, k));

/**
 * @param {object} state 当前世界状态（权威）
 * @param {object} draft 本轮待采纳的草稿（模型产出，不可信）
 * @param {string} scene 本轮正文
 * @returns {Array} 违规列表；每项含 code/sev/title/detail/fix
 */
function check({ state, draft, scene = '' } = {}) {
  const out = [];
  if (!state || !draft) return out;
  const push = (code, sev, title, detail, fix) => out.push({ code, sev, title, detail, fix });
  const text = String(scene || '');

  /* AC-01 资源凭空增加：单轮增幅超阈值，却没有账目说明（reason）或对应事件 */
  const resFields = [
    ['cash', '钱'], ['grain', '粮'], ['troops', '兵'], ['pop', '口'],
  ];
  const ecoBefore = (state.economy && state.economy.revenue) || {};
  for (const [key, label] of resFields) {
    const before = num(has(state.economy, key) ? state.economy[key] : (state.economy && state.economy[key]));
    const deltas = (draft.economyDeltas || draft.deltas || []).filter(d => d && (d.field === key || d.item === label));
    for (const d of deltas) {
      const delta = num(d.delta != null ? d.delta : d.value);
      if (delta == null || delta <= 0 || before == null || before <= 0) continue;
      const pct = delta / before;
      const limit = (key === 'troops') ? TH.troopJumpPct : TH.resourceJumpPct;
      if (pct <= limit) continue;
      const noReason = !d.reason && !d.source && !d.book;
      const noEvent = !(draft.events && draft.events.length) && !(draft.worldChanges && draft.worldChanges.length);
      if (noReason || noEvent) {
        push('AC-01', 'S1', `${label}凭空增加`,
          `本轮${label}增加 ${delta}（约 ${(pct * 100).toFixed(0)}%），但没有账目说明` +
          (noReason ? '（缺 reason）' : '') + (noEvent ? '，也没有对应事件' : '') + '。',
          '要么补上来源（谁给的、从哪来、记在哪本账），要么删掉这笔增加——不能玩家需要什么就来什么。');
      }
    }
  }

  /* AC-02 盟友无故背叛：标记了倒戈，却没有触发条件（利益未变、无事件、态度未恶化） */
  for (const n of (draft.npcUpdates || draft.npcs || [])) {
    if (!n || !n.name) continue;
    const defected = /倒戈|背叛|反水|投敌|背弃/.test(String(n.defection || n.note || n.action || ''));
    if (!defected) continue;
    const prev = (state.npcs || []).find(x => x.name === n.name) || {};
    const goalChanged = n.goal && n.goal !== prev.goal;
    const attitudeWorse = /恶|疑|怨|恨/.test(String(n.attitude || '')) && String(n.attitude) !== String(prev.attitude || '');
    const hasTrigger = goalChanged || attitudeWorse || (draft.events && draft.events.length);
    if (!hasTrigger) {
      push('AC-02', 'S1', '盟友无故背叛',
        `${n.name}本轮被写成倒戈/背叛，但他的目标、态度都没有变化，也没有任何触发事件。`,
        '背叛必须有因：利益被夺、受到威胁、或发生了具体事件。为了有戏而让盟友背叛，必须删掉。');
    }
  }

  /* AC-03 已确认的史实锚点被推翻（硬锚点不可被剧情推翻） */
  const anchors = (state.divergence && state.divergence.anchors) || [];
  for (const a of anchors) {
    if (!a || !a.hard) continue;
    for (const bad of (a.mustNot || [])) {
      if (!bad) continue;
      if (text.includes(String(bad))) {
        push('AC-03', 'S0', '推翻硬史实锚点',
          `正文出现了已明令禁止的说法「${bad}」（锚点：${a.text || ''}）。`,
          '硬锚点是不可被剧情推翻的。删掉这句，或先修改锚点本身并说明理由。');
      }
    }
  }

  /* AC-04 已确认事实被静默改写：同一件事前后两个值，且没有说明为什么改 */
  const facts = (state.facts || state.infoFacts || []);
  for (const f of (draft.factUpdates || draft.facts || [])) {
    if (!f || !f.key) continue;
    const prev = facts.find(x => x && x.key === f.key);
    if (!prev) continue;
    const b = String(prev.value ?? ''), a2 = String(f.value ?? '');
    if (b && a2 && b !== a2 && !f.why && !f.evidence && !f.source) {
      push('AC-04', 'S1', '已确认事实被静默改写',
        `「${f.key}」由「${b}」改为「${a2}」，没有说明依据。`,
        '改已经确认的事实必须给出证据或理由；给不出就保持原值。');
    }
  }

  /* AC-05 证据一轮集中爆发：单轮新增 ≥3 条线索，且全部指向同一对象 */
  const added = (draft.newThreads || draft.threads || []).filter(t => t && t.title);
  if (added.length >= TH.evidenceBurst) {
    const names = new Set();
    for (const n of (state.npcs || [])) {
      if (!n || !n.name) continue;
      if (added.every(t => String(t.title).includes(n.name))) names.add(n.name);
    }
    if (names.size) {
      push('AC-05', 'S2', '证据集中爆发',
        `本轮一次新增 ${added.length} 条线索，且全部指向 ${[...names].join('、')}。`,
        '玩家一查就把证据全翻出来，等于替玩家赢了。应当分散在多轮，且每条都要有独立的获取途径。');
    }
  }

  /* AC-06 敌方在玩家占优时凭空增兵：无来源的兵力补充 */
  for (const f of (draft.factionUpdates || draft.factions || [])) {
    if (!f || !f.name) continue;
    const before = num(f.troopsBefore), after = num(f.troopsAfter != null ? f.troopsAfter : f.troops);
    if (before == null || after == null || after <= before) continue;
    if (!f.source && !f.reason && !f.event) {
      push('AC-06', 'S1', '敌方凭空增兵',
        `${f.name}的兵力由 ${before} 增至 ${after}，没有说明兵从哪来。`,
        '补兵要有出处：征募、援军、收编，都要写清来源与时间。凭空多出来就是围着玩家改规则。');
    }
  }

  return out;
}

/** 只保留硬违规（S0/S1）；S2 及以下是提示，不阻断 */
const blocking = list => (list || []).filter(x => x.sev === 'S0' || x.sev === 'S1');

/** 渲染成给玩家/GM 看的说明 */
function render(list) {
  if (!list || !list.length) return '';
  const L = { S0: '必须改', S1: '需要说明', S2: '提示' };
  return list.map(x => `【${x.code}·${L[x.sev] || x.sev}】${x.title}：${x.detail}\n　→ ${x.fix}`).join('\n');
}

module.exports = { check, blocking, render, TH };
