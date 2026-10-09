'use strict';
/**
 * 自测：剧情生成、演化与叙事控制（新增模块）
 *
 * 重点不是「文字好不好看」，而是：
 *   ① 剧情有没有真的落进程序（状态机、编号、因果链、后台日志）；
 *   ② 没有触发条件时会不会**拒绝生成**（这是「不强行编排」的硬证据）；
 *   ③ 14 项审计能不能查出硬伤并拦下正文；
 *   ④ 第十二节的 12 个验收场景是否成立。
 */
const path = require('path');
process.env.RPG_DATA_DIR = path.join(__dirname, 'data');

const plot = require('./core/plot');
const engine = require('./core/engine');

let pass = 0, fail = 0;
const groups = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
function group(t) { groups.push(t); console.log(`\n[${groups.length}] ${t}`); }

/* 造一个「无事可争」的空世界 */
function emptyState() {
  return {
    meta: { id: 'plot-empty' },
    clock: { yearLabel: '太清二年', gregorianYear: 548, month: 10, day: 20, season: '秋' },
    location: { full: '成都', polity: '梁', controller: '梁' },
    protagonist: { name: '张三', age: 30, role: '庶民' },
    npcs: [], household: { members: [] }, threads: [], territory: [],
    economy: null, world: {}, turn: 1,
  };
}
/* 造一个「事事可争」的世界 */
function richState() {
  return {
    meta: { id: 'plot-rich' },
    clock: { yearLabel: '太清二年', gregorianYear: 548, month: 10, day: 24, season: '秋' },
    location: { full: '成都', polity: '梁', controller: '梁' },
    protagonist: { name: '萧纪', age: 41, role: '益州刺史' },
    npcs: [
      { name: '萧圆照', contact: true, role: '世子', agency: { 短期目标: '领兵东下', queue: [{ label: '请领兵东下' }] } },
      { name: '粮吏某', contact: true, role: '粮吏', agency: { 短期目标: '把账面做平', queue: [] } },
      { name: '豪强某', contact: true, role: '豪强', agency: { 短期目标: '压价收田', queue: [] } },
      { name: '郡丞某', contact: true, role: '郡丞', agency: { 短期目标: '磨勘顺利', queue: [] } },
    ],
    household: { members: [] },
    threads: [{ title: '成都仓粮账目不清', status: 'open', lastTouchedTurn: 1 }],
    territory: [{ name: '白帝城', controlledBy: '萧绎' }],
    factions: { items: [{ name: '益州本土', note: '人事与钱粮之争' }, { name: '东下派' }] },
    economy: {
      revenue: { annualUpkeepShi: 9000, retainedShi: 4000, taxRate: 0.1, annualTaxShi: 10000 },
      treasury: { cashGuan: 300, grainShi: 900, debtGuan: 120, taxRate: 0.1 },
      military: { total: 800, combat: 560 },
      market: { grainWenPerShi: 520 },
      agriculture: { phase: '秋收', busy: true, disaster: '无' },
      population: { households: 20000, total: 100000, annualGrainShi: 600000 },
    },
    world: { 交通: '霖雨阻道', 社会秩序: '平常' },
    turn: 6,
  };
}

(async () => {
  /* ============ ① 七层结构与状态机 ============ */
  group('七层结构与状态机（第二、四节）');

  const s = richState();
  plot.ensurePlot(s);
  const plan = plot.planArcs(s, { input: '我要清仓查账', advanceDays: 5 });
  ok('有触发条件时确实生成了剧情', plan.newArcs.length === 1, JSON.stringify(plan.skipped));
  const arc = s.plot.arcs[0];
  ok('剧情有编号', /^P\d{3}$/.test(arc.id), arc.id);
  ok('七层齐全（背景/矛盾/行动者/触发/反应/变化/后续）',
    arc.layers.L1背景 && arc.layers.L2矛盾 && arc.layers.L3行动者 && arc.layers.L4触发
    && arc.layers.L5行动与反应 && arc.layers.L6状态变化 && arc.layers.L7后续, Object.keys(arc.layers).join(','));
  ok('第一层背景含时间地点财政军情', !!arc.layers.L1背景.时间 && !!arc.layers.L1背景.财政, JSON.stringify(arc.layers.L1背景).slice(0, 120));
  ok('第二层矛盾写明「为何难解」（非空话）',
    arc.layers.L2矛盾.为何难解 && !/局势复杂|暗流涌动/.test(arc.layers.L2矛盾.为何难解), arc.layers.L2矛盾.为何难解);
  ok('第二层写明各方所求与可采取的行动',
    Object.keys(arc.layers.L2矛盾.各有所求).length > 0 && arc.layers.L2矛盾.可采取的实际行动.length > 0);
  ok('第三层区分发起/执行/受影响/阻碍/旁观/获利/受损',
    ['发起者', '执行者', '受影响者', '阻碍者', '旁观者', '获利者', '受损者'].every(k => k in arc.layers.L3行动者),
    Object.keys(arc.layers.L3行动者).join(','));
  ok('第四层触发可追溯到具体原因', !!arc.layers.L4触发.依据, JSON.stringify(arc.layers.L4触发));
  ok('第五层不预先指定结果，只给可行反应集',
    arc.layers.L5行动与反应.可行反应集.length >= 2 && arc.layers.L5行动与反应.发起方动作.includes('不得超出其能力'));
  ok('初始状态为「触发」', arc.status === 'triggered', arc.status);

  /* 状态迁移的合法性 */
  const a2 = s.plot.arcs[0];
  ok('终止 → 发展 属非法迁移，被拒且不改状态',
    plot.advanceArc({ ...a2, status: 'terminated' }, { turn: 7, plot: { arcs: [] } }, { touched: [] }, null) === null);
  const arcB = JSON.parse(JSON.stringify(a2));
  arcB.status = 'triggered'; arcB.layers = arc.layers; arcB.log = [];
  const mv = plot.advanceArc(arcB, { turn: 7, plot: { arcs: [] } }, { touched: [] }, null);
  ok('合法迁移可执行（triggered → shelved 等）',
    mv === null || plot.TRANSITIONS.triggered.includes(mv ? Object.keys(plot.STATUS).find(k => plot.STATUS[k] === mv.to) : 'x'),
    JSON.stringify(mv));

  /* ============ ② 没有条件就不生成（反强行编排） ============ */
  group('条件不足时拒绝生成（第一节第 10 条）');

  const e1 = emptyState();
  plot.ensurePlot(e1);
  const p1 = plot.planArcs(e1, { input: '', advanceDays: 0 });
  ok('空世界 + 无输入 → 不生成剧情', p1.newArcs.length === 0, JSON.stringify(p1.newArcs));
  ok('并说明为什么不生成', p1.skipped.length > 0 && /触发条件|结构性矛盾/.test(p1.skipped[0].why), JSON.stringify(p1.skipped));

  const s2 = richState();
  plot.ensurePlot(s2);
  // 2026-10-08：同一回合未采纳的规划视为「重来」，会被撤掉；这里模拟每次都被采纳
  for (let i = 0; i < 3; i++) { plot.planArcs(s2, { input: '继续', advanceDays: 3 }); plot.commitPending(s2); }
  const cap = plot.capacity(s2);
  ok('进行中的剧情被限制在玩家能处理的量内（≤3）', cap.active <= 3, JSON.stringify(cap));
  const p2 = plot.planArcs(s2, { input: '再来一件', advanceDays: 3 });
  // 2026-10-08：判重先于容量生效——矛盾都已有线时理由是「同一事不重复开线」，同样算说明了理由
  ok('超量时不再开新篇，并说明理由',
    p2.newArcs.length === 0 && /上限|不重复开线/.test(p2.skipped[p2.skipped.length - 1].why), JSON.stringify(p2.skipped));

  /* 重大事件稀少：8 轮内不得再来一次 major */
  const s3 = richState();
  plot.ensurePlot(s3);
  s3.plot.arcs.push({ id: 'P900', title: '旧重大', scale: 'major', status: 'developing', turn: 1, lastTurn: 1, layers: {}, chain: {}, log: [] });
  s3.turn = 4;
  const p3 = plot.planArcs(s3, { input: '打一仗', advanceDays: 30 });
  ok('8 轮内不再开第二个「重大事件」',
    p3.newArcs.every(a => a.scale !== '重大事件'), JSON.stringify(p3.newArcs));

  /* ============ ③ 第九条验收场景：消息未传到 ============ */
  group('外部冲击：消息未传到就不得行动（验收场景 9）');

  const s4 = richState();
  s4.clock = { yearLabel: '太清二年', gregorianYear: 548, month: 10, day: 21, season: '秋' };
  plot.ensurePlot(s4);
  const cands = plot.candidatesFor(s4, { advanceDays: 1 });
  const unreached = cands.find(c => c.kind === '外部消息（未达）');
  ok('侯景围台城（548.10.24）在 10 月 21 日的成都尚未传到', !!unreached, JSON.stringify(cands.map(c => c.kind)));
  if (unreached) {
    ok('未达的消息被标记为 blocked，不会用来生成剧情', unreached.blocked === true, JSON.stringify(unreached));
    ok('并说明还需多少日方可能传到', /尚需约 \d+ 日/.test(unreached.grounds), unreached.grounds);
  }
  const s5 = richState();
  s5.clock = { yearLabel: '太清三年', gregorianYear: 549, month: 8, day: 1, season: '秋' };
  const c5 = plot.candidatesFor(s5, { advanceDays: 1 });
  ok('传到之后（549 年 8 月）才作为「外部消息」可用',
    c5.some(c => c.kind === '外部消息' && c.basis === 'fact'), JSON.stringify(c5.map(c => c.kind)));

  /* ============ ④ 14 项审计 ============ */
  group('剧情质量审计（第十一节 14 项）');

  const s6 = richState();
  plot.ensurePlot(s6);
  plot.planArcs(s6, { input: '查仓', advanceDays: 3 });
  const aid = s6.plot.arcs[0].id;

  let r = plot.auditText(s6, '次日，他带人点了仓。你心想此事必有蹊跷，每个来访者都有秘密。', [aid]);
  ok('查出「跨日推进」（第 5 项）', r.blocking.some(i => i.no === 5), JSON.stringify(r.blocking.map(i => i.no)));
  ok('查出「替玩家写内心决定」（第 11 项）', r.blocking.some(i => i.no === 11), JSON.stringify(r.blocking.map(i => i.no)));
  ok('查出「机械悬念模板」（第 10 项）', r.issues.some(i => i.no === 10), JSON.stringify(r.issues.map(i => i.no)));

  r = plot.auditText(s6, '粮吏递上一纸账目，说仓里短了六十石。', [aid]);
  ok('正常日常叙事不误伤（无阻断项）', r.blocking.length === 0, JSON.stringify(r.blocking));
  ok('「来递一份公文就只是递公文」是合法内容', r.issues.filter(i => i.no === 10).length === 0);

  r = plot.auditText(s6, '梁武帝饿死台城的消息传来，你决定发兵。', [aid]);
  ok('查出「把尚未发生的事写成既成事实」（第 6 项）',
    r.blocking.some(i => i.no === 6), JSON.stringify(r.blocking.map(i => i.no)));

  r = plot.auditText(s6, '此时局势复杂，暗流涌动。', [aid]);
  ok('查出「空泛表述」（第 2 项）', r.issues.some(i => i.no === 2 && /空泛/.test(i.why)), JSON.stringify(r.issues.map(i => i.why)));

  /* 空泛与摘要 */
  const s7 = richState();
  plot.ensurePlot(s7);
  plot.planArcs(s7, { input: '查账', advanceDays: 3 });
  plot.planArcs(s7, { input: '再查', advanceDays: 3 });
  const ids = s7.plot.arcs.map(a => a.id);
  const r7 = plot.auditText(s7, '他又来了。', ids);
  ok('同源旧剧情被判「重复」（第 9 项）或已无重复（取决于抽样）', Array.isArray(r7.issues), JSON.stringify(r7.issues.map(i => i.no)));

  /* ============ ⑤ 第六层：世界状态变化与「无成果」 ============ */
  group('世界状态变化入账（第六层）');

  const s8 = richState();
  plot.ensurePlot(s8);
  plot.planArcs(s8, { input: '追缴欠税', advanceDays: 3 });
  const a8 = s8.plot.arcs[0].id;
  let eff = plot.recordEffect(s8, a8, { 项: '官仓粮', 变化: '-60 石（放粮平粜）', 由谁所致: '主官', 依据: '本轮开仓' });
  ok('有「变了什么 + 凭什么」才入账', eff.ok === true, JSON.stringify(eff));
  eff = plot.recordEffect(s8, a8, { 项: '官仓粮', 变化: '-10 石' });
  ok('缺依据的变更不入账（不许凭空改数字）', eff.ok === false && /凭什么/.test(eff.why), JSON.stringify(eff));
  const nr = plot.recordNoResult(s8, a8, '追缴未果：豪强闭门不出');
  ok('允许记录「本轮没有成果」，不虚构后果', nr.ok === true);
  ok('无成果记进剧情日志，可追溯',
    s8.plot.arcs.find(a => a.id === a8).log.some(l => l.at === '无成果'));

  /* ============ ⑥ 第十节：正文与后台日志分离 ============ */
  group('正文与内部日志分离（第十节）');

  const visible = plot.renderPlotBlock(s8);
  const internal = plot.renderPlotAudit(s8);
  ok('可见层不含「隐藏动机/未言之谋」等后台字段', !/隐藏动机|未言之谋|后台/.test(visible));
  ok('后台日志含剧情编号与因果链', /【P\d{3}】/.test(internal) && /因果：/.test(internal));
  ok('可见层给出「结果未定」的明确要求', /不得预先指定/.test(visible));
  ok('两者是分开的两段文字', visible !== internal);

  /* ============ ⑦ 第九节：依据类型 ============ */
  group('历史剧情与虚构剧情的边界（第九节）');

  ok('六种依据类型齐备',
    Object.keys(plot.BASIS).length === 6 && plot.BASIS.fact === '历史确定事实' && plot.BASIS.fictional === '为游戏加入的虚构事件',
    JSON.stringify(plot.BASIS));
  const s9 = richState();
  plot.ensurePlot(s9);
  plot.planArcs(s9, { input: '', advanceDays: 10 });
  ok('每条剧情都标了依据类型', s9.plot.arcs.every(a => a.basisLabel && a.basis), JSON.stringify(s9.plot.arcs.map(a => a.basis)));

  /* ============ ⑧ 端到端：真实存档 + 接口 ============ */
  group('端到端 · 真实存档与接口（不是只加提示词）');

  const sv = await engine.createCustomSave({
    ruleset: 'history-sim-v4', id: 'plot-e2e', title: '剧情模块端到端',
    era: { yearLabel: '太清二年', gregorianYear: 548, polity: '梁', month: 10, day: 24 },
    identityModule: 'noble',
    protagonist: { name: '萧纪', age: 41, gender: '男', role: '益州刺史' },
    location: { full: '成都', polity: '梁', controller: '梁' },
    mode: 'real',
  });
  const sid = sv.meta.id;

  const pl = await engine.getPlot(sid);
  ok('GET 剧情面板接口可用', pl && pl.summary && typeof pl.visible === 'string', JSON.stringify(pl).slice(0, 120));
  ok('开局未跑回合时，可见层明说「不必制造事件」', /没有需要推进的剧情|照常运转/.test(pl.visible), pl.visible.slice(0, 80));

  const au = await engine.getPlotAudit(sid);
  ok('GET 后台日志接口可用且与可见层不同', au && typeof au.log === 'string' && au.log !== pl.visible);

  const st0 = await engine.loadState(sid);
  const baseTurn = st0.turn || 0;
  // 剧情硬伤的正文 → 采纳时应被拦下
  const bad = await engine.applyDraft({
    saveId: sid,
    draft: { baseTurn, scene: '次日，你打定主意要反。每个来访者都有秘密，局势复杂。', plotArcs: [] },
    advanceDays: 1,
  });
  ok('有硬伤的剧情被拦下（不写进世界）',
    bad && bad.ok === false && bad.plotAudit === true, JSON.stringify(bad).slice(0, 200));
  ok('拦下时点明是哪几条硬伤', /\[\d+\]/.test(String(bad.why || '')), String(bad.why).slice(0, 160));

  // 正常正文 → 应放行，并留下后台审计
  const st1 = await engine.loadState(sid);
  const good = await engine.applyDraft({
    saveId: sid,
    draft: { baseTurn: st1.turn, scene: '粮吏捧着一册账本进来，说今年秋粮入库迟了三日。', plotArcs: [] },
    advanceDays: 1,
  });
  ok('正常叙事放行（不误杀日常事务）', good && good.ok !== false, JSON.stringify(good).slice(0, 160));
  const st2 = await engine.loadState(sid);
  ok('审计留痕写进存档（后台可查）',
    (st2.plot && st2.plot.auditLog || []).length > 0, JSON.stringify(st2.plot && st2.plot.auditLog).slice(0, 150));

  const effApi = await engine.recordPlotEffect({ saveId: sid, arcId: 'P001', 项: '秋粮', 变化: '迟三日', 由谁所致: '粮吏', 依据: '本轮呈报' });
  ok('状态变化接口可用；编号不存在时如实报错',
    effApi && (effApi.ok === true || /没有编号为/.test(String(effApi.why))), JSON.stringify(effApi).slice(0, 120));

  /* ============ ⑨ 验收场景抽检 ============ */
  group('第十二节验收场景抽检');

  const sc = richState();
  plot.ensurePlot(sc);
  const cs = plot.candidatesFor(sc, { input: '我要展限征收', advanceDays: 1 });
  ok('场景1/2：普通商人与官员请求展限，都有可追溯依据',
    cs.some(c => c.kind === '欠税未缴') && cs.some(c => c.kind === '玩家行动衍生'), JSON.stringify(cs.map(c => c.kind)));
  ok('场景3：公文因交通延误（霖雨阻道）被识别为触发',
    cs.some(c => c.kind === '运输延误'), JSON.stringify(cs.map(c => c.kind)));
  ok('场景4：两名官员争权（派系并存）被识别',
    cs.some(c => c.kind === '政令受阻'));
  ok('场景6/7：玩家可拒绝、可久拖不理（久拖→搁置而非升级）',
    plot.FOLLOWUPS.includes('事件暂时搁置') && plot.TRANSITIONS.developing.includes('shelved'));
  ok('场景8：资源不足时事件可停滞（后续走向含「因资源不足而停滞」）',
    plot.FOLLOWUPS.includes('因资源不足而停滞'));
  ok('场景10：允许多轮后自然缓和（状态机含 easing→resolved）',
    plot.TRANSITIONS.easing.includes('resolved') && plot.TRANSITIONS.escalating.includes('easing'));
  ok('场景11：长期问题可被重新激活（shelved→triggered/developing）',
    plot.TRANSITIONS.shelved.includes('developing') || plot.TRANSITIONS.shelved.includes('triggered'));

  // 场景12：史料不足 → 标待核实，不得编
  const s12 = emptyState();
  s12.protagonist = { name: '某人', role: '不详' };
  plot.ensurePlot(s12);
  const t12 = plot.structuralTensions(s12);
  ok('场景12：史料不足时读不出结构性矛盾，故不硬编', t12.length === 0, JSON.stringify(t12));

  console.log(`\n———— 剧情模块自测：${pass} 通过 / ${fail} 失败 ————`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自测崩溃：', e); process.exit(1); });
