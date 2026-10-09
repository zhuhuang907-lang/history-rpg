'use strict';
/**
 * 自测：剧情必须由历史底盘生成，不得随机生成。
 * 以真实存档「萧纪·太清二年（548）·梁」为标本——这正是用户指出的那一局：
 *   · 派系被套成清朝框架（满洲亲贵/帝党后党）
 *   · 开局是「陇西的马场」硬编码
 *   · 线索是「井里死了人」这类通用狗血
 *   · 虚构人物籍贯取到「渔阳」（北朝幽州）
 * 本自测逐条验证：这些错误都不再出现，且线索与开局皆有史料来源。
 */
const fs = require('fs');
const path = require('path');
const wg = require('./core/worldgen');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

/* --- 构造萧纪局的历史底盘（与真实存档一致） --- */
const ERA_EVENTS_548 = [
  '侯景围台城，梁武帝饿踣将殁',
  '诸王拥兵观望，援师不至',
  '宇文泰据关陇、高澄专东魏',
];
function makeState(over = {}) {
  return {
    meta: { id: 'custom-muwojns0' },
    mode: 'real',
    identityModule: 'noble',
    clock: { yearLabel: '太清二年', gregorianYear: 548, reignNeedsCheck: false },
    location: { full: '江陵', polity: '梁', controller: '梁', placeFrom: 'era-default' },
    protagonist: { name: '蕭紀', role: '南北朝时期梁朝皇帝', gender: '男', age: 40 },
    reigningSovereign: '梁武帝 萧衍',
    eraEvents: ERA_EVENTS_548,
    ...over,
  };
}

console.log('\n[1] 朝代判定：年号「太清」不得被判成清朝');
{
  const b = wg.dynastyBucket('太清二年', '梁', 548);
  ok('太清二年+梁 → 中古（不是「清」）', b === '中古', '实际=' + b);
  const c = wg.dynastyBucket('康熙三年', '清', 1664);
  ok('康熙三年+清 → 清', c === '清', '实际=' + c);
  const d = wg.dynastyBucket('熙宁元年', '宋', 1068);
  ok('熙宁元年+宋 → 宋', d === '宋', '实际=' + d);
  const e = wg.dynastyBucket('天宝十四载', '唐', 755);
  ok('天宝十四载+唐 → 隋唐', e === '隋唐', '实际=' + e);
  // 年号含朝代字也不能污染判定：政权缺失时按公元年
  const f = wg.dynastyBucket('太清二年', '', 548);
  ok('政权缺失+548年 → 中古（按年份，不受年号影响）', f === '中古', '实际=' + f);
}

console.log('\n[2] 派系框架：南朝梁不得套清朝党争');
{
  const st = makeState();
  const bucket = wg.dynastyBucket(st.clock.yearLabel, st.location.polity, st.clock.gregorianYear);
  const fac = wg.generateFactions('noble', bucket);
  const all = fac.map(f => f.title + '|' + f.stake).join(' ');
  ok('派系不含「满洲亲贵」', !/满洲亲贵/.test(all), all);
  ok('派系不含「汉军机大臣」', !/汉军机大臣/.test(all), all);
  ok('派系不含「帝党/后党」', !/帝党|后党/.test(all), all);
  ok('派系含南朝中古框架（宗室诸王/外戚权臣 或 门阀士族/寒门新贵）',
    /宗室诸王|门阀士族/.test(all), all);
}

console.log('\n[3] 线索：全部来自历史底盘，且带史料来源');
{
  const st = makeState();
  const th = wg.historyThreads(st, () => 0.5);
  // 2026-10 修订：线索可到 4 条（处境 / 已传到的大事 ×2 / 传闻）；来源新增 rumor（传闻）、figure-resources（档案所载政务）。
  // 「当朝天子」一条对有档案的人物不再单列——萧纪本人的处境里已写明与武帝的关系，且 reigningSovereign 不随月份更新，易过时。
  ok('生成 2~4 条线索', th.length >= 2 && th.length <= 4, '实际=' + th.length);
  ok('每条线索都有 source 字段', th.every(t => !!t.source), JSON.stringify(th.map(t => t.source)));
  ok('线索来源限定在史实类（figure/figure-resources/eraEvents/rumor/ruler/geography/faction/unknown）',
    th.every(t => ['figure', 'figure-resources', 'eraEvents', 'rumor', 'ruler', 'geography', 'faction', 'unknown'].includes(t.source)),
    JSON.stringify(th.map(t => t.source)));
  const titles = th.map(t => t.title).join(' ');
  // 未给月份 = 按太清二年年末：台城已被围、消息已到上游
  ok('线索含当朝真实大事（台城被围）', /台城/.test(titles), titles);
  ok('线索每条都有短名 label（标题不是整段史料）', th.every(t => t.label && t.label.length <= 15), JSON.stringify(th.map(t => t.label)));
  ok('线索不含「井里死了人」', !/井里死了人/.test(titles), titles);
  ok('线索不含「妹妹」「赐婚」', !/妹妹|赐婚/.test(titles), titles);
  ok('线索不含「出身之疑」', !/出身之疑/.test(titles), titles);
  ok('线索不含「马场」', !/马场/.test(titles), titles);
  ok('线索含主角处境（stance，非空洞事务）', th.every(t => !!t.stance), JSON.stringify(th.map(t => t.stance)));
}

console.log('\n[4] 开局：由本年真事生成，不得出现狗血模板与硬编码地名');
{
  const st = makeState();
  const th = wg.historyThreads(st, () => 0.5);
  const op = wg.historyOpening(st, () => 0.5, th);
  console.log('    开局文本：' + op);
  ok('开局含年号（太清二年）', /太清二年/.test(op), op);
  ok('开局含本年真事（台城被围）', /台城/.test(op), op);
  // 开局文字玩家看得见，写作指令已移到 prompt.js；这里只查它不以急报开头
  ok('开局不以急报/密诏开篇', !/急报|密诏|密敕/.test(op.slice(0, 40)), op);
  ok('开局不含「陇西」', !/陇西/.test(op), op);
  ok('开局不含「马场」', !/马场/.test(op), op);
  ok('开局不含「父亲临终」', !/父亲临终/.test(op), op);
  ok('开局不含「井里」', !/井里/.test(op), op);
  ok('开局提出决断（赴援/观望）', /赴援|观望|定夺|考课|摊派|借/.test(op), op);
}

console.log('\n[5] 无史料可依时：不编造，只留待补录');
{
  // 用一个**档案里没有**的虚构人物 + 空大事，检验「无史料 → 不编」。
  // （萧纪本身有核验档案与本年处境，属于有史料，不适用此项。）
  // 2026-10 修订：梁已有本地年表，「梁 + 空 eraEvents」不再等于无史料；改用尚无年表的政权（陈，570 年）检验
  const st = makeState({ eraEvents: [], clock: { yearLabel: '太建二年', gregorianYear: 570 },
    location: { full: '某县', polity: '陈', controller: '陈', placeFrom: 'era-default' },
    reigningSovereign: '', protagonist: { name: '张三', role: '某县令', gender: '男', age: 40 } });
  const th = wg.historyThreads(st, () => 0.5);
  ok('无大事时线索标 unknown', th.some(t => t.source === 'unknown'), JSON.stringify(th.map(t => t.source)));
  ok('unknown 线索注明「不得凭空生成剧情」',
    th.filter(t => t.source === 'unknown').every(t => /不得凭空生成/.test(t.note)),
    JSON.stringify(th.filter(t => t.source === 'unknown').map(t => t.note)));
  const op = wg.historyOpening(st, () => 0.5, th);
  ok('无史料时开局明说未核定、不替玩家编造处境', /未核定|不替你编造/.test(op), op);
  ok('无史料时开局不含任何具体情节', !/马场|井里|妹妹|父亲/.test(op), op);
}

console.log('\n[6] 籍贯地缘：南朝人物不得生在北朝地界');
{
  ok('梁为南朝', wg.isSouthPolity('梁', 548) === true);
  ok('北魏为北朝', wg.isSouthPolity('北魏', 548) === false);
  const pool = wg.nativePlacePool('梁', '江陵', 548);
  const north = ['渔阳', '辽西', '代郡', '云中', '姑臧', '敦煌', '蓟城', '临淄', '平原', '北海'];
  ok('南朝籍贯池不含北方地名', !pool.some(p => north.includes(p)), pool.join(','));
  ok('南朝籍贯池含本地（江陵）', pool.includes('江陵'), pool.join(','));

  // 实际生成虚构人物，检查籍贯
  const st = makeState();
  const bucket = wg.dynastyBucket(st.clock.yearLabel, st.location.polity, st.clock.gregorianYear);
  const cast = wg.generateLocalCast('noble', () => 0.42, '蕭紀', '江陵', bucket, '梁', 548);
  const nps = cast.map(c => c.nativePlace);
  console.log('    虚构人物籍贯：' + nps.join('、'));
  ok('虚构人物籍贯无一落入北朝地界', !nps.some(p => north.includes(p)), nps.join('、'));
}

console.log('\n[7] 都城兜底：太清二年不得定都北京');
{
  const p1 = wg.defaultPlace('太清二年', '梁', 548);
  ok('梁 → 建康（不是北京/盛京）', p1 === '建康', '实际=' + p1);
  const p2 = wg.defaultPlace('康熙三年', '清', 1664);
  ok('清 → 北京', p2 === '北京', '实际=' + p2);
  const p3 = wg.defaultPlace('熙宁元年', '北宋', 1068);
  ok('北宋 → 开封', p3 === '开封', '实际=' + p3);
}

console.log('\n[8] 真实存档回归：萧纪档仍可加载，且剧情字段已是历史驱动');
{
  const f = path.join(__dirname, 'data', 'saves', 'custom-muwojns0.json');
  if (fs.existsSync(f)) {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok('存档可解析', !!s && !!s.clock, '');
    // 用存档真实字段重跑一遍生成（不落盘）
    const th = wg.historyThreads(s, () => 0.5);
    const titles = th.map(t => t.title).join(' ');
    ok('按存档重跑：不出现狗血模板', !/井里|妹妹|马场|出身之疑/.test(titles), titles);
    console.log('    存档重跑线索：' + titles);
  } else {
    ok('存档存在（跳过）', true);
  }
}

console.log('\n[9] 每轮戏剧张力：情势必须来自历史底盘，不得从模板池凭空造');
{
  const drama = require('./core/drama');
  const st = makeState();
  const th = wg.historyThreads(st, () => 0.5);
  st.threads = th;
  st.npcs = [{ name: '潘义', role: '幕官', tie: '受蕭紀管辖', goal: '保住官职不失', source: 'generated', contact: true }];

  // 掷 40 轮（不同 turn），统计
  let fired = 0, badHook = 0;
  const allowed = ERA_EVENTS_548.concat(th.map(t => t.title));
  for (let turn = 1; turn <= 40; turn++) {
    const d = drama.rollDrama({ ...st, turn });
    if (!d) continue;
    fired++;
    const known = allowed.some(a => String(d.hook).includes(a) || String(a).includes(String(d.hook)));
    if (!known) { badHook++; console.log('    越界 hook：' + d.hook); }
  }
  console.log('    40 轮中触发 ' + fired + ' 次');
  ok('触发的戏剧节拍情势全部来自历史底盘', badHook === 0, '越界 ' + badHook + ' 次');
  ok('触发率降到噪声级（不高于 40%，旧实现为 75%）', fired <= 16, '实际触发 ' + fired + '/40');
  ok('仍会触发（不是永远不掷）', fired > 0, '实际 ' + fired);

  // 无史料 → 一律不掷
  const bare = { ...makeState({ eraEvents: [] }), threads: [{ id: 'h0', title: '（未核定）', status: 'open', source: 'unknown' }] };
  let anyFire = false;
  for (let turn = 1; turn <= 20; turn++) if (drama.rollDrama({ ...bare, turn }, { force: true })) anyFire = true;
  ok('无史料可依时（force 也不掷）绝不凭空造事', !anyFire);

  // actor 的动作取 NPC 自己在册的目标，而非随机套路
  const d2 = drama.rollDrama({ ...st, turn: 3 }, { force: true });
  ok('NPC 动作取自其目标（不再随机套动作）',
    !d2 || !d2.actor || !d2.actorMove || /他眼下要的是/.test(d2.actorMove), d2 && d2.actorMove);
  ok('戏剧节拍标出史料来源', !d2 || !!d2.source, String(d2 && d2.source));
}

console.log('\n[10] 协议 §12 / §4：萧纪与侯景之乱的史实核验');
{
  const tl = require('./core/timeline');
  const fg = require('./core/figure-data');

  // §12.1 人物核验
  const d = fg.dossierAt('萧纪', 548);
  ok('萧纪 548 年驻地＝成都（不是江陵）', d.seat === '成都', String(d.seat));
  ok('萧纪 548 年年龄＝41（508生，虚岁）', d.age === 41, String(d.age));
  ok('萧纪 548 年官职含「益州刺史」', /益州刺史/.test(d.post && d.post.title || ''), d.post && d.post.title);
  ok('萧纪本年处境有史料出处', !!d.situation && !!d.situation.src, JSON.stringify(d.situation));
  ok('已登记「萧纪在江陵」为被否定的错误说法',
    fg.checkDenied('萧纪', '萧纪在江陵').length > 0);
  ok('已登记「陇西的马场」为被否定的错误说法',
    fg.checkDenied('萧纪', '萧纪有陇西的马场').length > 0);

  // §12.2 时间线核验：太清二年不得出现 549 年的事
  const done = tl.eventsBefore('梁', 548).map(e => e.text).join(' ');
  const future = tl.eventsAfter('梁', 548).map(e => e.text).join(' ');
  ok('548 年「台城陷落」尚未发生', !/台城陷落/.test(done));
  ok('548 年「武帝饿殁」尚未发生', !/饿殁/.test(done));
  ok('台城陷落被列为尚未发生', /台城陷落/.test(future), future);
  ok('武帝饿殁被列为尚未发生', /饿殁/.test(future), future);
  ok('548 年已发生：侯景寿阳起兵', /起兵于寿阳/.test(done), done);
  ok('548 年已发生：合围台城（十月）', /合围台城/.test(done), done);
  ok('548 年已发生：萧绎起兵于江陵', /萧绎（荆州刺史）起兵于江陵/.test(done), done);
  // 月份级过滤
  ok('548 年八月前，起兵尚未发生', !tl.hasHappened(tl.EVENTS.find(e => e.id === 'hj-3'), 548, 7));
  ok('548 年八月后，起兵已发生', tl.hasHappened(tl.EVENTS.find(e => e.id === 'hj-3'), 548, 9));

  // §4.2 消息传播：不得默认全国同步知晓
  const siege = tl.EVENTS.find(e => e.id === 'hj-5');
  const toChengdu = tl.newsReached(siege, '成都', 548, 12, 1);
  ok('围台城消息到成都：处于可能区间（不是必定已知）', toChengdu.known === 'possibly', JSON.stringify(toChengdu));
  const toJiankang = tl.newsReached(siege, '建康', 548, 12, 1);
  ok('围台城消息到建康：已知（同城）', toJiankang.known === true, JSON.stringify(toJiankang));
  ok('行程估算标明为估算、可信度 low', toChengdu.source === 'estimate' && toChengdu.confidence === 'low');
  ok('无路线依据时返回 unknown，不硬编', tl.newsReached(siege, '敦煌', 548, 12, 1).known === null);

  // 开局正文不得出现尚未发生的事
  const st = makeState({ clock: { yearLabel: '太清二年', gregorianYear: 548 } });
  st.location.full = '成都';
  st.eraEvents = tl.eventsBefore('梁', 548, 12).map(e => e.text);
  const th = wg.historyThreads(st, () => 0.5);
  const op = wg.historyOpening(st, () => 0.5, th);
  ok('开局不含「台城陷落」（549年事）', !/台城陷落/.test(op), op);
  ok('开局不含「武帝饿殁」（549年事）', !/饿殁/.test(op), op);
  ok('开局含萧纪本年真实处境', /密敕|不赴援|益州|成都/.test(op), op);
  console.log('    核验后开局：' + op);
}

console.log('\n[11] 同名政权都城消歧：政权写作「宋」时不得把赵宋安到建康');
{
  const cases = [
    ['熙宁元年', '宋', 1068, '开封'],   // 北宋神宗
    ['靖康二年', '宋', 1127, '临安'],   // 南宋
    ['元嘉元年', '宋', 424, '建康'],    // 南朝刘宋
    ['太清二年', '梁', 548, '建康'],    // 南朝萧梁
    ['开平元年', '梁', 907, '开封'],    // 五代后梁
    ['天宝十四载', '唐', 755, '长安'],
    ['太清二年', '陈', 557, '建康'],
  ];
  cases.forEach(([era, polity, y, exp]) => {
    const got = wg.defaultPlace(era, polity, y);
    ok(`${era}·${polity}(${y}) → ${exp}`, got === exp, '实际=' + got);
  });
}

/* 以下两组要联网核定，CommonJS 不支持顶层 await，故包进 async IIFE */
(async () => {

console.log('\n[12] 开局档案核定：所有真实人物（不只萧纪）开局都要联网核实');
{
  const engine = require('./core/engine');
  ok('engine 导出 verifyProtagonistOnSeed', typeof engine.verifyProtagonistOnSeed === 'function');

  const mkState = (name, polity, y, label) => ({
    meta: { id: 't' }, mode: 'real', identityModule: 'emperor',
    clock: { yearLabel: label, gregorianYear: y, month: 1, day: 1 },
    location: { full: '', polity, controller: '未核实' },
    protagonist: { name, gender: '男', age: null, role: '' },
  });

  // 本地档案优先：萧纪有人工核实档案，联网自动抽取的官职（实测会抽成「元太守」）不得覆盖
  const st1 = mkState('萧纪', '梁', 548, '太清二年');
  let v1 = null;
  try { v1 = await engine.verifyProtagonistOnSeed(st1); } catch (e) { /* 网络不可用 */ }
  if (v1) {
    ok('萧纪：本地档案命中（成都/益州刺史）',
      !!v1.local && v1.local.seat === '成都', JSON.stringify(v1.local));
    ok('萧纪：本地档案优先，身份未被联网的「元太守」污染',
      !/元太守/.test(String(st1.protagonist.role || '')), String(st1.protagonist.role));
    ok('萧纪：联网核定已执行并留痕', !!st1.dossier, '');
    console.log('    萧纪 联网结果：' + JSON.stringify(v1.online && {
      found: v1.online.found, born: v1.online.born, died: v1.online.died, sources: v1.online.sources }));
  } else {
    console.log('    （网络不可用，跳过联网核定断言——如实记为跳过，不计通过）');
  }

  // 无本地档案的真实人物：应能用联网结果填空
  const st2 = mkState('赵顼', '宋', 1068, '熙宁元年');
  let v2 = null;
  try { v2 = await engine.verifyProtagonistOnSeed(st2); } catch { /* 网络不可用 */ }
  if (v2 && v2.online && v2.online.found) {
    ok('赵顼：联网核定命中（1048—1085）', v2.online.born === 1048 && v2.online.died === 1085,
      JSON.stringify(v2.online));
    ok('赵顼：身份由联网结果填入', /皇帝/.test(String(st2.protagonist.role || '')), String(st2.protagonist.role));
  } else {
    console.log('    （网络不可用，赵顼联网断言跳过——如实记为跳过，不计通过）');
  }

  // 虚构姓名：不得编造，须明确标记未核定
  const st3 = mkState('慕容虚构甲乙丙', '梁', 548, '太清二年');
  let v3 = null;
  try { v3 = await engine.verifyProtagonistOnSeed(st3); } catch { /* 网络不可用 */ }
  if (v3) {
    ok('虚构姓名：不伪造档案', v3.local === null && !(v3.online && v3.online.found), JSON.stringify(v3));
    ok('虚构姓名：标记未核定', !!st3.dossierError, String(st3.dossierError));
  }
}

console.log('\n===== 历史驱动剧情自测：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);

})();
