'use strict';
/**
 * 梁朝末年（萧纪 548–553）内容回归测试。
 * 现有自测测的是机制（状态机、账目、年龄），全绿而剧本照样错；这一套测**内容是否符合史实**。
 * 全部离线可跑（不联网、不调模型）。
 */
const path = require('path');
process.env.RPG_DATA_DIR = process.env.RPG_DATA_DIR || path.join(__dirname, 'data');
const tl = require('./core/timeline');
const fg = require('./core/figure-data');
const plot = require('./core/plot');
const wg = require('./core/worldgen');
const lh = require('./core/liveHistory');
const drama = require('./core/drama');
const figureGen = require('./core/figureGen');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

/* 一个干净的萧纪档：按 04 史实底本手工构造，不依赖库里的历史错档 */
function makeState(y, m, d = 15, over = {}) {
  const st = {
    meta: { id: `liangmo-${y}-${m}` }, mode: 'real', identityModule: 'noble', turn: 1,
    clock: { yearLabel: '太清二年', gregorianYear: y, month: m, day: d },
    location: { full: '成都', polity: '梁', controller: '梁', placeFrom: 'figure-verified' },
    protagonist: { name: '萧纪', gender: '男', age: y - 508 + 1, role: '使持节、都督益梁等十三州诸军事、安西将军、益州刺史' },
    npcs: [], threads: [], log: [], factions: [],
    ...over,
  };
  wg.refreshEraEvents(st);
  st.threads = wg.historyThreads(st, () => 0.5);
  st.factions = wg.generateFactions('noble', '中古', st);
  return st;
}
const plan = (st, input = '') => plot.planArcs(st, { input, advanceDays: 0, touched: [] });

console.log('\n[1] 时间线：550 年后有事件，且关键四条都在');
{
  const liang = tl.EVENTS.filter(e => e.polity === '梁');
  ok('550 年后梁事件 > 0', liang.filter(e => e.y >= 550).length > 0, liang.filter(e => e.y >= 550).length);
  for (const [k, re] of [['萧纪称帝', /萧纪于成都即皇帝位/], ['萧绎即位', /萧绎于江陵即皇帝位/], ['萧纪败亡', /萧纪兵败峡口/], ['西魏取蜀', /蜀地入西魏/]]) {
    ok(`年表含「${k}」`, liang.some(e => re.test(e.text)));
  }
  ok('每条事件都有出处与可信度', liang.every(e => e.src && e.conf), liang.filter(e => !e.src || !e.conf).map(e => e.id).join(','));
  const hj8 = liang.find(e => e.id === 'hj-8');
  ok('台城陷落（三月）不再夹带「萧纲即位」（实为五月）', hj8 && !/萧纲即位/.test(hj8.text), hj8 && hj8.text);
}

console.log('\n[2] 消息传递：548 年 10 月 27 日的成都还不知道台城合围（10 月 24 日）');
{
  const k = tl.knownAt('梁', '成都', 548, 10, 27);
  ok('合围台城属于「未传到」', k.unheard.some(e => e.id === 'hj-5'), JSON.stringify(k.unheard.map(e => e.id)));
  ok('合围台城不在「已知」里', !k.known.some(e => e.id === 'hj-5'));
  const k2 = tl.knownAt('梁', '成都', 549, 2, 1);
  ok('到 549 年 2 月，合围台城已传到成都', k2.known.some(e => e.id === 'hj-5'));
}

console.log('\n[3] 剧情触发源全部已发生且消息已到；548/10 不得以台城合围生成剧情（故障 3）');
{
  const st = makeState(548, 10, 15);
  const p = plan(st);
  const titles = p.newArcs.map(a => a.title).join(' ');
  ok('没有以台城合围为题的新剧情', !/台城|朱雀桥/.test(titles), titles);
  for (const a of st.plot.arcs) {
    const es = plot.eventStatus(st, a.layers.L4触发.依据);
    ok(`剧情 ${a.id} 的触发源已发生且已传到`, es === null || es === 'ok' || es === 'rumor', `${a.layers.L4触发.依据} → ${es}`);
  }
  ok('开局线索里没有尚未发生/尚未传到的事', st.threads.every(t => { const s = plot.eventStatus(st, t.anchor || t.title, t.eventId); return s !== 'future' && s !== 'unheard'; }),
    JSON.stringify(st.threads.map(t => t.title.slice(0, 16))));
}

console.log('\n[4] 连续 5 回合不出现同题重复剧情（故障 4）');
{
  const st = makeState(549, 2, 1);
  for (let t = 1; t <= 5; t++) { st.turn = t; plan(st, t % 2 ? '召集僚佐，议论京师之事' : ''); }
  const live = st.plot.arcs.filter(a => a.status !== 'terminated');
  const titles = live.map(a => a.title);
  ok('进行中的剧情无同题', new Set(titles).size === titles.length, JSON.stringify(titles));
  const ids = live.map(a => a.layers.L2矛盾.id);
  ok('进行中的剧情无同源矛盾', new Set(ids).size === ids.length, JSON.stringify(ids));
  ok('标题是事名，不是「模板词：史料原文」', st.plot.arcs.every(a => a.title.length <= 17 && !/^.{2,8}：.{12,}/.test(a.title)), JSON.stringify(titles));
}

console.log('\n[5] 萧纪的戏：剧情与「赴援 / 据蜀」相关，而不是「粮价变动」（故障 5）');
{
  const st = makeState(549, 2, 1);
  const p = plan(st);
  const t = p.newArcs[0] ? p.newArcs[0].title : '';
  ok('549 年初的第一条剧情是「赴援台城之议」', /赴援/.test(t), t);
  ok('该剧情的矛盾取自人物档案', st.plot.arcs[0] && st.plot.arcs[0].layers.L2矛盾.依据 === 'figure.situation');
  const st2 = makeState(552, 6, 1);
  const p2 = plan(st2);
  ok('552 年称帝后的剧情是「东下争位」', p2.newArcs[0] && /东下/.test(p2.newArcs[0].title), JSON.stringify(p2.newArcs));
  const st3 = makeState(548, 3, 1);
  ok('548 年春（侯景未叛）开局线索以日常政务为主，无赴援之议', !st3.threads.some(t => /赴援/.test(t.title + t.label)), JSON.stringify(st3.threads.map(t => t.label)));
}

console.log('\n[6] 生死：553 年 7 月之后不再生成萧纪的行动');
{
  ok('553 年 7 月仍在世', fg.statusAt('萧纪', 553, 7).alive === true);
  ok('553 年 8 月已故', fg.statusAt('萧纪', 553, 8).alive === false);
  const st = makeState(553, 8, 1);
  const p = plan(st);
  ok('553/8 不开新剧情', p.newArcs.length === 0 && p.skipped.some(s => /已故/.test(s.why)), JSON.stringify(p.skipped));
  const st2 = makeState(549, 8, 1);
  st2.npcs = [{ name: '萧衍', status: '在世', died: 549, diedM: 5, source: 'historical' }];
  const iss = plot.checkText(st2, '萧衍笑道：「吾儿来了。」');
  ok('已故的武帝开口说话 → 拦下', iss.some(i => i.no === 17), JSON.stringify(iss));
}

console.log('\n[7] 地点：江陵不得被写成萧纪的治所（denied 生效）');
{
  ok('548 年治所为成都', fg.seatAt('萧纪', 548) === '成都');
  const st = makeState(548, 10, 15);
  const iss = plot.checkText(st, '萧纪在江陵的府中踱步。');
  ok('正文写「萧纪在江陵」→ 历史检查拦下', iss.some(i => i.no === 6 && /江陵/.test(i.why)), JSON.stringify(iss));
}

console.log('\n[8] 开局：日常落笔、不写尚未传到的事、不开篇即急报');
{
  const st = makeState(548, 10, 15);
  const op = wg.historyOpening(st, () => 0.5, st.threads);
  ok('开局有日常政务（十月：征收租调）', /租调|簿书|来客/.test(op), op);
  ok('开局不含「合围台城」「朱雀桥」', !/合围台城|朱雀桥/.test(op), op);
  ok('开局不含「诏令已递到你手上」', !/诏令已递到你手上/.test(op), op);
  const iss = plot.checkText(st, '八百里加急！建康急报送到刺史府……');
  ok('开篇即急报 → 开局节奏检查拦下', iss.some(i => i.no === 15), JSON.stringify(iss));
  // 10 月 15 日：合围（24 日）尚未发生 → 历史检查拦下
  const iss2 = plot.checkText(st, '萧纪闻报，台城已被侯景合围，合围台城之事震动蜀中。');
  ok('10/15 写出尚未发生的「合围台城」→ 历史检查拦下', iss2.some(i => i.no === 6), JSON.stringify(iss2));
  // 10 月 27 日：已发生、但消息未到成都 → 信息检查提示
  const st2 = makeState(548, 10, 27);
  const iss3 = plot.checkText(st2, '萧纪闻报，合围台城之事震动蜀中。');
  ok('10/27 写出已发生但未传到的「合围台城」→ 信息检查提示', iss3.some(i => i.no === 4), JSON.stringify(iss3));
}

console.log('\n[9] 人物与派系：身边是真人、没有死人与远方要人当面');
{
  const circle = fg.circleAt('萧纪', 548, 10);
  ok('548 年身边名单含萧撝、刘孝胜', ['萧撝', '刘孝胜'].every(n => circle.some(c => c.name === n)), circle.map(c => c.name).join('、'));
  ok('名单里没有高欢（547 已死）', !circle.some(c => c.name === '高欢'));
  ok('550 年名单里没有萧衍（549 已死）', !fg.circleAt('萧纪', 550, 1).some(c => c.name === '萧衍'));
  const fx = wg.generateFactions('noble', '中古', makeState(548, 10, 15)).map(f => f.title).join(' ');
  ok('派系不再是「宗室诸王 对 外戚权臣」', !/外戚权臣/.test(fx), fx);
  ok('549 年 8 月派系含「江陵 对 成都」', /江陵 对 成都/.test(wg.generateFactions('noble', '中古', makeState(549, 8, 1)).map(f => f.title).join(' ')));
}

console.log('\n[10] 搜索：按政权过滤，不拿突厥/拜占庭充数（故障 2，离线）');
{
  const wiki = ['== 大事记 ==', '第二次君士坦丁堡公會議召開。', '突厥汗國可汗乙息記擊破柔然。', '七月，萧纪兵败，为樊猛所杀。', '八月，西魏尉迟迥取成都。'].join('\n');
  const lines = lh.filterLines(wiki, '梁', '萧纪');
  ok('过滤后不含君士坦丁堡/突厥', !lines.some(l => /君士坦丁|突厥/.test(l.text)), JSON.stringify(lines));
  ok('保留萧纪、尉迟迥两条且识别出月份', lines.length === 2 && lines[0].m === 7 && lines[1].m === 8, JSON.stringify(lines));
  const st = { clock: { gregorianYear: 553, month: 6 }, liveHistory: { 553: { v2: true, status: 'ok', source: 't', lines: [{ m: 3, text: 'A事', source: 'timeline' }, { m: 7, text: 'B事萧纪兵败', source: 'timeline' }] } } };
  const out = lh.renderLiveHistory(st);
  ok('553/6 的提示词里不出现 7 月才发生的事', /A事/.test(out) && !/B事/.test(out), out);
}

console.log('\n[11] 戏剧节拍：两难取自萧纪真实处境，不套随机狗血');
{
  const st = makeState(549, 2, 1);
  st.npcs = [{ name: '刘孝胜', contact: true, source: 'historical', role: '萧纪幕府长史', goal: '依其职掌行事' }];
  const d = drama.rollDrama(st, { force: true });
  const acts = fg.tensionAt('萧纪', 549, 2).actions;
  ok('两难选项来自「赴援台城之议」的可行行动', d && d.dilemma && acts.includes(d.dilemma.a) && acts.includes(d.dilemma.b), JSON.stringify(d && d.dilemma));
}

console.log('\n[12] 任意人物建档：程序校验会丢掉编造（离线，用模拟的模型返回）');
{
  const evidence = '王守仁，字伯安，生于1472年，卒于1529年。正德十四年，宁王朱宸濠在南昌起兵，王守仁时任南赣巡抚，驻赣州，起兵讨之，擒宁王。冀元亨为其门人。刘瑾为宦官，1510年伏诛。伍文定为吉安知府。';
  const raw = {
    name: '王守仁', born: 1472, died: 1529, polity: '明',
    posts: [{ from: 1516, to: 1521, title: '南赣巡抚', seat: '赣州', kind: '职', src: '《明史·王守仁传》' },
      { from: 1400, to: 1410, title: '虚构官职', seat: '某地', src: '编的' }],
    situation: { 1519: [{ from: 6, text: '宁王朱宸濠在南昌起兵，王守仁在赣州闻变。王守仁大破宁王军，宁王被擒，前后不到三十五天。', tension: 'T-SIT-NING', src: '《明史》' }] },
    tensions: { 'T-SIT-NING': { name: '讨宁王之议', label: '是否无旨起兵', parties: ['王守仁', '宁王'], wants: {}, whyNotResolved: '无朝旨擅自起兵是大罪', actions: ['起兵', '上奏待旨', '固守赣州'], src: '《明史》' } },
    circle: [{ name: '冀元亨', relation: '门人', role: '门人', seat: '赣州', src: '《明史》' },
      { name: '伍文定', relation: '同僚', role: '吉安知府', seat: '吉安', born: 1470, died: 1530, src: '《明史》' },
      { name: '刘瑾', relation: '宦官', role: '司礼监', seat: '北京', died: 1510, src: '《明史》' },
      { name: '张飞', relation: '部将', role: '编造', seat: '赣州', src: '编的' }],
    events: [{ y: 1519, m: 6, text: '宁王朱宸濠在南昌起兵', place: '南昌', src: '《明史》' },
      { y: 1519, m: 8, text: '倭寇大举进犯杭州焚城', place: '杭州', src: '编的' }],
  };
  const v = figureGen.validate(raw, { name: '王守仁', year: 1519, polity: '明', evidence, ident: { found: true, born: 1472, died: 1529 } });
  ok('校验通过', v.ok, v.why);
  ok('丢掉生年之前的虚构官职', v.ok && v.figure.posts.length === 1, JSON.stringify(v.figure && v.figure.posts));
  ok('丢掉证据中查无此名的「张飞」', v.ok && !v.figure.circle.some(c => c.name === '张飞'), JSON.stringify(v.figure && v.figure.circle));
  ok('丢掉 1510 年已死的「刘瑾」', v.ok && !v.figure.circle.some(c => c.name === '刘瑾'));
  ok('丢掉生卒不详、无法确认在世的人', v.ok && !v.figure.circle.some(c => c.name === '冀元亨'));
  ok('保留生卒可核、证据有名的「伍文定」', v.ok && v.figure.circle.some(c => c.name === '伍文定'));
  const sit = v.ok ? v.figure.situation[1519][0].text : '';
  ok('处境去剧透：删掉「宁王被擒、前后不到三十五天」', /闻变/.test(sit) && !/被擒|三十五天/.test(sit), sit);
  const kid = figureGen.validate({ name: '马希声', born: 899, died: 932,
    posts: [{ from: 907, to: 930, title: '武安节度副使', seat: '潭州', kind: '职', src: '维基' }],
    situation: { 907: [{ from: 1, text: '任武安节度副使，在潭州协助父亲处理藩镇政务', src: '维基' }] } },
  { name: '马希声', year: 907, evidence: '马希声 武安节度副使 潭州' });
  ok('9 岁的马希声：处境不得写他处理政务', kid.ok && !/处理藩镇政务/.test(kid.figure.situation[907][0].text) && /年方 9 岁/.test(kid.figure.situation[907][0].text),
    kid.ok && kid.figure.situation[907][0].text);
  ok('9 岁始任的官职标为名义', kid.ok && /名义/.test(kid.figure.posts[0].title), kid.ok && kid.figure.posts[0].title);
  ok('检索核到同名的现代人（1932–2022）时不采用其生卒',
    figureGen.validate(raw, { name: '王守仁', year: 1519, polity: '明', evidence, ident: { found: true, born: 1932, died: 2022 } }).ok);
  ok('丢掉证据里没有的「倭寇焚杭州」', v.ok && !v.events.some(e => /倭寇/.test(e.text)), JSON.stringify(v.events));
  ok('生成档案可信度最高 medium、标 generated', v.ok && v.figure.generated && v.events.every(e => e.conf !== 'high'));
  const bad = figureGen.validate({ name: '某人', born: 1600, died: 1650 }, { name: '某人', year: 1519, evidence: '' });
  ok('开局年在生年之前 → 拒绝建档', !bad.ok, bad.why);
  // 注册后，任意人物也能走与萧纪相同的分月处境 / 剧情矛盾
  fg.registerFigure(v.figure);
  const t = fg.tensionAt('王守仁', 1519, 7);
  ok('注册后 1519 年 7 月的剧情矛盾是「讨宁王之议」', t && t.name === '讨宁王之议', JSON.stringify(t));
}

console.log('\n[13] 实测剧情烂的四个根因（2026-10-08 下午）');
{
  // ① 丢弃的草稿不留剧情线：同一回合重来，待定线先撤
  const st = makeState(549, 2, 1);
  plan(st, '查看手中现有的人力钱粮');
  const n1 = st.plot.arcs.length;
  plan(st, '遣使往江陵');
  plan(st, '');
  ok('同一回合重来三次，剧情线不累积', st.plot.arcs.length === n1, `${n1} → ${st.plot.arcs.length}`);
  plot.commitPending(st);
  ok('采纳后待定线转正', st.plot.arcs.every(a => !a.pending));
  // ② 主线在走时不另开「某某所请」
  const st2 = makeState(549, 2, 1);
  st2.npcs = [{ name: '徐怦', contact: true, source: 'historical', role: '萧纪幕府直兵参军', goal: '把分内的兵将、宿卫管好', stanceBasis: '依职掌推定' }];
  require('./core/npcAgency').ensureAgency(st2);
  for (let t = 1; t <= 4; t++) { st2.turn = t; plan(st2, '议事'); plot.commitPending(st2); }
  ok('四回合里没有「徐怦所请」这类空剧情', !st2.plot.arcs.some(a => /所请/.test(a.title)), JSON.stringify(st2.plot.arcs.map(a => a.title)));
  ok('交给模型的剧情只有一条', (plot.renderPlotBlock(st2).match(/【P\d+】/g) || []).length === 1, plot.renderPlotBlock(st2).slice(0, 200));
  // ③ 「史无明载」占位目标不再出现在人物动机里
  const st3 = makeState(548, 10, 15);
  st3.npcs = [{ name: '刘孝胜', contact: true, source: 'historical', role: '萧纪幕府长史', goal: '依其职掌行事（萧纪幕府长史）；个人所图史无明载' },
    { name: '萧绎', contact: false, source: 'historical', role: '湘东王', goal: '依其职掌行事（湘东王）；个人所图史无明载' }];
  require('./core/npcAgency').ensureAgency(st3);
  const ag = require('./core/npcAgency').renderAgency(st3);
  ok('人物动机里没有「史无明载」', !/史无明载/.test(ag), ag);
  ok('远方未交往的萧绎不列入「各自在做什么」', !/萧绎/.test(ag), ag);
  // ④ 都督十三州不再按食邑估出 1200 兵
  const st4 = makeState(548, 10, 15);
  require('./core/economy').eco(st4);
  ok('萧纪的盘子按「都督诸州」估，兵过万', /都督/.test(st4.economy.scale) && st4.economy.military.total > 10000, `${st4.economy.scale} 兵 ${st4.economy.military.total}`);
  // ⑤ 玩家没下令，正文不得替主角「命人取来…」
  const iss = plot.checkText(st4, '萧纪命人取来府中现掌的人力钱粮簿册。', '');
  ok('没输入却写「萧纪命人取来」→ 自主性检查拦下', iss.some(i => i.no === 11), JSON.stringify(iss));
  const iss2 = plot.checkText(st4, '萧纪命人取来簿册。', '命人把簿册拿来');
  ok('玩家自己下了令则不拦', !iss2.some(i => i.no === 11), JSON.stringify(iss2));
}

console.log('\n[14] 用户 GM 规范（history-rpg-gm v5.0）第七章的程序检查与第十章档案卡');
{
  const st = makeState(549, 2, 1);
  const bad = '你点了点头，心中一动。一位老农说道：「这个计划效果不错。」你可以选择：A. 出兵 B. 观望。转眼数日后，经过一番商议，双方达成协议。';
  const nos = plot.checkText(st, bad, '').map(i => i.no);
  for (const [no, what] of [[11, '替玩家动作/心理'], [5, '擅自快进'], [19, '选项菜单'], [20, '占位人名'], [21, '现代词汇'], [22, '摘要腔']]) {
    ok(`第七章：${what} → 检出 [${no}]`, nos.includes(no), JSON.stringify(nos));
  }
  const good = '刘孝胜拱手道：「府君，犍为那边还差两簿。」他说完站着，没立刻走。';
  ok('正常的场景不误报', plot.checkText(st, good, '').filter(i => [5, 11, 19, 20, 21, 22].includes(i.no)).length === 0,
    JSON.stringify(plot.checkText(st, good, '')));
  ok('玩家自己写了「点头」则不算越权', !plot.checkText(st, '你点了点头。刘孝胜退下。', '点头示意他退下').some(i => i.no === 11));
  ok('玩家说「快进」则不算擅自快进', !plot.checkText(st, '转眼到了腊月。', '快进到腊月').some(i => i.no === 5));
  const card = require('./core/gmCard');
  const sheet = card.quickSheet(st), prof = card.profileCard(st);
  ok('速查表含时间锚点、思想与禁忌、GM 机密', /时间锚点/.test(sheet) && /思想与禁忌/.test(sheet) && /GM 机密/.test(sheet), sheet.slice(0, 200));
  ok('速查表的 GM 机密只列尚未发生的事（549/2 不含已发生的台城合围）', !/合围台城/.test(sheet.split('GM 机密')[1] || ''), sheet.split('GM 机密')[1]);
  ok('档案卡含第十章各栏', ['时间', '地点', '主角', '权力与资源', '关键人物', '未解决线索', '已发生的重要后果', 'GM 机密', '已用虚构人名', '最近三回合摘要'].every(k => prof.includes(k)), prof.slice(0, 300));
}

console.log('\n[15] 长线数据（《实现包》M3）与前情回顾（M4）、词表热加载、R4/R9');
{
  const ll = require('./core/longline');
  const st = makeState(548, 10, 15);
  st.npcs = [{ name: '刘孝胜', contact: true, source: 'historical', role: '萧纪幕府长史' }];
  ll.ensureLongline(st);
  ok('萧纪档自带两个时钟、两个伏笔种子', st.longline.clocks.length === 2 && st.longline.foreshadows.length === 2);
  for (let t = 1; t <= 6; t++) { st.turn = t; ll.advanceWorld(st, '看看今年的收成', {}); }
  ok('六轮不碰赴援 → 「幕府赴援之争」满格并进入必须发生', st.longline.firedClocks.some(c => /赴援/.test(c.name)) && /本轮必须发生/.test(ll.renderLongline(st)));
  ll.applyPatch(st, { clocksHandled: [st.longline.firedClocks[0].id] });
  ok('写进 clocksHandled 后不再强提示', !/本轮必须发生/.test(ll.renderLongline(st)));
  const pr = ll.applyPatch(st, { relationChanges: [{ name: '刘孝胜', delta: 9, reason: '重用' }, { name: '张三', delta: 1, reason: 'x' }] });
  ok('关系值单轮变化被夹到 ±2', st.longline.relations['刘孝胜'].value === 2, JSON.stringify(st.longline.relations));
  ok('查无此人的关系变更被拒', pr.rejected.some(r => /张三/.test(r)));
  const f = st.longline.foreshadows[0];
  const pr2 = ll.applyPatch(st, { foreshadowChanges: [{ id: f.id, to: '已回收', how: '反转' }] });
  ll.applyPatch(st, { foreshadowChanges: [{ id: f.id, to: '预示' }] });
  ok('伏笔回收后不能再改回「预示」', f.state === '已回收' && pr2.rejected.length === 0);
  st.turn = 40;
  ok('逾期伏笔强提示「本轮必须处理」', /逾期伏笔/.test(ll.renderLongline(st)));
  const st2 = makeState(548, 10, 15);
  ll.ensureLongline(st2);
  for (let t = 1; t <= 2; t++) { st2.turn = t; ll.advanceWorld(st2, '去城外看看', { cost: '' }); }
  ok('连续两轮无代价 → 要求本轮出代价', /【代价】/.test(ll.renderLongline(st2)));
  ll.advanceWorld(st2, '再去', { cost: '得罪了萧撝' });
  ok('付出代价后计数归零', st2.longline.noCostStreak === 0);
  const rc = require('./core/recap').buildRecap(makeState(549, 2, 1));
  ok('前情回顾含固定各栏且不超过 500 字', ['此刻', '上回停在', '眼下处境', '最紧迫的事', '身边人的态度', '本篇章'].every(k => rc.includes(k)) && rc.length <= 500, rc);
  const g = require('./core/gmrules');
  const st3 = makeState(549, 2, 1); st3.threads.push({ title: '萧撝请理丁口', status: 'resolved' });
  const nos = g.checkGM(st3, '一、府中钱粮\n萧撝请理丁口之事又被提起。OK', '').map(i => i.no);
  ok('R4 列表/英文、R9 已关闭线索复活 → 检出', nos.includes(23) && nos.includes(24), JSON.stringify(nos));
  ok('「台城被围已数月」这类回溯写法不算快进', !g.checkGM(st3, '台城被围已数月，音讯断绝。', '').some(i => i.no === 5));
  // 实测：玩家只写「问他商旅所言可有实据」，正文替萧纪编了两段台词
  const talk = '“长史，”萧纪问，“你听见了什么？”刘孝胜答了。“有鼻子有眼。”萧纪重复了一遍。';
  ok('用主角名字替他多说话 → 检出', g.checkGM(st3, talk, '召刘孝胜来，问他可有实据').some(i => i.no === 11));
  ok('玩家让他问一句，落成一句问话不算越权', !g.checkGM(st3, '萧纪问道：“可有实据？”', '问他可有实据').some(i => i.no === 11));
  ok('玩家没让他说话，他一开口就算越权', g.checkGM(st3, '萧纪道：“退下。”', '去城外看看').some(i => i.no === 11));
}

console.log('\n[16] 红线 R6/R10/R12、订正解析');
{
  const g = require('./core/gmrules');
  const cr = require('./core/corrections');
  const st = makeState(548, 10, 15);
  st.npcs = [{ name: '萧撝', age: 34, contact: true, source: 'historical', role: '宗室' }];
  ok('R6：「萧撝年方二十」与名册 34 岁不符 → 检出', g.checkGM(st, '萧撝年方二十，随叔父在蜀。', '').some(i => i.no === 26));
  ok('R6：「萧撝今年三十四岁」与名册相符 → 不报', !g.checkGM(st, '萧撝今年三十四岁。', '').some(i => i.no === 26));
  ok('订正解析：「萧纪在江陵 → 萧纪在成都」', JSON.stringify(cr.parsePair('萧纪在江陵 → 萧纪在成都')) === JSON.stringify({ wrong: '萧纪在江陵', right: '萧纪在成都' }));
  ok('订正解析：「不是刺史府，是都督府」', (cr.parsePair('不是刺史府，是都督府') || {}).wrong === '刺史府');
  cr.addCorrection(st, { text: '安西将军 应为 征西大将军', turn: 3 });
  ok('R10：订正过的「安西将军」又写回 → 检出', g.checkGM(st, '众人称他安西将军。', '').some(i => i.no === 27));
  ok('R10：写对了就不报', !g.checkGM(st, '众人称他征西大将军。', '').some(i => i.no === 27));
}

console.log('\n[17] 篇章制、路线分、章末账单、检查点、对手幕后行动、记忆与检索（《设计书》§3、§4.6、§8.6–8.7）');
{
  const ar = require('./core/arcs');
  const mem = require('./core/memory');
  const st = makeState(548, 10, 15);
  st.turn = 0;
  ar.ensureArcs(st);
  ok('开局即有第 1 章，目标取自萧纪此刻处境', st.arcs.chapters[0].goal === '京师警讯', st.arcs.chapters[0].goal);
  ok('第 1 回合是「起」', ar.beatOf(st).name === '起');
  st.turn = 7; ok('第 8 回合是「合」，提示词要求逼出大抉择', ar.beatOf(st).name === '合' && /大抉择/.test(ar.renderArcs(st)));
  // 跑满一章：十回合后出账单、开第 2 章
  const st2 = makeState(549, 2, 1);
  st2.npcs = [{ name: '刘孝胜', contact: true, source: 'historical', role: '长史' }];
  for (let t = 0; t < 10; t++) {
    st2.turn = t;
    require('./core/longline').applyPatch(st2, { relationChanges: t === 3 ? [{ name: '刘孝胜', delta: 2, reason: '采纳其议' }] : [] });
    ar.onAccept(st2, { routeDelta: t === 5 ? { 殉道: { delta: 1, reason: '当众表态必救君父' } } : {} });
    mem.onAccept(st2, { turnSummary: `第${t}轮：刘孝胜进言京师之事` }, t === 2 ? '问刘孝胜那封抄件' : '议事');
  }
  st2.turn = 10;
  ok('满十回合 → 出章末账单并开第 2 章', st2.arcs.bills.length === 1 && st2.arcs.chapters.length === 2, JSON.stringify(st2.arcs.bills[0]));
  ok('账单记下了这一章的态度变化', (st2.arcs.bills[0].态度变化 || []).some(x => /刘孝胜 \+2/.test(x)), JSON.stringify(st2.arcs.bills[0].态度变化));
  ok('路线分：理由齐全的申请被记账', st2.arcs.routeScores['殉道'] === 1);
  ar.onAccept(st2, { routeDelta: { 登顶: 1 } });
  ok('路线分：缺理由的申请被拒', st2.arcs.routeScores['登顶'] === 0);
  ok('季进度 30%（第 12 回合左右）出主线进度评估', (() => { st2.turn = 12; ar.onAccept(st2, {}); return st2.arcs.checkpoints.length === 1 && /殉道/.test(st2.arcs.checkpoints[0].text); })(), JSON.stringify(st2.arcs.checkpoints));
  // 对手：三轮无动静 → 本轮必须幕后行动
  const st3 = makeState(548, 10, 15); st3.turn = 0; ar.ensureArcs(st3);
  st3.turn = 3;
  ok('萧绎、侯景三轮没动静 → 提示「本轮必须」幕后行动', /本轮必须/.test(ar.renderOpponents(st3)));
  ar.onAcceptOpponents(st3, { offstage: ['萧绎', '侯景'] });
  ok('写进 offstage 后不再催', !/本轮必须/.test(ar.renderOpponents(st3)));
  st3.clock = { ...st3.clock, gregorianYear: 552, month: 6 };
  ok('552 年 6 月侯景已死，对手卡里不再有他（萧绎卡里提到侯景不算）', !/· 侯景：/.test(ar.renderOpponents(st3)));
  // 记忆：检索旧事
  const hits = mem.retrieve(st2, '上次刘孝胜说的那封抄件');
  ok('玩家提到旧事 → 从档案里检索到相关回合', hits.length >= 1 && hits.some(h => /抄件|刘孝胜/.test(h.text)), JSON.stringify(hits));
  ok('满十回合 → 待压缩', !!mem.pendingCompression(st2));
  ok('小结校验：凭空多出的数字被识破', mem.validateBlock('刘孝胜献粮三千石', st2.memory.turns.slice(0, 10), st2).length > 0);
}

console.log(`\n———— 梁朝末年内容回归：${pass} 通过 / ${fail} 失败 ————`);
process.exit(fail ? 1 : 0);
