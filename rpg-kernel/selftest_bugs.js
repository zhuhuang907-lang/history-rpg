'use strict';
/* 本轮修复的 bug 逐条验证（先核实为真，再修，再测）。 */
const engine = require('./core/engine');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

// 用 createSave 把「起始局面」构建成完整存档（补齐 meta/turn/log 等引擎管理字段），
// 再克隆成测试专用 id —— 这样既不依赖 data/saves 里的模板副本，也不会因清理残留而崩。
const STARTER = 'yezhiwei-1068-autumn';         // 规则包里的起始局面 id
const RULESET = 'history-sim-v4';
const SAVE_DIR = path.join(process.cwd(), 'data', 'saves');
const tmp = [];
async function mkSave(tag) {
  const base = await engine.createSave({ ruleset: RULESET, starterId: STARTER, title: 'fixture' });
  try { await engine.deleteSave(base.meta.id); } catch { /* 删掉 createSave 顺手写的那份，只留克隆 */ }
  const s = JSON.parse(JSON.stringify(base));
  s.meta = s.meta || {};
  s.meta.id = `selftest-bug-${tag}-${Date.now()}`;
  await engine.writeState(s);
  tmp.push(s.meta.id);
  return s.meta.id;
}

(async function main() {
  console.log('[1] extractJson：字符串里的花括号不再被当成 JSON 层级');
  const r = engine.extractJson('{"scene":"他说：“{某事}”要办","pendingDecision":"用户决定"}');
  ok(!r.parseFailed, '含 { } 的正文能正确解析（旧实现会数错层级而失败）');
  ok(String(r.scene || '').includes('{某事}'), '正文里的花括号被完整保留');
  ok(r.pendingDecision === '用户决定', '后续字段未被截断');

  console.log('[2] reignLabelFor：跨年按新公元年反查年号');
  ok(engine.reignLabelFor(1068) === '熙宁元年', `1068 → ${engine.reignLabelFor(1068)}`);
  ok(engine.reignLabelFor(1069) === '熙宁二年', `1069 → ${engine.reignLabelFor(1069)}`);
  ok(engine.reignLabelFor(1079) === '元丰二年', `1079 → ${engine.reignLabelFor(1079)}`);

  console.log('[3] dropNpcs：删掉的 NPC 真的会消失（旧实现只过滤新登场的，删不掉已有的人）');
  const id1 = await mkSave('drop');
  {
    const s = await engine.loadState(id1);
    s.npcs = [{ name: '测试甲', role: '甲' }, { name: '测试乙', role: '乙' }, { name: '测试丙', role: '丙' }];
    await engine.writeState(s);
  }
  await engine.applyDraft({ saveId: id1, draft: { scene: '' }, input: '', advanceDays: 0, edits: { dropNpcs: ['测试乙'] } });
  {
    const s = await engine.loadState(id1);
    const names = (s.npcs || []).map(n => n.name);
    ok(!names.includes('测试乙'), `测试乙 已被删除（现存：${names.join('、') || '空'}）`);
    ok(names.includes('测试甲') && names.includes('测试丙'), '未点名删除的人仍在');
  }

  console.log('[4] 跨年不再往年号后面贴字（旧实现会一次一次叠加）');
  const id2 = await mkSave('year');
  {
    const s = await engine.loadState(id2);
    s.clock.gregorianYear = 1068; s.clock.yearLabel = '熙宁元年';
    s.clock.month = 12; s.clock.day = 28;
    await engine.writeState(s);
  }
  await engine.applyDraft({ saveId: id2, draft: { scene: '' }, input: '', advanceDays: 30, edits: {} });
  {
    const s = await engine.loadState(id2);
    ok(s.clock.gregorianYear === 1069, `已跨到 1069（实际 ${s.clock.gregorianYear}）`);
    ok(!/已跨年/.test(String(s.clock.yearLabel || '')), `年号未被污染（实际「${s.clock.yearLabel}」）`);
    ok(s.clock.yearLabel === '熙宁二年', `年号自动改元为「${s.clock.yearLabel}」`);
  }
  // 再跨一次，确认不会叠加
  await engine.applyDraft({ saveId: id2, draft: { scene: '' }, input: '', advanceDays: 30, edits: {} });
  {
    const s = await engine.loadState(id2);
    ok((String(s.clock.yearLabel || '').match(/已跨年/g) || []).length === 0, '连续跨年不会累积「已跨年」字样');
  }

  console.log('[5] getWorld() 只读：打开世界面板不再改存档');
  const id3 = await mkSave('world');
  const file = path.join(SAVE_DIR, `${id3}.json`);
  const before = fs.readFileSync(file, 'utf8');
  let gwOk = true, err = '';
  try { await engine.getWorld(id3); } catch (e) { gwOk = false; err = String(e.message || e); }
  const after = fs.readFileSync(file, 'utf8');
  ok(gwOk, `getWorld 能正常返回${gwOk ? '' : '（' + err + '）'}`);
  ok(before === after, '存档内容一字未改（旧实现会 ensure* 后 writeState）');

  // 清理
  for (const id of tmp) { try { fs.unlinkSync(path.join(SAVE_DIR, `${id}.json`)); } catch { /* 无则跳过 */ } }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
