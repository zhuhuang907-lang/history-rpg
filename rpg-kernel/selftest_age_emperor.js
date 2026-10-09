'use strict';
/* 离线自测：年龄可选 + 皇帝数据不被错覆写。
   不联网：用虚构模式、留空年龄，验证引擎行为。 */
const wg = require('./core/worldgen');
const path = require('path');
const fs = require('fs');
const PACK_DIR = path.join(__dirname, 'rulepacks');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra != null ? JSON.stringify(extra) : ''); }
}

/* ---------- 1) anchorRuler：皇帝 + 留空姓名 → 自动成为该年真君主 ---------- */
console.log('[1] anchorRuler: 皇帝 + 留空姓名 → 年号即定皇帝');
{
  const pack = { rulersByEra: {}, eventsByEra: {} };
  const state = {
    identityModule: 'emperor',
    protagonist: { name: '（未命名）', gender: '男', age: null, birthYear: null, role: '（身份待定）' },
    clock: { gregorianYear: 1068 },
    location: { polity: '宋（两浙路）', controller: '未核实' },
  };
  wg.anchorRuler(pack, null, state);
  ok('皇帝姓名=赵顼', state.protagonist.name === '赵顼', state.protagonist.name);
  ok('皇帝身份=宋神宗', /宋神宗/.test(state.protagonist.role), state.protagonist.role);
  ok('年龄=21(1068-1048+1)', state.protagonist.age === 21, state.protagonist.age);
  ok('模式=real(真君主)', state.mode === 'real', state.mode);
  ok('eraEvents 已注入', Array.isArray(state.eraEvents) && state.eraEvents.length > 0, state.eraEvents);
  ok('controller=宋神宗', state.location.controller === '宋神宗', state.location.controller);
}

/* ---------- 2) anchorRuler：皇帝 + 填了虚构姓名 → 尊重玩家，不覆盖 ---------- */
console.log('[2] anchorRuler: 皇帝 + 填虚构姓名 → 不覆盖');
{
  const pack = { rulersByEra: {}, eventsByEra: {} };
  const state = {
    identityModule: 'emperor',
    protagonist: { name: '叶知微', gender: '男', age: null, birthYear: null, role: '（身份待定）' },
    clock: { gregorianYear: 1068 },
    location: { polity: '宋（两浙路）', controller: '未核实' },
  };
  wg.anchorRuler(pack, null, state);
  ok('姓名保持=叶知微', state.protagonist.name === '叶知微', state.protagonist.name);
  ok('未覆盖为赵顼', state.protagonist.name !== '赵顼');
  ok('eraEvents 不强行注入冲突的君主大事', state.eraEvents && state.eraEvents.length === 0, state.eraEvents);
}

/* ---------- 3) anchorRuler：皇帝 + 填了同年真君主姓名 → 同名则补真实年龄 ---------- */
console.log('[3] anchorRuler: 皇帝 + 填同年真君主姓名(赵顼) → 同名保留并补年龄');
{
  const pack = { rulersByEra: {}, eventsByEra: {} };
  const state = {
    identityModule: 'emperor',
    protagonist: { name: '赵顼', gender: '男', age: null, birthYear: null, role: '（身份待定）' },
    clock: { gregorianYear: 1068 },
    location: { polity: '宋（两浙路）', controller: '未核实' },
  };
  wg.anchorRuler(pack, null, state);
  ok('姓名保持=赵顼', state.protagonist.name === '赵顼');
  ok('年龄=21', state.protagonist.age === 21, state.protagonist.age);
}

/* ---------- 4) anchorRuler：非皇帝 → 记录当朝天子 + 该朝大事 ---------- */
console.log('[4] anchorRuler: 非皇帝 → 当朝天子 + eraEvents');
{
  const pack = { rulersByEra: {}, eventsByEra: {} };
  const state = {
    identityModule: 'official',
    protagonist: { name: '欧阳修', gender: '男', age: null, birthYear: null, role: '（身份待定）' },
    clock: { gregorianYear: 1068 },
    location: { polity: '宋（两浙路）', controller: '未核实' },
  };
  wg.anchorRuler(pack, null, state);
  ok('当朝天子=宋神宗 赵顼', /宋神宗/.test(state.reigningSovereign || ''), state.reigningSovereign);
  ok('eraEvents 已注入', Array.isArray(state.eraEvents) && state.eraEvents.length > 0);
}

/* ---------- 5) createCustomSave：虚构 + 皇帝 + 留空年龄 + 留空姓名 → 真实君主且年龄正确 ---------- */
console.log('[5] createCustomSave: 虚构 皇帝 宋1068 留空年龄 → 赵顼/21');
(async () => {
  const engine = require('./core/engine');
  const id = 'selftest-age-' + Date.now().toString(36);
  try {
    const s = await engine.createCustomSave({
      ruleset: 'history-sim-v4', id, title: 'test',
      era: { yearLabel: '熙宁元年', gregorianYear: 1068, polity: '宋（两浙路）', month: 1, day: 1 },
      identityModule: 'emperor',
      protagonist: { name: '', age: null, gender: '男', role: '' },
      location: { full: '', polity: '宋（两浙路）', controller: '未核实' },
      mode: 'fictional',
    });
    ok('姓名=赵顼', s.protagonist.name === '赵顼', s.protagonist.name);
    ok('年龄=21', s.protagonist.age === 21, s.protagonist.age);
    ok('eraEvents 注入', Array.isArray(s.eraEvents) && s.eraEvents.length > 0, s.eraEvents);
  } catch (e) {
    fail++; console.log('  FAIL createCustomSave threw', e.message);
  }

  /* 6) 虚构 + 皇帝 + 自定义姓名(虚构) + 留空年龄 → 尊重玩家；seedWorld 估计年龄(非null) */
  const id2 = 'selftest-age2-' + Date.now().toString(36);
  try {
    const s2 = await engine.createCustomSave({
      ruleset: 'history-sim-v4', id: id2, title: 'test2',
      era: { yearLabel: '熙宁元年', gregorianYear: 1068, polity: '宋（两浙路）', month: 1, day: 1 },
      identityModule: 'emperor',
      protagonist: { name: '李逍遥', age: null, gender: '男', role: '' },
      location: { full: '', polity: '宋（两浙路）', controller: '未核实' },
      mode: 'fictional',
    });
    ok('姓名保持=李逍遥', s2.protagonist.name === '李逍遥', s2.protagonist.name);
    ok('createCustomSave 未覆盖为赵顼', s2.protagonist.name !== '赵顼');
    // 年龄估计发生在 seedWorld（前端在建档后立即调用），未配适配器时按身份给中性默认值
    const w2 = await engine.seedWorld({ saveId: s2.meta.id });
    ok('seedWorld 后年龄被估计(非null)', w2.state.protagonist.age != null, w2.state.protagonist.age);
  } catch (e) {
    fail++; console.log('  FAIL createCustomSave2 threw', e.message);
  }

  /* 清理测试存档 */
  for (const fid of [id, id2]) {
    try { fs.unlinkSync(path.join(__dirname, 'data', 'saves', fid + '.json')); } catch {}
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
