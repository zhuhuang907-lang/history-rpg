'use strict';
/**
 * 长回合压力测试（规格第七部分 · 测试 A：100 回合连续运行）
 *
 * 不走 LLM（一百次真实调用既慢又贵，且测的不是模型而是**状态机**）——
 * 直接驱动与 runTurn 完全相同的纯程序机制：
 *   world.ensureWorld / economy.eco / info.ensureFacts / agency.ensureAgency /
 *   div.ensureDiv / plot.ensurePlot / plot.planArcs / events.rollEvent / drama.rollDrama
 *   + 时钟推进（与 applyDraft 同一套进位逻辑）+ writeState。
 *
 * 每回合检查规格 §六 测试 A 的七项：
 *   A1 人物身份是否漂移        A2 资源账目是否产生无来源变化
 *   A3 已结束事件是否无故复活   A4 旧人物是否被错误地重新生成
 *   A5 时间是否出现倒退        A6 玩家已知信息是否无故丢失
 *   A7 历史事实是否在后续回合被悄悄改写
 * 另记录质量指标（规格 §七）：无来源精确数字数、重复事件率、状态漂移数。
 */
const path = require('path');
process.env.RPG_DATA_DIR = path.join(__dirname, 'data');

const engine = require('./core/engine');
const world = require('./core/world');
const economy = require('./core/economy');
const info = require('./core/info');
const agency = require('./core/npcAgency');
const div = require('./core/divergence');
const plot = require('./core/plot');
const events = require('./core/events');
const drama = require('./core/drama');

const TURNS = 100;
const BASE_SAVE = 'custom-muxbhizl'; // 907 年档，11 NPC，四本账齐

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${extra ? ' → ' + extra : ''}`); }
}

/* 与 applyDraft 相同的时钟进位（30 天一月） */
function advanceClock(state, days) {
  let y = state.clock.gregorianYear || 0;
  let m = state.clock.month || 1;
  let d = (state.clock.day || 1) + days;
  while (d > 30) { d -= 30; m += 1; if (m > 12) { m = 1; y += 1; } }
  state.clock.day = d; state.clock.month = m; state.clock.gregorianYear = y;
  return { y, m, d };
}
const timeVal = c => (c.gregorianYear || 0) * 10000 + (c.month || 0) * 100 + (c.day || 0);

(async () => {
  /* ---- 克隆种子档，不碰原档 ---- */
  const src = await engine.loadState(BASE_SAVE);
  const SID = `stress100-${Date.now().toString(36)}`;
  const state = JSON.parse(JSON.stringify(src));
  state.meta = { ...(state.meta || {}), id: SID, title: '百回合压测' };
  await engine.writeState(state);

  /* ---- 基线快照 ---- */
  const proto0 = { name: state.protagonist && state.protagonist.name, role: state.protagonist && state.protagonist.role };
  const npc0 = new Map((state.npcs || []).map(n => [n.name, { source: n.source, role: n.role || '' }]));
  const anchors0 = JSON.stringify((state.div && state.div.anchors) || (state.divergence && state.divergence.anchors) || []);
  const knownFacts0 = new Set(((state.info && state.info.facts) || []).filter(f => (f.knowers || []).some(k => (k.who || k) === '玩家')).map(f => f.id || f.content));

  let prevTime = timeVal(state.clock);
  let prevTreasury = JSON.stringify(state.economy && state.economy.treasury);
  const arcStatus = new Map(); // arcId → status（跟踪复活）
  let noSourceJumps = 0;       // 账目无来源跳变数
  let eventTexts = [];         // 重复事件率用

  console.log(`底座存档：${BASE_SAVE}（${state.clock.gregorianYear} 年，NPC ${npc0.size} 名），压测 ${TURNS} 回合……\n`);

  for (let t = 1; t <= TURNS; t++) {
    const days = 1 + (t % 3); // 每回合推进 1~3 天

    /* 与 runTurn 相同的世界运行机制 */
    world.ensureWorld(state);
    economy.eco(state);
    info.ensureFacts(state);
    agency.ensureAgency(state);
    div.ensureDiv(state);
    plot.ensurePlot(state);
    const plan = plot.planArcs(state, { input: '', advanceDays: days, touched: [] });
    const evt = events.rollEvent(state, { probability: 0.08 });
    if (evt) {
      state.eventLog = state.eventLog || [];
      state.eventLog.push({ turn: state.turn, family: evt.family, familyName: evt.familyName, severity: evt.severity, text: evt.text, effects: evt.effects });
      if (state.eventLog.length > 60) state.eventLog = state.eventLog.slice(-60);
      eventTexts.push(evt.text);
    }
    state.drama = drama.rollDrama(state);

    advanceClock(state, days);
    state.turn = (state.turn || 0) + 1;
    state.version = (state.version || 0) + 1;

    /* ---- 每回合不变量 ---- */
    // A4 时间不倒退
    const tv = timeVal(state.clock);
    if (tv < prevTime) ok(`t${t} 时间倒退`, false, `${prevTime} → ${tv}`);
    prevTime = tv;

    // A1 主角身份不漂移
    if ((state.protagonist.name !== proto0.name) || (state.protagonist.role !== proto0.role))
      ok(`t${t} 主角身份漂移`, false, JSON.stringify(state.protagonist));

    // A3/A4 人物：不丢、不重、历史标记不串
    const seen = new Set();
    for (const n of (state.npcs || [])) {
      if (seen.has(n.name)) ok(`t${t} NPC 重复生成：${n.name}`, false);
      seen.add(n.name);
      const b = npc0.get(n.name);
      if (b && b.source === 'historical' && n.source !== 'historical')
        ok(`t${t} 历史人物来源被改：${n.name}`, false, `${b.source}→${n.source}`);
    }
    for (const name of npc0.keys())
      if (!seen.has(name)) ok(`t${t} 旧 NPC 丢失：${name}`, false);

    // A2 资源账目：数字必须是有限数、不为负；突变必须能在台账里找到记录
    const e = state.economy;
    if (e && e.treasury) {
      for (const [k, v] of Object.entries(e.treasury)) {
        if (typeof v === 'number' && (!Number.isFinite(v) || v < 0))
          ok(`t${t} 账目异常 ${k}=${v}`, false);
      }
      const now = JSON.stringify(e.treasury);
      if (now !== prevTreasury) {
        // 账目变了：必须有台账记录（程序记账）或事件效果，否则记一次无来源跳变
        const led = (e.ledgers && e.ledgers.finance) || [];
        const recent = led.filter(r => (r.turn || 0) >= state.turn - 1);
        if (!recent.length && !evt) noSourceJumps++;
      }
      prevTreasury = now;
    }

    // A3 已结束事件不复活（resolved/terminated 不得退回活跃态）
    const arcs = (state.plot && state.plot.arcs) || [];
    for (const a of arcs) {
      const prev = arcStatus.get(a.id);
      if ((prev === 'resolved' || prev === 'terminated') && !['resolved', 'terminated'].includes(a.status))
        ok(`t${t} 已结束事件复活：${a.id} ${prev}→${a.status}`, false);
      arcStatus.set(a.id, a.status);
    }

    // A6 玩家已知信息不丢失
    const facts = (state.info && state.info.facts) || [];
    for (const f of facts) {
      const fid = f.id || f.content;
      if (knownFacts0.has(fid) && !(f.knowers || []).some(k => (k.who || k) === '玩家'))
        ok(`t${t} 玩家已知信息丢失：${String(f.content).slice(0, 30)}`, false);
    }

    // A7 史实锚点不被改写
    const anchNow = JSON.stringify((state.div && state.div.anchors) || (state.divergence && state.divergence.anchors) || []);
    if (anchNow !== anchors0) ok(`t${t} 史实锚点被改写`, false, anchNow.slice(0, 80));

    // eventLog 封顶 60
    if ((state.eventLog || []).length > 60) ok(`t${t} eventLog 超上限`, false, String(state.eventLog.length));

    if (t % 10 === 0) await engine.writeState(state); // 每 10 回合落盘一次（模拟真实节奏）
  }
  await engine.writeState(state);

  /* ---- 汇总断言 ---- */
  console.log('100 回合跑完，汇总检查：');
  ok('A1 主角身份 100 回合零漂移', !failures.some(f => /主角身份漂移/.test(f)));
  ok('A2 账目无 NaN/负数', !failures.some(f => /账目异常/.test(f)));
  ok(`A2 无来源账目跳变 = 0（实际 ${noSourceJumps}）`, noSourceJumps === 0);
  ok('A3 已结束事件零复活', !failures.some(f => /复活/.test(f)));
  ok('A4 旧人物零丢失、零重复', !failures.some(f => /丢失|重复生成/.test(f)));
  ok('A4 历史人物来源零串改', !failures.some(f => /来源被改/.test(f)));
  ok('A5 时间零倒退', !failures.some(f => /时间倒退/.test(f)));
  ok('A6 玩家已知信息零丢失', !failures.some(f => /信息丢失/.test(f)));
  ok('A7 史实锚点零改写', !failures.some(f => /锚点被改写/.test(f)));
  ok('eventLog 全程封顶 60', !failures.some(f => /eventLog/.test(f)));

  // 重复事件率（质量指标，非硬断言：>30% 记警告）
  const dup = eventTexts.length - new Set(eventTexts).size;
  const dupRate = eventTexts.length ? dup / eventTexts.length : 0;
  console.log(`\n质量指标：突发事件 ${eventTexts.length} 次，重复 ${dup} 次（${(dupRate * 100).toFixed(1)}%）`);
  ok('重复事件率 ≤ 30%', dupRate <= 0.3, `${(dupRate * 100).toFixed(1)}%`);

  // 终局状态可读性
  const fin = await engine.loadState(SID);
  ok('终局存档可完整读回', !!fin && fin.turn >= TURNS);
  console.log(`终局：${fin.clock.gregorianYear} 年 ${fin.clock.month} 月 ${fin.clock.day} 日，turn=${fin.turn}，剧情线 ${(fin.plot.arcs || []).length} 条，NPC ${(fin.npcs || []).length} 名`);

  /* 失败案例存档保留作回归（规格 §六：每项压力测试必须保存失败案例） */
  if (failures.length) {
    console.log('\n失败明细（存档已保留：' + SID + '）：');
    for (const f of failures.slice(0, 20)) console.log('  ✗', f);
  } else {
    await engine.deleteSave(SID).catch(() => {});
    console.log('\n零失败，压测档已清理。');
  }
  console.log(`\n———— 百回合压测：${pass} 通过 / ${fail} 失败 ————`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('压测崩溃：', e); process.exit(1); });
