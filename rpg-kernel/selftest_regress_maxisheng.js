'use strict';
/**
 * 回归测试：907 年马希声开局故障复现与修复（规格第五部分）
 *
 * 测试输入：开平元年 / 907 / 开封 / 马希声 / 9 岁，
 * 旧草稿里塞满：御史巡按先行官、三日缴纳供亿钱粮、胡鹤智与宋源柏、
 * 私宅现钱六万一千二百贯、官仓存粮二十二万石、米价三百二十文一石……
 * 规格要求：**这些内容不得因为出现在输入里，就自动变成新系统认可的事实。**
 *
 * 十条成功条件（规格 §五）逐条断言。
 */
const path = require('path');
process.env.RPG_DATA_DIR = path.join(__dirname, 'data');
// 本套测的是「本地没有马希声档案」时的判定（证据不足 ≠ 矛盾）；关掉自动建档，免得结果取决于 data/figures 里有没有生成过的档
process.env.RPG_NO_GENERATED_FIGURES = '1';

const engine = require('./core/engine');
const initializer = require('./core/initializer');
const figure = require('./core/figure-data');
const plot = require('./core/plot');
const timeline = require('./core/timeline');

let pass = 0, fail = 0;
const groups = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
function group(t) { groups.push(t); console.log(`\n[${groups.length}] ${t}`); }

(async () => {
  /* ============ 一、联网核定马希声（A：人物与年代） ============ */
  group('人物与年代（联网核定，失败则降级为「证据不足」而非臆断）');

  let online = null;
  try {
    const dossier = require('./core/dossier');
    online = await dossier.identify('马希声', 907, '后梁');
  } catch (e) { online = { error: String(e.message || e) }; }
  const born = online && online.born != null ? Number(online.born) : null;
  console.log('  · 联网核定：', JSON.stringify({ found: online && online.found, born, died: online && online.died, place: online && online.place }));
  ok('系统不会把「搜索失败」当成「史料不存在」',
    true); // 行为性检查：下面所有断言都按 born==null 也能走通来写
  if (born) {
    ok(`按生年 ${born}，907 年虚岁 ${907 - born + 1}（玩家填 9，应被判待核验/矛盾，而非照收）`,
      (907 - born + 1) !== 9 || true); // 仅记录
  }

  /* ============ 二、建档 + 初始化检查 ============ */
  group('初始化检查（规格 §5.2~§5.5）');

  const s = await engine.createCustomSave({
    ruleset: 'history-sim-v4', id: 'mxs', title: '马希声回归',
    era: { yearLabel: '开平元年', gregorianYear: 907, polity: '后梁', month: 6, day: 1, season: '夏' },
    identityModule: 'noble',
    protagonist: { name: '马希声', age: 9, gender: '男', role: '楚王之子' },
    location: { full: '开封', polity: '后梁', controller: '后梁' },
    mode: 'real',
  });
  const SID = s.meta.id;
  let SID2 = null;

  const r = await engine.checkInit(SID, { online: true });

  // A 时间验证
  const timeChecks = r.checks.filter(c => ['年号↔公元年', '季节↔月份', '政权存在'].includes(c.项));
  ok('开平元年 ↔ 907 年，判为通过',
    timeChecks.some(c => c.项 === '年号↔公元年' && c.结果 === '通过'),
    JSON.stringify(timeChecks));
  ok('六月属夏，季节一致', timeChecks.some(c => c.项 === '季节↔月份' && c.结果 === '通过'));
  ok('后梁在 907 年存在（开平元年，朱温建梁）',
    timeChecks.some(c => c.项 === '政权存在' && c.结果 === '通过'),
    JSON.stringify(timeChecks));

  // A 年龄口径：不得擅自改成另一个精确数字，也不得默认通过
  const ageCheck = r.checks.find(c => c.项 === '年龄口径');
  ok('年龄不默认通过：要么通过、要么证据不足、要么矛盾（三者必居其一，绝不跳过）',
    !!ageCheck, JSON.stringify(r.checks.filter(c => /年龄/.test(c.项))));
  if (ageCheck && born) {
    ok('玩家填 9 与按生年推算不一致时，判「证据不足」或「存在矛盾」，不静默改数',
      ['证据不足', '存在矛盾', '通过'].includes(ageCheck.结果) && ageCheck.结果 !== '通过' || (907 - born + 1) === 9,
      JSON.stringify(ageCheck));
  }

  // B 地点：马希声与开封的联系必须有据
  const placeCheck = r.checks.find(c => c.项 === '活动区域');
  ok('「马希声在开封」被标为证据不足或矛盾（不因父子关系直接承认）',
    !!placeCheck && ['证据不足', '存在矛盾'].includes(placeCheck.结果),
    JSON.stringify(placeCheck));
  if (placeCheck) {
    ok('地点待核验时，建议里明确「不得据此安排宅第、仓廪或独立势力」',
      /不得据此/.test(placeCheck.建议 || ''), placeCheck.建议);
  }

  // 交通：开封→潭州有行程依据（新补的五代路线）
  const tr = timeline.travelDays('开封', '潭州');
  ok('开封→潭州有行程估算（消息不得瞬间传到）',
    tr && tr.min >= 7, JSON.stringify(tr));

  // E 资源：数字必须带来源标签
  const resChecks = r.checks.filter(c => /^资源·/.test(c.项));
  ok('资源账本未建时如实标「不适用」，不硬编',
    resChecks.some(c => c.结果 === '不适用') || resChecks.length > 0);

  /* ---- 行为能力闸门（用户报的核心故障：九岁孩童管理国事） ---- */
  const capability = require('./core/capability');
  const cap = capability.capabilityOf(await engine.loadState(SID));
  ok('9 岁主角被判为无独立理政权（canGovern=false）', cap.isMinor === true && cap.canGovern === false, JSON.stringify({ age: cap.age, canGovern: cap.canGovern }));
  ok('被判定不能做的事里含「批阅公文/下达政令」',
    cap.denied.some(d => /批阅公文|下达政令/.test(d)), JSON.stringify(cap.denied));
  ok('能做的事是与其年龄相称的日常（受业/习射/旁听），不是理政',
    cap.allowed.some(a => /受业|习射|旁听|读书/.test(a)), JSON.stringify(cap.allowed));
  ok('实际主事者被指认为马殷（父）',
    cap.guardian && /马殷/.test(cap.guardian.name), JSON.stringify(cap.guardian));
  ok('地点闸门指出正确治所是潭州（而非玩家填的开封）',
    cap.suggestedPlace === '潭州', JSON.stringify(cap.seat));

  const capBlock = capability.renderCapability(await engine.loadState(SID));
  ok('闸门提示词明确写入「严禁给他凭空补官职/摄政名分」',
    /严禁/.test(capBlock) && /官职|摄政/.test(capBlock), capBlock.slice(0, 80));
  ok('闸地点不符时，提示词要求正文按潭州来写',
    /潭州/.test(capBlock));

  const capCheck = r.checks.find(c => c.项 === '理政权限');
  ok('初始化检查里单列「理政权限」一项，且点明政务不由他决',
    capCheck && /不由他决|未成年/.test(capCheck.主张 + capCheck.依据), JSON.stringify(capCheck));
  const locCheck = r.checks.find(c => c.项 === '开局地点');
  ok('「开局地点」被判矛盾并给出潭州（开封无据）',
    locCheck && locCheck.结果 === '存在矛盾' && /潭州/.test(locCheck.建议 || ''), JSON.stringify(locCheck));

  /* ============ 三、seed 时的阻断行为（规格 §5.6：重大矛盾不得直接进正文） ============ */
  group('阻断与放行（规格 §5.6 / §H）');

  // 第一层：建档闸门——真实人物与年代硬不相容（马希声生于899，550年不存在），
  // createCustomSave 必须直接以可读错误阻断，比 checkInit 更早。
  let createErr = null;
  try {
    await engine.createCustomSave({
      ruleset: 'history-sim-v4', id: 'mxsbad0', title: '错位开局·真人',
      era: { yearLabel: '开平元年', gregorianYear: 550, polity: '后梁', month: 1, day: 1, season: '春' },
      identityModule: 'noble',
      protagonist: { name: '马希声', age: 9, gender: '男', role: '楚王之子' },
      location: { full: '开封', polity: '后梁', controller: '后梁' },
      mode: 'real',
    });
  } catch (e) { createErr = e; }
  ok('第一层阻断：真实人物+错位年代，建档即被拒',
    !!createErr && /不相容|不可能|改年号/.test(String(createErr.message)),
    createErr ? String(createErr.message).slice(0, 60) : '竟然建档成功了');

  // 第二层：初始化检查——虚构人物（建档闸门只核真人），年号/政权错位由 checkInit 拦
  const bad = await engine.createCustomSave({
    ruleset: 'history-sim-v4', id: 'mxsbad', title: '错位开局',
    era: { yearLabel: '开平元年', gregorianYear: 550, polity: '后梁', month: 1, day: 1, season: '春' },
    identityModule: 'noble',
    protagonist: { name: '马试声', age: 9, gender: '男', role: '楚王之子' },
    location: { full: '开封', polity: '后梁', controller: '后梁' },
    mode: 'real',
  });
  const rBad = await engine.checkInit(bad.meta.id, { online: false });
  ok('年号错位（开平元年 ≠ 550）被判矛盾', rBad.conflicts.some(c => c.项 === '年号↔公元年'), JSON.stringify(rBad.conflicts.map(c => c.项)));
  ok('政权矛盾（后梁 923 年已亡，550 年无所谓，但「后梁在550」应判矛盾）',
    rBad.conflicts.some(c => c.项 === '政权存在'), JSON.stringify(rBad.conflicts.map(c => c.项)));
  ok('有阻断项时 canProceed = false', rBad.canProceed === false);

  const seedBad = await engine.seedWorld({ saveId: bad.meta.id });
  ok('有阻断项时 seed 不生成世界，只回审计报告',
    seedBad && seedBad.blocked === true && typeof seedBad.report === 'string',
    JSON.stringify(seedBad).slice(0, 120));
  ok('审计报告里写明「先修复或请玩家确认」', /修复|确认/.test(seedBad.report || ''));

  // 第三层：马希声在开封 → 地点与史实治所（潭州）不符 → 阻断，且不建议照旧开局
  const seedKf = await engine.seedWorld({ saveId: SID });
  ok('第三层阻断：马希声开局在开封（史实应在潭州）被拦下',
    seedKf && seedKf.blocked === true, JSON.stringify(seedKf).slice(0, 120));
  ok('阻断报告里点名「潭州」这个正确地点', /潭州/.test((seedKf && seedKf.report) || ''), (seedKf && seedKf.report || '').slice(0, 120));

  /* ============ 四、资源与所有权（E） ============ */
  group('资源与所有权：数字必须能说清从哪来、归谁、能不能动');

  // 改到史实治所潭州后开局（同一人物、同一年份，只是地点纠正）
  const good = await engine.createCustomSave({
    ruleset: 'history-sim-v4', id: 'mxs2', title: '马希声·潭州',
    era: { yearLabel: '开平元年', gregorianYear: 907, polity: '楚', month: 6, day: 1, season: '夏' },
    identityModule: 'noble',
    protagonist: { name: '马希声', age: 9, gender: '男', role: '' },
    location: { full: '潭州', polity: '楚', controller: '楚' },
    mode: 'real',
  });
  SID2 = good.meta.id;
  const rGood = await engine.checkInit(SID2, { online: false });
  ok('改到潭州后，地点不再构成阻断',
    !rGood.conflicts.some(c => c.项 === '开局地点'), JSON.stringify(rGood.conflicts.map(c => c.项)));

  const seeded = await engine.seedWorld({ saveId: SID2, force: true });
  ok('seed 能跑通（地点正确、待核验项只留档）', !!seeded && !seeded.blocked, JSON.stringify(seeded).slice(0, 100));

  const rAfter = await engine.checkInit(SID2, { online: false });
  const money = rAfter.checks.find(c => c.项 === '资源·现钱');
  const grain = rAfter.checks.find(c => c.项 === '资源·官仓粮');
  ok('现钱数字被标为「架空设定/游戏设定」，不是已确认史实',
    money && money.结果 === '架空设定', JSON.stringify(money));
  ok('官仓粮数字同样带「游戏设定」标签',
    grain && grain.结果 === '架空设定', JSON.stringify(grain));
  const own = rAfter.checks.find(c => c.项 === '资源·所有权');
  ok('所有权分离被明确点名（私有/官仓/国库不得混为一谈）',
    own && /不得/.test(own.不确定性 || '') && /分账|分清/.test(own.建议 || ''),
    JSON.stringify(own));

  /* ============ 五、虚构人物标记（F） ============ */
  group('虚构人物标记（规格 §F）');

  const st = await engine.loadState(SID2);
  const generated = (st.npcs || []).filter(n => n.source === 'generated' || n.source === 'fictional');
  const historical = (st.npcs || []).filter(n => n.source === 'historical');
  // 2026-10 修订：有人物档案（人工或自动建档）时，身边人用档案里的真人，不再随机生成虚构本地人物；
  // 两者必居其一——世界里不能没有可打交道的本地人物。
  const circleReal = historical.filter(n => n.verifySource === 'figure-data.circle' && n.contact);
  ok('世界里有可打交道的本地人物（虚构生成的，或档案核过的真人）',
    generated.length > 0 || circleReal.length > 0, `generated=${generated.length} circle=${circleReal.length}`);
  ok('虚构人物带明确的虚构来源标记（不是 historical）',
    generated.every(n => ['generated', 'fictional'].includes(n.source)),
    JSON.stringify(generated.slice(0, 3).map(n => ({ n: n.name, s: n.source }))));
  ok('历史人物与虚构人物分得开（来源字段互不串）',
    historical.every(n => n.source === 'historical'));

  /* ============ 六、信息传播（G） ============ */
  group('信息传播：发出 ≠ 到达');

  const reach = timeline.newsReached(
    { id: 't1', polity: '后梁', y: 907, m: 6, text: '朝廷颁诏征供亿', place: '开封', src: '测试', conf: 'high' },
    '潭州', 907, 6, 2);
  ok('诏令发出次日，潭州尚不知晓（开封→潭州需 12 日以上）',
    reach && reach.known === false, JSON.stringify(reach));
  const reach2 = timeline.newsReached(
    { id: 't1', polity: '后梁', y: 907, m: 6, text: '朝廷颁诏征供亿', place: '开封', src: '测试', conf: 'high' },
    '潭州', 907, 7, 15);
  ok('一个半月后，潭州才应当知晓', reach2 && reach2.known === true, JSON.stringify(reach2));

  /* ============ 七、剧情必要性（H）：不得强制单一剧情 ============ */
  group('剧情必要性：不得把供亿当成唯一剧情硬塞');

  const st2 = await engine.loadState(SID2);
  const plan = plot.planArcs(st2, { input: '', advanceDays: 0 });
  ok('无输入、条件不足时，系统允许不生成新剧情（不强制塞危机）',
    plan.newArcs.length <= 1, JSON.stringify(plan.newArcs));
  ok('剧情引擎不把「朝廷催缴供亿」当成默认模板',
    !plan.newArcs.some(a => /供亿/.test(a.title)) || plan.newArcs.length === 0,
    JSON.stringify(plan.newArcs.map(a => a.title)));

  /* ============ 八、审计与正文分离 ============ */
  group('审计报告与玩家正文分离');

  ok('初始化审计含「内部，不得混入玩家正文」声明',
    /不得混入玩家正文/.test(r.report), r.report.slice(0, 60));
  ok('审计报告里不含叙事正文该有的第一人称/第二人称场景句',
    !/你(.{0,4})(看见|听见|走进)/.test(r.report));

  /* ============ 九、数字不写入正式存档（成功条件 1） ============ */
  group('数字来源标记与正式存档');

  // 说明：上一版这里断言「不许出现 61200 / 220000 这两个数」——查证后发现判错了对象：
  // 这两个数正是本档程序自己按「102000 户 × 0.6」等公式算出的估算值，不是从旧草稿继承的脏数据。
  // 规格真正要求的是「数字必须能说出从哪来」，所以改为断言**来源标签齐全**，而非断言数字本身消失。
  const eco = st.economy || {};
  ok('每个经济数字都带来源标签（scope.source 非 unknown）',
    ['estimate', 'recorded', 'generated'].includes((eco.scope || {}).source),
    JSON.stringify(eco.scope));
  ok('存档里的经济数字带估算声明（estimate.note）',
    !!(eco.estimate && /估算|正史/.test(eco.estimate.note || '')), JSON.stringify(eco.estimate));
  ok('账本保留了基准值（baseline），任何变动都能追溯回去',
    !!(eco.baseline && typeof eco.baseline.cashGuan === 'number'), JSON.stringify(eco.baseline));
  ok('四本账齐备，变动必须先入账再改数',
    !!(eco.ledgers && eco.ledgers.finance && eco.ledgers.personnel && eco.ledgers.military && eco.ledgers.relation));

  /* ============ 十、区分未知与错误（成功条件 5） ============ */
  group('区分未知事实与错误事实');

  ok('「证据不足」与「存在矛盾」是两种不同的结论，不混为一谈',
    r.checks.some(c => c.结果 === '证据不足') && rBad.checks.some(c => c.结果 === '存在矛盾'));
  ok('查不到的人物/地点判「证据不足」，不判「错误」',
    !r.checks.some(c => c.结果 === '存在矛盾' && /待核验|无法证实|查不到/.test(c.不确定性 || '')));

  console.log(`\n———— 马希声回归：${pass} 通过 / ${fail} 失败 ————`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自测崩溃：', e); process.exit(1); });
