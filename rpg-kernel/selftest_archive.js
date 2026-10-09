'use strict';
/* 档案馆（历史锚定协议）自测：纯离线，不依赖网络与大模型。 */
const archive = require('./core/archive');
const { worldContext, saveArchive, loadArchive, renderArchiveBlock, stamp } = archive;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

const PACK = { eventsByEra: { song1068: ['青苗法议起', '西夏寇边'] } };

function mkState(o) {
  return {
    meta: { id: o.id, ruleset: 'history-sim-v4' },
    clock: { yearLabel: o.yearLabel, gregorianYear: o.year, month: 1, day: 7, season: '初春' },
    location: { polity: o.polity, full: o.place, controller: o.controller || '' },
    identityModule: o.idm,
    eraPresetId: o.eraPresetId,
    eraEvents: o.eraEvents || [],
    factions: o.factions || [],
    geography: o.geography,
    npcs: o.npcs || [],
    reigningSovereign: o.reigningSovereign || '',
  };
}

(async function main() {
  console.log('[1] worldContext：宋·熙宁元年(1068)·汴梁·官员 → 离线年表锁定真实君主');
  const s1 = mkState({
    id: 'selftest-archive-1', yearLabel: '熙宁元年', year: 1068, polity: '宋', place: '汴梁',
    idm: 'official', eraPresetId: 'song1068',
    geography: { 地形: '平衍', 水系: '汴河贯城', source: 'wikipedia' },
    npcs: [{ name: '王安石', role: '参知政事', source: 'historical', born: 1021, qid: 'Q434055' }],
    factions: [{ name: '新党 vs 旧党' }],
  });
  const c1 = worldContext(s1, PACK);
  ok(c1.identity === 'official', '身份=official');
  ok(c1.eraLabel === '熙宁元年' && c1.gregorianYear === 1068, '时代=熙宁元年/1068');
  ok(c1.place === '汴梁' && c1.polity === '宋', '地点/政权=汴梁/宋');
  ok(!!c1.ruler, '解析出当朝天子');
  ok(c1.ruler && c1.ruler.value.name === '赵顼', `天子=赵顼（实际 ${c1.ruler && c1.ruler.value.name}）`);
  ok(c1.ruler && c1.ruler.value.age === 21, `天子年龄=21 虚岁（1068-1048+1，实际 ${c1.ruler && c1.ruler.value.age}）`);
  ok(c1.ruler && c1.ruler.source === 'offline' && c1.ruler.confidence === 'high', '来源=offline·高可靠');

  console.log('[2] 天下大势 / 派系 / 数字上限 / 时代观念 均随时代与身份产出');
  ok(c1.eraEvents.length === 2, `天下大势 2 条（实际 ${c1.eraEvents.length}）`);
  ok(c1.eraEvents[0] && c1.eraEvents[0].source === 'rulepack', '大势来源=rulepack');
  ok(c1.factions.length === 1 && c1.factions[0].source === 'rulepack', '派系按时代+身份产出且标注来源');
  ok(!!c1.numericCeiling && /已按时代折算/.test(c1.numericCeiling.value), '数字上限已按时代折算');
  ok(c1.eraVocab.length > 0, `时代观念条目 ${c1.eraVocab.length} 条`);

  console.log('[3] 地理与同代真人：直接复用已核实的真实数据，不重复检索');
  ok(!!c1.geography && c1.geography.source === 'wikidata', '地理来源=wikidata（真实检索）');
  ok(c1.geography && c1.geography.confidence === 'high', '地理可信度=高');
  ok(c1.persons.length === 1 && c1.persons[0].value.name === '王安石', '同代真人=王安石');
  ok(c1.persons[0] && c1.persons[0].source === 'wikidata', '真人类别来源=wikidata');

  console.log('[4] 差异化：换时代/换地理 → 底盘随之改变（不是同一套数据贴皮）');
  const s2 = mkState({
    id: 'selftest-archive-2', yearLabel: '天宝十四载', year: 755, polity: '唐', place: '长安', idm: 'commoner',
  });
  const c2 = worldContext(s2, PACK);
  ok(c2.ruler && c2.ruler.value.name === '李隆基', `唐755 天子=李隆基（实际 ${c2.ruler && c2.ruler.value.name}）`);
  ok(c2.ruler && c2.ruler.value.age === 71, `李隆基 71 岁（755-685+1，实际 ${c2.ruler && c2.ruler.value.age}）`);
  ok(c1.ruler.value.name !== c2.ruler.value.name, '不同时代 → 不同君主（已差异化）');
  ok(c1.place !== c2.place && c1.polity !== c2.polity, '不同地理 → 不同底盘');
  ok(c1.numericCeiling.value !== c2.numericCeiling.value, '数字上限随时代折算不同');

  console.log('[5] 无 which 君主可解析时回落到 reigningSovereign（仍标注来源）');
  const s3 = mkState({ id: 'selftest-archive-3', yearLabel: '自定义', year: 1, polity: '某虚构政权', place: '某地', idm: 'warlord', reigningSovereign: '某主' });
  const c3 = worldContext(s3, PACK);
  ok(!c3.ruler || c3.ruler.value.name === '某主', '回落到当朝天子');
  ok(c3.ruler && c3.ruler.source === 'generated', '回落来源=generated（非假称已核实）');

  console.log('[6] 持久化：saveArchive / loadArchive 往返（档案馆逐局累积）');
  const file = saveArchive('selftest-archive-1', c1);
  ok(!!file, '底盘已落盘 ' + (file ? '✓' : '✗'));
  const back = loadArchive('selftest-archive-1');
  ok(back && back.ruler && back.ruler.value.name === '赵顼', '读回的天子一致');
  ok(back && back.persons.length === 1, '读回的同代真人一致');

  console.log('[7] 提示词渲染：带来源/可信度标注');
  const txt = renderArchiveBlock(s1, PACK);
  ok(/^=== 历史底盘/.test(txt), '含历史底盘标题');
  ok(/来源:offline·可信:high/.test(txt), '含 offline·高 标注');
  ok(/来源:rulepack·可信:medium/.test(txt), '含 rulepack·中 标注');
  ok(/熙宁元年/.test(txt) && /汴梁/.test(txt), '含本局时代与地点');

  console.log('[8] stamp() 结构与默认值');
  const st = stamp('x');
  ok(st.value === 'x' && st.source === 'generated' && st.confidence === 'medium', '默认 source=generated/confidence=medium');

  console.log('[9] 关联模块仍可加载（archive 已被 engine/prompt 引用）');
  let engineOk = true, promptOk = true;
  try { require('./core/engine'); } catch (e) { engineOk = false; console.log('    engine 加载失败: ' + e.message); }
  try { require('./core/prompt'); } catch (e) { promptOk = false; console.log('    prompt 加载失败: ' + e.message); }
  ok(engineOk, 'core/engine 加载正常');
  ok(promptOk, 'core/prompt 加载正常');

  // 清理测试产生的归档文件
  try {
    const fs = require('fs'), path = require('path');
    for (const f of ['selftest-archive-1', 'selftest-archive-2', 'selftest-archive-3']) {
      fs.unlinkSync(path.join(archive.ARCHIVE_DIR, f + '.json'));
    }
  } catch { /* 没有就算了 */ }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
