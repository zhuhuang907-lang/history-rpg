'use strict';
/** 朝政/案牍自测：长线 120 个月不崩、数值不出界；勤政与怠政走向不同 */
const engine = require('./core/engine');
const court = require('./core/court');
const { eco } = require('./core/economy');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

async function fresh(id) {
  const pack = (await engine.listRulepacks())[0];
  const st = pack.starters.find(s => !s.custom) || pack.starters[0];
  const s = await engine.createSave({ ruleset: pack.id, starterId: st.id });
  const state = JSON.parse(JSON.stringify(s));
  state.meta.id = id; state.turn = 0;
  return state;
}

function run(state, months, pick) {
  let memos = 0;
  for (let i = 0; i < months; i++) {
    state.turn = (state.turn || 0) + 1;
    state.clock.month = (state.clock.month % 12) + 1;
    if (state.clock.month === 1) state.clock.gregorianYear++;
    court.tickCourt(state, 30);
    court.generate(state);
    for (const m of court.ensureCourt(state).pending.slice()) { memos++; const o = pick(m); if (o) court.decide(state, m.id, o); }
  }
  return memos;
}

(async () => {
  const good = await fresh('selftest-court-good');
  const nGood = run(good, 120, m => (m.options.find(o => /赈|巡察|平粜|招抚|犒军|进剿|减征|照额/.test(o.label)) || m.options[0]).id);
  const bad = await fresh('selftest-court-bad');
  run(bad, 120, m => (m.options.find(o => /自行|姑且|听其|不问|坚守|加派|加征/.test(o.label)) || m.options[m.options.length - 1]).id);
  const gG = court.view(good).gauges, gB = court.view(bad).gauges;
  console.log('  勤政十年：', gG, '钱', eco(good).treasury.cashGuan, '粮', eco(good).treasury.grainShi);
  console.log('  怠政十年：', gB, '钱', eco(bad).treasury.cashGuan, '粮', eco(bad).treasury.grainShi);
  ok(nGood > 20, `十年里送来 ${nGood} 件案牍`);
  const inRange = g => Object.values(g).every(v => Number.isFinite(v) && v >= 0 && v <= 100);
  ok(inRange(gG) && inRange(gB), '四项指标始终在 0~100');
  ok([good, bad].every(s => Number.isFinite(eco(s).treasury.cashGuan) && eco(s).treasury.cashGuan >= 0 && Number.isFinite(eco(s).treasury.grainShi)), '钱粮不为负、不为 NaN');
  ok(gG.民心 > gB.民心 && gG.匪患 < gB.匪患, '勤政者民心更高、匪患更低（选择真的有后果）');
  ok(eco(good).ledgers.finance.length > 0, '批阅后果都记进财政账');
  const p = require('./core/prompt');
  ok(/朝局指标/.test(court.renderCourt(good)), '提示词里带上朝局与已批案牍');
  void p;
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
