'use strict';
/**
 * 自测：史料数字必须压过通用公式
 *
 * 用户指出「数据几乎都是错的，有些数据是可以搜到的」。实测最刺眼的一例：
 *   本地档案（《资治通鉴》）明写萧纪「有马八千匹」，
 *   账本却给他 72 匹 —— 因为 economy 用 `horses = 兵 × 0.06` 的通用公式，
 *   把已有的史料数字整个盖掉了，差 111 倍。
 *
 * 本测试钉死三条：
 *   ① 档案里有带出处的数字 → 必须用史料值；
 *   ② 覆盖要留痕（能追溯 before/after 与出处）；
 *   ③ 幂等：反复调用不堆积、不改写 before。
 */
const path = require('path');
process.env.RPG_DATA_DIR = path.join(__dirname, 'data');

const econ = require('./core/economy');
const figure = require('./core/figure-data');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  → ' + extra : ''}`); } };

const mk = (name, year, loc = '成都') => ({
  clock: { gregorianYear: year }, location: { full: loc },
  identityModule: 'official', protagonist: { name }, npcs: [],
});

(async () => {
  console.log('\n[1] 史料数字压过公式');
  const st = mk('萧纪', 548);
  const d = figure.dossierAt('萧纪', 548);
  ok('前提：本地档案确有「有马八千匹」这条史料', /有马八千匹/.test(String((d.resources || {}).note || '')), String((d.resources || {}).note || '').slice(0, 40));

  const e = econ.eco(st);
  ok('账本马匹采用史料值 8000，而不是公式值', e.military.horses === 8000, `实际 ${e.military.horses}`);
  ok('（对照）公式值确实是错的：兵×0.06 远小于史料', Math.round(e.military.total * 0.06) < 8000);

  console.log('\n[2] 覆盖必须留痕');
  const ov = e.historicalOverrides || [];
  ok('留下覆盖记录', ov.length === 1, JSON.stringify(ov));
  ok('记录了出处', /资治通鉴/.test(String((ov[0] || {}).src || '')), String((ov[0] || {}).src));
  ok('记录了原文凭据', /有马八千匹/.test(String((ov[0] || {}).quote || '')));
  ok('记录了 before（被公式盖掉的原值）', typeof (ov[0] || {}).before === 'number');

  console.log('\n[3] 幂等：反复调用不堆积、不改坏 before');
  const before0 = ov[0].before;
  econ.eco(st); econ.eco(st); econ.eco(st);
  const e2 = econ.eco(st);
  ok('重复调用后数值不变', e2.military.horses === 8000);
  ok('覆盖记录不堆积（仍 1 条）', (e2.historicalOverrides || []).length === 1, String((e2.historicalOverrides || []).length));
  ok('before 保留首次值（可追溯原公式值）', (e2.historicalOverrides || [])[0].before === before0, `${(e2.historicalOverrides || [])[0].before} vs ${before0}`);

  console.log('\n[4] 没有史料数字时不得凭空造');
  const st2 = mk('马希声', 907, '潭州');
  const e3 = econ.eco(st2);
  ok('无史料条目的人物保持估算，不硬套', (e3.historicalOverrides || []).length === 0, JSON.stringify(e3.historicalOverrides || []));
  ok('估算值仍标注来源', !!e3.scope && !!e3.scope.source, JSON.stringify(e3.scope));

  console.log(`\n———— 史料数字优先：${pass} 通过 / ${fail} 失败 ————`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自测崩溃：', e); process.exit(1); });
