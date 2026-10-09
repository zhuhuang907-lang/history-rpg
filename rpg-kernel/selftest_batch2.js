'use strict';
/**
 * 第二批专项改造自测：反迎合/反剧情作弊（B）+ 存档版本与状态恢复（第 11 项）。
 * 重点不只在于「拦得住」，更在于**不误伤**——有来源的变化必须放行，
 * 否则这层校验会把正常游戏卡死，那比作弊本身更糟。
 */
const ac = require('./core/anticheat');
const engine = require('./core/engine');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('\n[B1] 反剧情作弊：围着玩家改规则的写法必须拦下');
{
  let v = ac.check({ state: { economy: { grain: 1000 } }, draft: { economyDeltas: [{ field: 'grain', delta: 800 }] }, scene: '' });
  ok('AC-01 粮凭空增加（+80% 且无来源）被拦', v.some(x => x.code === 'AC-01'), JSON.stringify(v));

  v = ac.check({ state: { economy: { grain: 1000 } }, draft: { economyDeltas: [{ field: 'grain', delta: 800, reason: '常平仓拨付', book: 'finance' }], events: ['拨粮'] }, scene: '' });
  ok('AC-01 有账目来源的同额增加**放行**（不误伤）', v.length === 0, JSON.stringify(v));

  v = ac.check({ state: { economy: { grain: 1000 } }, draft: { economyDeltas: [{ field: 'grain', delta: 50, reason: '秋税' }] }, scene: '' });
  ok('AC-01 小幅增加（5%）不触发', v.length === 0, JSON.stringify(v));

  v = ac.check({ state: { npcs: [{ name: '潘义', goal: '保住官职' }] }, draft: { npcs: [{ name: '潘义', note: '倒戈投敌' }] }, scene: '' });
  ok('AC-02 盟友无故背叛被拦', v.some(x => x.code === 'AC-02'), JSON.stringify(v));

  v = ac.check({ state: { npcs: [{ name: '潘义', goal: '保住官职' }] }, draft: { npcs: [{ name: '潘义', note: '倒戈投敌', goal: '自保' }] }, scene: '' });
  ok('AC-02 目标已变的背叛**放行**（有因）', !v.some(x => x.code === 'AC-02'), JSON.stringify(v));

  v = ac.check({ state: { divergence: { anchors: [{ hard: true, text: '武帝尚在', mustNot: ['皇帝已崩'] }] } }, draft: {}, scene: '城中都传皇帝已崩了。' });
  ok('AC-03 推翻硬史实锚点被拦（S0 最高级）', v.some(x => x.code === 'AC-03' && x.sev === 'S0'), JSON.stringify(v));

  v = ac.check({ state: { facts: [{ key: '城守', value: '王僧辩' }] }, draft: { factUpdates: [{ key: '城守', value: '侯景' }] }, scene: '' });
  ok('AC-04 已确认事实被静默改写被拦', v.some(x => x.code === 'AC-04'), JSON.stringify(v));

  v = ac.check({ state: { facts: [{ key: '城守', value: '王僧辩' }] }, draft: { factUpdates: [{ key: '城守', value: '侯景', why: '城破易主', evidence: '探报' }] }, scene: '' });
  ok('AC-04 给了依据的改写**放行**', !v.some(x => x.code === 'AC-04'), JSON.stringify(v));

  v = ac.check({ state: {}, draft: { factions: [{ name: '侯景', troopsBefore: 8000, troopsAfter: 30000 }] }, scene: '' });
  ok('AC-06 敌方凭空增兵被拦', v.some(x => x.code === 'AC-06'), JSON.stringify(v));

  v = ac.check({ state: {}, draft: { factions: [{ name: '侯景', troopsBefore: 8000, troopsAfter: 12000, source: '收编降卒', event: '历阳降' }] }, scene: '' });
  ok('AC-06 有出处的增兵**放行**', !v.some(x => x.code === 'AC-06'), JSON.stringify(v));

  // 干净草稿绝不能误报——这是这层校验能否上线的前提
  v = ac.check({ state: { economy: { grain: 1000 }, npcs: [], divergence: {}, facts: [] }, draft: { economyDeltas: [{ field: 'grain', delta: 50, reason: '秋税', book: 'finance' }], events: ['征税'] }, scene: '百姓纳粮，仓吏记账。' });
  ok('干净草稿零违规（不误伤）', v.length === 0, JSON.stringify(v));

  ok('阻断级只含 S0/S1', ac.blocking([
    { code: 'a', sev: 'S0' }, { code: 'b', sev: 'S1' }, { code: 'c', sev: 'S2' },
  ]).length === 2);
}

console.log('\n[B2] 存档版本锁：旧草稿不得覆盖新世界（长局崩坏的根因之一）');
(async () => {
  await engine.ensureDirs();
  const s = await engine.createCustomSave({
    ruleset: 'history-sim-v4', id: 'vlock', title: '版本锁测试',
    era: { yearLabel: '熙宁元年', gregorianYear: 1068, polity: '宋', month: 1, day: 1 },
    identityModule: 'official',
    protagonist: { name: '叶知微', age: 40, gender: '男', role: '知常州事' },
    location: { full: '常州', polity: '宋', controller: '宋廷' },
    mode: 'fictional',
  });
  const id = s.meta.id;
  const t0 = s.turn || 0;

  // ① 过期草稿：基于更早的轮次
  const r1 = await engine.applyDraft({ saveId: id, draft: { baseTurn: t0 - 1, threads: [] }, advanceDays: 1 });
  ok('过期草稿被拒绝', r1 && r1.ok === false && r1.stale === true, JSON.stringify(r1).slice(0, 120));
  ok('拒绝时说明原因（第几轮 → 第几轮）', /轮出的/.test(String(r1.why || '')), String(r1.why).slice(0, 60));

  // ② 命中反作弊的草稿：不得写进存档
  const r2 = await engine.applyDraft({ saveId: id, draft: { baseTurn: t0, factions: [{ name: '侯景', troopsBefore: 8000, troopsAfter: 30000 }] }, advanceDays: 1 });
  ok('作弊草稿被拒绝', r2 && r2.ok === false && r2.antiCheat === true, JSON.stringify(r2).slice(0, 120));
  ok('拒绝时给出具体违规与改法', /AC-06/.test(String(r2.why || '')), String(r2.why).slice(0, 80));

  // ③ 正常草稿：放行并递增版本
  const r3 = await engine.applyDraft({ saveId: id, draft: { baseTurn: t0, threads: [{ title: '督催秋税' }] }, advanceDays: 1 });
  ok('正常草稿通过', !(r3 && r3.ok === false), JSON.stringify(r3).slice(0, 120));
  const st = await engine.loadState(id);
  ok('回合推进', st.turn === t0 + 1, String(st.turn));
  ok('写入版本号（供后续差异比对）', (st.version || 0) >= 1, String(st.version));

  // ④ 被拒绝的草稿不得留下痕迹
  ok('过期/作弊草稿未推进回合', st.turn === t0 + 1, String(st.turn));

  await engine.deleteSave(id);
  console.log('    （测试档已清理）');
  console.log('\n===== 第二批改造自测：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
