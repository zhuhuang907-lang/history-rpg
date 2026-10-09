'use strict';
/* 熙宁元年「人力钱粮兵」复核自测：旧算法曾把百姓收成倒进官仓，且 conservation 永远是空的。 */
const eco = require('./core/economy');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

const s = JSON.parse(fs.readFileSync('rulepacks/states/yezhiwei-1068-autumn.json', 'utf8'));

console.log('[1] 熙宁元年（1068）·常州 —— 户口随时代与地域量级修正（不再固定 12000 户）');
const e0 = eco.initEconomy(s, { force: true });
const p = e0.population;
ok(p.households > 12000, `户 ${p.households} 已按 宋辽金 · 江南富庶 上修（旧为固定 12000）`);
ok(e0.estimate && e0.estimate.confidence === 'low', '标注为 estimate·低可信（不冒充史料）');
ok(/宋辽金/.test(e0.estimate.basis) && /江南/.test(e0.estimate.basis), 'basis 写明时代与地域依据');

console.log('[2] 关键区分：全境产出 ≠ 官府岁入');
const rev = e0.revenue;
ok(rev.annualTaxShi < p.annualGrainShi * 0.2, `岁入 ${rev.annualTaxShi} 石远低于年产 ${p.annualGrainShi} 石（官府只收赋，旧版却按年产 12% 给官仓）`);
ok(rev.annualTaxShi === Math.round(p.annualGrainShi * rev.taxRate), `岁入 = 年产 × 税率 ${rev.taxRate}`);
ok(rev.annualUpkeepShi > 0, `岁出（兵粮廪给）${rev.annualUpkeepShi} 石 已按实际兵数与户口折算`);

console.log('[3] 旧致命 bug：秋收不再把百姓收成倒进官仓');
const before = e0.treasury.grainShi;
s.clock.month = 9;                       // 收获之月
const ch1 = eco.tickEconomy(s, 30);
const afterHarvest = e0.treasury.grainShi;
ok(afterHarvest <= before, `秋收月官仓不再暴涨（${before} → ${afterHarvest}，旧版会 +${Math.round(p.annualGrainShi * 0.5)}）`);
ok(!ch1.some(c => /秋收入仓/.test(c)), '已无「秋收入仓」这条凭空增收');

console.log('[4] 跑满一整年：官仓只在合理区间波动，不再指数膨胀');
const s2 = JSON.parse(fs.readFileSync('rulepacks/states/yezhiwei-1068-autumn.json', 'utf8'));
const e2 = eco.initEconomy(s2, { force: true });
const start = e2.treasury.grainShi;
for (let m = 1; m <= 12; m++) { s2.clock.month = m; eco.tickEconomy(s2, 30); }
const endYear1 = e2.treasury.grainShi;
s2.clock.gregorianYear = 1069;
for (let m = 1; m <= 12; m++) { s2.clock.month = m; eco.tickEconomy(s2, 30); }
const endYear2 = e2.treasury.grainShi;
console.log(`    官仓：开 ${start} → 一年 ${endYear1} → 两年 ${endYear2}`);
ok(endYear1 < start * 4, '一年后未膨胀到数倍（旧版会翻好几倍）');
ok(Math.abs(endYear2 - endYear1) < start * 3, '第二年增长已收敛（岁入−岁出趋稳）');

console.log('[5] 守恒现在是真的：账实不符会被抓出来（NU-05）');
const audit = eco.conservation(s2);
ok(!audit.some(a => a.code === 'NU-05'), '正常路径账实相符，无误报');
const tampered = eco.eco(s2);
const real = tampered.treasury.grainShi;
tampered.treasury.grainShi = real + 500000;      // 模拟某模块绕过记账直接改库存
const audit2 = eco.conservation(s2);
ok(audit2.some(a => a.code === 'NU-05'), '绕过记账凭空加 50 万石 → 立刻报 NU-05 账实不符');
tampered.treasury.grainShi = real;

console.log('[6] 量级失实会被报警（过去完全不查）');
const s3 = JSON.parse(fs.readFileSync('rulepacks/states/yezhiwei-1068-autumn.json', 'utf8'));
const e3 = eco.initEconomy(s3, { force: true });
e3.military.total = 99999;                        // 一个州凭空 nine万兵
ok(eco.conservation(s3).some(a => a.code === 'NU-03'), '兵额超出可征丁男 → NU-03 报警');
e3.military.total = 240;
e3.treasury.grainShi = (e3.revenue.annualTaxShi || 1) * 20;   // 存了 20 年赋入
eco.eco(s3); eco.conservation(s3);                             // 先对齐基准，再制造超标
e3.treasury.grainShi = e3.baseline.grainShi + (e3.revenue.annualTaxShi || 1) * 20;
ok(eco.conservation(s3).some(a => /官仓储积/.test(a.item)), '官仓储积超过常理年限 → NU-01 报警');

console.log('[7] 摘要把「民田年产」与「官府岁入」分开写（旧版混为一谈）');
const txt = eco.renderEconomy(s3);
ok(/全境民田/.test(txt) && /属编户百姓/.test(txt), '年产标注为百姓所有');
ok(/官府赋额/.test(txt) && /上供起运/.test(txt), '分列官府赋额与上供');
ok(/本州实收留存/.test(txt) && /岁出/.test(txt), '分列本州留存与岁出');
ok(/【估算说明】/.test(txt), '显示估算依据与免责说明');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
