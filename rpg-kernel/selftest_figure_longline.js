'use strict';
/**
 * 自测：人物身份体检 + 长线历史核实（第二批指令 §12 + 用户「长线跟不上历史变化」）。
 *
 * 用户原话：
 *   「身份设定的错误很多，而且很多内容都不对，我不是只要一个皇帝一个人物，
 *     我选择的所有人物都要有合理的搜索和开局以及不断的历史核实，
 *     你目前长线不行，跟不上历史变化。」
 *
 * 本测覆盖三件事：
 *   ① 身份体检能查出「时代错置 / 生卒矛盾 / 名分不符」——不联网也能查；
 *   ② 跨年时**所有**真实人物（主角 + 历史 NPC）随年份推进，不只是主角；
 *   ③ 端到端：真实存档从 548 跑到 552、554，主角身份与生死跟着变。
 */
const path = require('path');
const DATA = path.join(__dirname, 'data');
process.env.RPG_DATA_DIR = DATA;

const figure = require('./core/figure-data');
const engine = require('./core/engine');

let pass = 0, fail = 0;
const groups = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
function group(t) { groups.push(t); console.log(`\n[${groups.length}] ${t}`); }

(async () => {
  /* ============ ① 身份体检：时代错置 ============ */
  group('身份体检 · 时代错置（梁 548 年）');

  let r = figure.auditFigure({ name: '萧纪', year: 548, role: '元太守' });
  ok('「元太守」在梁太清二年被判为时代错置',
    r.some(x => x.field === 'anachronism'), JSON.stringify(r));

  r = figure.auditFigure({ name: '某甲', year: 548, role: '梁朝益州刺史' });
  ok('「梁朝益州刺史」在 548 年不报错（梁 502~557）',
    !r.some(x => x.field === 'anachronism'), JSON.stringify(r));

  r = figure.auditFigure({ name: '某乙', year: 548, role: '唐朝刺史' });
  ok('「唐朝刺史」在 548 年被判为时代错置',
    r.some(x => x.field === 'anachronism'), JSON.stringify(r));

  r = figure.auditFigure({ name: '某丙', year: 1068, role: '宋朝知州' });
  ok('「宋朝知州」在熙宁元年不报错（赵宋 960~1279）',
    !r.some(x => x.field === 'anachronism'), JSON.stringify(r));

  r = figure.auditFigure({ name: '某丁', year: 548, role: '宋朝太守' });
  ok('「宋朝太守」在 548 年报错（刘宋 420~479、赵宋 960~1279 皆不合）',
    r.some(x => x.field === 'anachronism'), JSON.stringify(r));

  ok('不误伤：「清明」不命中清朝', figure.dynastyMarkers('清明时节').length === 0,
    JSON.stringify(figure.dynastyMarkers('清明时节')));
  ok('不误伤：「元年」不命中元朝', figure.dynastyMarkers('元年春正月').length === 0,
    JSON.stringify(figure.dynastyMarkers('元年春正月')));

  /* ============ ② 身份体检：生卒与名分 ============ */
  group('身份体检 · 生卒矛盾与名分不符');

  r = figure.auditFigure({ name: '李甲', year: 548, born: 600, role: '刺史' });
  ok('生于 600 年者不该出现在 548 年',
    r.some(x => x.field === 'born' && x.level === 'S0'), JSON.stringify(r));

  r = figure.auditFigure({ name: '李乙', year: 548, died: 500, role: '刺史' });
  ok('卒于 500 年者不该在 548 年行动',
    r.some(x => x.field === 'died' && x.level === 'S0'), JSON.stringify(r));

  r = figure.auditFigure({
    name: '萧纪', year: 548, identityModule: 'noble', role: '南北朝时期梁朝皇帝',
  });
  ok('548 年的萧纪写「皇帝」被判名分不符（552 年方称帝）',
    r.some(x => x.field === 'identity' && /尚未称帝/.test(x.text)), JSON.stringify(r));

  r = figure.auditFigure({ name: '萧纪', year: 554, role: '益州刺史' });
  ok('554 年的萧纪已身故，被判「已故」',
    r.some(x => x.field === 'alive'), JSON.stringify(r));

  r = figure.auditFigure({ name: '虚构甲', year: 548, role: '梁朝刺史' });
  ok('无档案的虚构人物只做通用体检，不硬套',
    !r.some(x => x.field === 'identity'), JSON.stringify(r));

  /* ============ ③ 跨年推进：不只主角 ============ */
  group('长线推进 · 所有真实人物（不只主角）');

  const S = {
    clock: { gregorianYear: 548, month: 1, day: 1 },
    protagonist: { name: '萧纪', age: 41, role: '益州刺史', seat: '成都', source: 'historical', born: 508, died: 553 },
    npcs: [
      { name: '萧绎', source: 'historical', born: 508, died: 555, age: 41, role: '湘东王' },
      { name: '侯景', source: 'historical', born: 503, died: 552, age: 46, role: '大将军' },
      { name: '路人甲', source: 'fictional', age: 30, role: '村民' },
    ],
    location: { full: '成都', polity: '梁' },
  };

  let ch = engine.advanceAllFigures(S, 548, 552);
  ok('548→552 主角身份随轨迹推进（称帝）',
    ch.some(c => c.name === '萧纪' && /即皇帝位/.test(c.text)), JSON.stringify(ch.slice(0, 4)));
  ok('主角身份模块与档案冲突时留痕待确认（不静默改玩家设定）',
    S.identityIssue && S.identityIssue.to === 'emperor', JSON.stringify(S.identityIssue));

  ch = engine.advanceAllFigures(S, 552, 554);
  ok('552→554 主角按卒年标记已故',
    S.protagonist.status === '已故' && ch.some(c => c.kind === 'death'), JSON.stringify(ch));

  const S2 = {
    clock: { gregorianYear: 548, month: 1, day: 1 },
    protagonist: { name: '张三', age: 30, source: 'fictional' },
    npcs: [
      { name: '侯景', source: 'historical', born: 503, died: 552, age: 46 },
      { name: '无名氏', source: 'fictional', age: 20 },
    ],
    location: { full: '建康', polity: '梁' },
  };
  engine.advanceAllFigures(S2, 548, 553);
  ok('无本地档案但有卒年的历史 NPC，跨卒年后标已故',
    S2.npcs[0].status === '已故', JSON.stringify(S2.npcs[0]));
  ok('无本地档案的历史 NPC 年龄随年走（503 生 → 553 年 51 岁）',
    S2.npcs[0].age === 51, String(S2.npcs[0].age));
  ok('虚构 NPC 不被当成真人推进（无卒年标记）',
    !S2.npcs[1].status, JSON.stringify(S2.npcs[1]));

  /* ============ ④ 全名籍体检 ============ */
  group('全名籍体检 auditAll');

  const S3 = {
    clock: { gregorianYear: 548, month: 1, day: 1 },
    identityModule: 'noble',
    protagonist: { name: '萧纪', role: '元太守', seat: '成都', source: 'historical', born: 508, died: 553 },
    npcs: [
      { name: '萧绎', source: 'historical', role: '湘东王', born: 508, died: 555 },
      { name: '路人乙', source: 'fictional', role: '唐朝商人' },
    ],
    location: { full: '成都', polity: '梁' },
  };
  const a = figure.auditAll(S3);
  ok('查出主角的「元太守」时代错置',
    (a.byName['萧纪'] || []).some(x => x.field === 'anachronism'), JSON.stringify(a.byName['萧纪']));
  ok('虚构人物不在体检范围内（不硬套史实）',
    !a.byName['路人乙'], Object.keys(a.byName).join(','));
  ok('体检结果带年份与受检人数',
    a.year === 548 && a.count === 2, `year=${a.year} count=${a.count}`);

  /* ============ ⑤ 端到端：真实存档跨年 ============ */
  group('端到端 · 真实存档跨年（548 → 552 → 554）');

  const s = await engine.createCustomSave({
    ruleset: 'history-sim-v4', id: 'xjlong', title: '萧纪长线',
    era: { yearLabel: '太清二年', gregorianYear: 548, polity: '梁', month: 10, day: 20 },
    identityModule: 'noble',
    protagonist: { name: '萧纪', age: 41, gender: '男', role: '益州刺史' },
    location: { full: '成都', polity: '梁', controller: '梁' },
    mode: 'real',
  });
  const id = s.meta.id;
  const baseTurn = s.turn || 0;

  // 跨 4 年：每个「月」按 30 天，4 年 = 4*12*30 = 1440 天
  const r1 = await engine.applyDraft({
    saveId: id, draft: { baseTurn, scene: '（长线推进测试）' }, advanceDays: 1440,
  });
  const st1 = r1 && r1.clock ? r1 : await engine.loadState(id);
  ok('跨 4 年后时钟到了 552 年', st1.clock.gregorianYear === 552, String(st1.clock.gregorianYear));
  ok('552 年主角身份已按档案推进（称帝，而非仍写益州刺史）',
    /皇帝|即位|天正/.test(String(st1.protagonist.role || '')), String(st1.protagonist.role));
  ok('身份变更写入待确认（不擅自改玩家设定）',
    st1.identityIssue && st1.identityIssue.at === 552, JSON.stringify(st1.identityIssue));
  ok('跨年变化写入 figureLog 可追溯',
    (st1.figureLog || []).some(c => /即皇帝位/.test(c.text)), JSON.stringify((st1.figureLog || []).slice(-3)));
  ok('已发生的史实被结算（台城陷落 / 武帝饿殁）',
    (st1.settledEvents || []).includes('hj-8') && (st1.settledEvents || []).includes('hj-9'),
    JSON.stringify(st1.settledEvents));

  const st1b = await engine.loadState(id);
  const r2 = await engine.applyDraft({
    saveId: id, draft: { baseTurn: st1b.turn, scene: '（继续推进）' }, advanceDays: 720,
  });
  const st2 = r2 && r2.clock ? r2 : await engine.loadState(id);
  ok('再跨 2 年后时钟到了 554 年', st2.clock.gregorianYear === 554, String(st2.clock.gregorianYear));
  ok('主角已按卒年（553）标记身故',
    st2.protagonist.status === '已故', JSON.stringify({ status: st2.protagonist.status, age: st2.protagonist.age }));
  ok('主角身故写入 protagonistDead，后续叙事据此展开',
    st2.protagonistDead && st2.protagonistDead.year === 554, JSON.stringify(st2.protagonistDead));
  ok('每轮名籍体检有留痕（figureIssues 字段存在）',
    Array.isArray(st2.figureIssues), JSON.stringify(st2.figureIssues).slice(0, 100));
  ok('身故后体检应报出「已故」问题（不得再出场）',
    (st2.figureIssues || []).some(x => x.field === 'alive' || x.field === 'died'),
    JSON.stringify(st2.figureIssues).slice(0, 200));

  /* ============ ⑥ API 层：体检接口可用 ============ */
  group('接口可用性（不是「纯文字」）');

  const audit = await engine.auditFigures(id);
  ok('auditFigures 返回体检结果', audit && Array.isArray(audit.issues), JSON.stringify(audit).slice(0, 120));
  ok('体检覆盖年份与受检人', audit.year === 554 && audit.count >= 1, `year=${audit.year} count=${audit.count}`);

  console.log(`\n———— 合计：${pass} 通过 / ${fail} 失败 ————`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自测崩溃：', e); process.exit(1); });
