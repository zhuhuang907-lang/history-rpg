'use strict';
/* 身份决定财赋疆域：过去 initEconomy 只看地点，皇帝被塞进一个州 —— 用户当场指出。 */
const eco = require('./core/economy');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

function mk(o) {
  return {
    meta: { id: o.id },
    clock: { yearLabel: o.yearLabel, gregorianYear: o.year, month: 1, day: 7 },
    location: { polity: o.polity || '', full: o.place || '' },
    identityModule: o.idm,
    protagonist: { name: o.name || '某人', role: o.role || '' },
    territory: o.territory || [],
    turn: 0,
  };
}

console.log('[1] 皇帝 = 天下，不再是一个州');
const emp = mk({ id: 't-emp', yearLabel: '熙宁元年', year: 1068, polity: '宋', place: '汴梁', idm: 'emperor', role: '皇帝' });
const eEmp = eco.initEconomy(emp, { force: true });
ok(eEmp.scope.level === 'empire', `scope=empire（实际 ${eEmp.scope.level}）`);
ok(eEmp.population.households > 1000000, `户 ${eEmp.population.households} 已达天下量级（旧版只会给州级的 12000）`);
ok(/天下/.test(eEmp.scale), `摘要标为「${eEmp.scale}」`);
ok(eEmp.scope.source === 'estimate' || eEmp.scope.source === 'recorded', `来源如实标注为 ${eEmp.scope.source}（未冒充精确史料）`);

console.log('[2] 职官 = 所治之境（按职衔里的地名推）');
const off = mk({ id: 't-off', yearLabel: '熙宁元年', year: 1068, polity: '宋', place: '两浙路 常州 晋陵县 常州州衙', idm: 'official', role: '通判常州军州事' });
const eOff = eco.initEconomy(off, { force: true });
ok(eOff.scope.level === 'jurisdiction', `scope=jurisdiction（实际 ${eOff.scope.level}）`);
ok(eOff.population.households < 100000, `户 ${eOff.population.households} 为州级（远小于天下）`);
ok(eOff.population.households > eEmp.population.households / 1000, '但仍在合理州级区间');

console.log('[3] 藩镇按地盘数、贵族按封邑、黔首只示所在乡里');
const war = mk({ id: 't-war', year: 1068, place: '扬州', idm: 'warlord', territory: [{ name: '扬州' }, { name: '楚州' }, { name: '滁州' }] });
const eWar = eco.initEconomy(war, { force: true });
ok(eWar.population.households > eco.initEconomy(mk({ id: 't-war1', year: 1068, place: '扬州', idm: 'warlord', territory: [{ name: '扬州' }] }), { force: true }).population.households,
  '地盘越多，户口越大（藩镇随势力增长）');
const nob = eco.initEconomy(mk({ id: 't-nob', year: 1068, place: '洛阳', idm: 'noble' }), { force: true });
ok(nob.scope.level === 'domain' && nob.population.households > 0, `贵族 ${nob.scale}，户 ${nob.population.households}`);
const com = eco.initEconomy(mk({ id: 't-com', year: 1068, place: '晋陵县某乡', idm: 'commoner' }), { force: true });
ok(com.scope.level === 'household', `黔首 scope=household（实际 ${com.scope.level}）`);
ok(com.population.households === 1, `黔首户 ${com.population.households}（只掌自家门户，不是一座城）`);
ok(com.military.total === 0, `黔首兵 ${com.military.total}（旧版硬塞 50 人，失实）`);

console.log('[4] 皇帝局的收支仍然合乎常情（不因放大就把告警打满）');
const alarms = eco.conservation(emp);
const codes = alarms.map(a => a.code);
ok(!codes.includes('NU-05'), '账实相符无误报');
ok(!codes.includes('NU-01'), `量级未触发 NU-01（若有：${alarms.filter(a => a.code === 'NU-01').map(a => a.why).join('｜')}）`);
ok(!codes.includes('NU-03'), `兵力未超限（若有：${alarms.filter(a => a.code === 'NU-03').map(a => a.why).join('｜')}）`);

console.log('[5] 同一地点换身份 → 盘子随之改变（证明参数真的生效了）');
const base = { year: 1068, polity: '宋', place: '常州' };
const as = idm => eco.initEconomy(mk(Object.assign({ id: 't-' + idm }, base, { idm })), { force: true }).population.households;
const hCommoner = as('commoner'), hOfficial = as('official'), hEmperor = as('emperor');
console.log(`    黔首 ${hCommoner} → 职官 ${hOfficial} → 皇帝 ${hEmperor}`);
ok(hCommoner < hOfficial && hOfficial < hEmperor, '身份越高，所掌越大');

console.log('[6] 熙宁元年皇帝局的实际数目');
console.log(eco.renderEconomy(emp).split('\n').map(x => '    ' + x).join('\n'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
