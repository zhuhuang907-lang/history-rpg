'use strict';
/**
 * 剧情生成、演化与叙事控制（独立模块）
 *
 * 立场的起点是一句质问：
 *   **AI 究竟是在模拟一个真实世界中自然发生的事件，
 *     还是在为了让故事看起来精彩而强行编排剧情？**
 *
 * 所以本模块不是「给提示词加一段描写要求」，而是把剧情做成**有状态、可追踪、
 * 会被拒绝**的东西：
 *   · 剧情有编号、有七层结构、有状态机、有因果链；
 *   · 没有触发条件的剧情**根本不会被生成**（第一节第 10 条：不得强行制造重大事件）；
 *   · 生成后要过 14 项审计，重大错误直接判回，不许写进正文；
 *   · 内部日志（编号/原因/触发/因果/依据/不确定性）与玩家正文**物理分离**。
 *
 * 四件套的接线位置（用户强调的「四个系统连起来」）：
 *   剧情生成器 = 本文件 planArcs()           ——什么事件可能发生、为什么、谁行动
 *   人物行动引擎 = core/npcAgency.js         ——他实际会怎么做（利益/资源/信息/风险）
 *   世界状态引擎 = core/world.js + economy   ——记录剧情造成的实际变化
 *   叙事生成器 = prompt 只拿到「可观察层」   ——不许为好看改写模拟结果
 */

/* ============================ 常量 ============================ */

/** 剧情状态机（第四节） */
const STATUS = {
  latent: '潜在', triggered: '触发', developing: '发展', stalemate: '僵持',
  escalating: '升级', easing: '缓和', resolved: '解决', shelved: '搁置',
  terminated: '终止', unverified: '待核实',
};
/** 状态迁移的合法边：不许「过了三回合就自动升级」 */
const TRANSITIONS = {
  latent: ['triggered', 'shelved', 'terminated', 'unverified'],
  triggered: ['developing', 'stalemate', 'easing', 'resolved', 'shelved', 'unverified'],
  developing: ['stalemate', 'escalating', 'easing', 'resolved', 'shelved', 'unverified'],
  stalemate: ['developing', 'escalating', 'easing', 'resolved', 'shelved', 'terminated'],
  escalating: ['developing', 'easing', 'resolved', 'shelved', 'terminated'],
  easing: ['resolved', 'developing', 'stalemate', 'shelved', 'terminated'],
  resolved: ['terminated'],
  shelved: ['triggered', 'developing', 'resolved', 'terminated'],
  unverified: ['latent', 'triggered', 'terminated'],
  terminated: [],
};

/** 依据类型（第九节）：虚构不得伪装成史料 */
const BASIS = {
  fact: '历史确定事实',
  recorded: '史料记载但细节不明',
  disputed: '学界存在争议',
  inferred: '基于史实的合理推演',
  fictional: '为游戏加入的虚构事件',
  unknown: '目前无法确定',
};

/** 剧情规模（第五节）：重大事件必须少而实 */
const SCALE = { routine: '日常事务', ongoing: '持续性问题', major: '重大事件', background: '背景变化' };

/** 生成模式（第三节） */
const MODE = { A: '自然演化', B: '人物主动', C: '外部冲击', D: '玩家衍生' };

/** 第七层：后续发展的可能走向（不得要求每个事件都升级） */
const FOLLOWUPS = [
  '事件结束', '事件暂时搁置', '事件进入正式处理程序', '新人物加入',
  '旧有矛盾得到缓解', '矛盾进一步扩大', '某一方改变策略', '影响扩散到其他地区',
  '因资源不足而停滞', '很久之后才重新出现', '失去重要性并自然消退',
];

/* 第六节：禁止机械制造悬念。这些是「默认模板」，出现即要给出依据，否则判回。 */
const SUSPENSE_PATTERNS = [
  { re: /来访者.{0,4}(秘密|另有隐情)|每个.*都.*秘密/, why: '「来访者都有秘密」是机械悬念模板' },
  { re: /公文.{0,6}(阴谋|暗藏|另有玄机)/, why: '「公文必涉阴谋」是机械悬念模板' },
  { re: /商人.{0,6}(与.{0,4}权贵|勾结|串通)/, why: '「商人必与权贵勾结」是机械悬念模板' },
  { re: /下属.{0,6}(试探|窥探).{0,4}(主人|主上|你)/, why: '「下属都在试探主人」是机械悬念模板' },
  { re: /拒绝.{0,4}意味.{0,4}背叛|沉默.{0,4}便是.{0,4}反心/, why: '「拒绝即背叛」是机械悬念模板' },
  { re: /陌生人.{0,6}(身世|来历).{0,6}(有关|牵连)/, why: '「陌生人都与身世有关」是机械悬念模板' },
  { re: /价格.{0,4}(波动|涨跌).{0,6}(操纵|有人做局)/, why: '「价格波动必有操纵」是机械悬念模板' },
  { re: /家(族|庭).{0,4}(冲突|争执).{0,6}(夺权|谋位)/, why: '「家庭冲突必涉夺权」是机械悬念模板' },
  { re: /日常.{0,6}暗藏.{0,6}(危机|杀机)/, why: '「日常事务暗藏重大危机」是机械悬念模板' },
  { re: /未(曾|加)?解释.{0,6}伏笔|每个细节.{0,4}伏笔/, why: '「未解释的细节都成伏笔」是机械悬念模板' },
];
/* 空泛表述：第二节明令禁止，只写这些等于没写 */
const VAGUE = [/局势复杂/, /暗流涌动/, /各方心怀鬼胎/, /气氛微妙/, /山雨欲来/, /波诡云谲/];

function seeded(a, b) {
  let h = 2166136261 ^ (a || 0);
  const s = String(b || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* ============================ 初始化 ============================ */
function ensurePlot(state) {
  if (!state.plot) {
    state.plot = { version: 1, seq: 0, arcs: [], auditLog: [], plannedTurn: -1, lastPlan: null };
  }
  const p = state.plot;
  p.arcs = p.arcs || [];
  p.auditLog = p.auditLog || [];
  if (!p.migratedV2) migrateArcsV2(state, p);
  // 旧档修复：以「个人所图史无明载」为所求造出来的「某某所请」空剧情线，一律终止
  for (const a of p.arcs) {
    const L2 = (a.layers && a.layers.L2矛盾) || {};
    if (!['resolved', 'terminated'].includes(a.status) && /^T-ACTOR-/.test(L2.id || '') && /史无明|依其职掌行事/.test(String(L2.为何难解 || ''))) {
      a.status = 'terminated';
      (a.log = a.log || []).push({ turn: state.turn || 0, at: '数据修复', text: '所求是占位文字「史无明载」，并非真实请求，终止' });
    }
  }
  return p;
}

/* 旧档剧情清理（一次性，幂等）：
   ① 标题从「模板词：史料原文」改成短名；
   ② 同一矛盾的重复线只留最早一条，其余合并终止（故障 4 留下的三条同题线）；
   ③ 以「尚未发生」之事为源的线，判为无效终止（故障 3 留下的线）。
   不经状态机迁移表：这是数据修复而非剧情演进，日志里写明。 */
function migrateArcsV2(state, p) {
  const seen = new Map();
  for (const a of p.arcs) {
    if (!a || !a.layers) continue;
    if (/^.{2,8}：/.test(a.title || '') && String(a.title).length > 16) {
      const old = a.title;
      a.title = arcTitle({ label: String(old).replace(/^[^：]{2,8}：「?/, '') });
      (a.log = a.log || []).push({ turn: state.turn || 0, at: '数据修复', text: `标题由「${old}」改为「${a.title}」` });
    }
    if (['resolved', 'terminated'].includes(a.status)) continue;
    const L2 = a.layers.L2矛盾 || {};
    const src = String(L2.id || '').replace(/^T-THREAD-/, '');
    const es = /^T-THREAD-/.test(L2.id || '') ? eventStatus(state, src) : null;
    if (es === 'future' || es === 'unheard') {
      a.status = 'terminated';
      a.log.push({ turn: state.turn || 0, at: '数据修复', text: es === 'future' ? '此线以尚未发生之事为触发源，判为无效，终止' : '此线所据之事消息尚未传到主角所在地，主角不可能据此行动，判为无效，终止' });
      continue;
    }
    if (seen.has(L2.id)) {
      a.status = 'terminated';
      a.log.push({ turn: state.turn || 0, at: '数据修复', text: `与 ${seen.get(L2.id)} 同源，是同一件事的重复线，合并终止` });
      continue;
    }
    seen.set(L2.id, a.id);
  }
  p.migratedV2 = true;
}

/* ============================ 第一层：客观背景 ============================ */
function backgroundOf(state) {
  const e = (state.economy || null);
  const loc = (state.location || {});
  // yearLabel 本身已带「年」（如「太清二年」），旧实现再拼一个「年」，
  // 于是背景层写成「太清二年年10月15日·冬」。
  const yl = String((state.clock && state.clock.yearLabel) || '?').replace(/年+$/, '');
  return {
    时间: `${yl}年${(state.clock && state.clock.month) || '?'}月${(state.clock && state.clock.day) || '?'}日${(state.clock && state.clock.season) ? '·' + state.clock.season : ''}`,
    地点: `${loc.full || '?'}（${loc.polity || '?'}，控制者 ${loc.controller || '?'}）`,
    军事: e ? `总兵 ${e.military.total}（战兵 ${e.military.combat}）` : '未登记',
    财政: e ? `钱 ${e.treasury.cashGuan} 贯 / 粮 ${e.treasury.grainShi} 石 / 欠 ${e.treasury.debtGuan} 贯` : '未登记',
    粮价: e ? `${e.market.grainWenPerShi} 文/石` : '未登记',
    农事: e ? `${e.agriculture.phase}${e.agriculture.busy ? '（农忙）' : ''}${e.agriculture.disaster && e.agriculture.disaster !== '无' ? '·' + e.agriculture.disaster : ''}` : '未登记',
    交通: (state.world && state.world.交通) || '依地理推算',
    秩序: (state.world && state.world.社会秩序) || '平常',
    在册人物: (state.npcs || []).length,
    未了之事: (state.threads || []).filter(t => !t.status || t.status === 'open').length,
  };
}

/* ============================ 第二层：结构性矛盾 ============================
   矛盾不是编出来的，是从世界状态里**读**出来的。读不到就不生成剧情。 */
/* 某段文字所指的历史事件，在此时此地是否「可以当作既成事实」。
   返回 'ok'（已发生且消息已到）/ 'rumor'（已发生、消息可能已到）/ 'unheard'（已发生、消息未到）/
   'future'（尚未发生）/ null（不是年表里的事件，不作判定）。 */
function eventStatus(state, text, eventId) {
  try {
    const tl = require('./timeline');
    const ev = eventId ? tl.EVENTS.find(e => e.id === eventId) : tl.findEventByText(String(text || '').replace(/^传闻：/, ''));
    if (!ev) return null;
    const c = state.clock || {};
    const y = Number(c.gregorianYear) || 0;
    if (!tl.hasHappened(ev, y, c.month, c.day)) return 'future';
    const place = (state.location && state.location.full) || '';
    const k = tl.knownAt(ev.polity, place, y, c.month, c.day);
    if (k.known.some(e => e.id === ev.id)) return 'ok';
    if (k.rumored.some(e => e.id === ev.id)) return 'rumor';
    return 'unheard';
  } catch (_) { return null; }
}

/* 主角此刻是否在世（有本地档案的按月判；已立碑的直接判死） */
function protagonistAlive(state) {
  if (state.protagonistDead) return false;
  const p = state.protagonist || {};
  if (p.status === '已故' || p.alive === false) return false;
  try {
    const fig = require('./figure-data');
    const c = state.clock || {};
    const st = fig.statusAt(p.name, Number(c.gregorianYear) || 0, c.month);
    if (st && !st.alive) return false;
  } catch (_) { /* 无档案不判 */ }
  return true;
}

/* 档案里的「已被否定的设定」：剧情与触发文字里出现即否决（如「萧纪在江陵」） */
function deniedHit(state, text) {
  try {
    const fig = require('./figure-data');
    const hits = fig.checkDenied((state.protagonist || {}).name, text) || [];
    return hits.length ? hits[0] : null;
  } catch (_) { return null; }
}

function structuralTensions(state) {
  const out = [];
  const e = state.economy;
  const loc = (state.location || {});
  const y = Number(state.clock && state.clock.gregorianYear) || 0;

  // ⓪ 主角本人此时此月的真实处境（人物档案的 situation / tensions）——**第一候选**。
  //    旧版只读通用字段（钱粮、派系、线索），萧纪最有戏的「据蜀不赴援」根本进不来，
  //    生成出来的是「粮价变动」这类与主角处境无关的通用事件。
  try {
    const fig = require('./figure-data');
    const t = fig.tensionAt((state.protagonist || {}).name, y, state.clock && state.clock.month);
    if (t) {
      out.push({
        id: t.id, label: t.label, name: t.name,
        parties: t.parties, wants: t.wants,
        whyNotResolved: t.whyNotResolved, actions: t.actions, ifUnresolved: t.ifUnresolved,
        source: 'figure.situation', confidence: t.confidence, basis: t.basis,
        priority: 10, situation: t.situation, src: t.src,
      });
    }
  } catch (_) { /* 无档案则跳过 */ }

  // ① 财政：岁出大于留存的岁入 → 官府与地方的赋税矛盾
  if (e) {
    const rev = e.revenue || {};
    const upkeep = rev.annualUpkeepShi || 0;
    const retained = rev.retainedShi || 0;
    if (upkeep > retained) {
      out.push({
        id: 'T-FISCAL', label: '钱粮缺口',
        parties: ['官府（主官）', '本境编户', '上供（转运/朝廷）'],
        wants: { '官府（主官）': '如期足额征到赋税，且不被上头追责', '本境编户': '少缴、缓缴，先活过青黄不接', '上供（转运/朝廷）': '足额起运，不问地方死活' },
        whyNotResolved: `岁出 ${upkeep} 石 > 本州留存 ${retained} 石，缺口 ${upkeep - retained} 石不是靠催办能填的`,
        actions: ['申请展限', '重新核定税额', '加征杂税', '挪借常平仓', '向上司请减额', '追比欠户'],
        ifUnresolved: '欠发累积 → 军心不稳 / 民户逃亡 / 上官追责',
        source: 'economy.revenue', confidence: 'medium',
      });
    }
    // ② 粮价：高于基准即民生压力
    const price = e.market ? e.market.grainWenPerShi : 0;
    if (price && price > 450) {
      out.push({
        id: 'T-GRAIN', label: '粮价腾贵',
        parties: ['囤积之家', '城乡缺粮户', '官府'],
        wants: { '囤积之家': '待价而沽', '城乡缺粮户': '买得起口粮', '官府': '平抑粮价、不致生变' },
        whyNotResolved: `粮价已至 ${price} 文/石（常年在 300 上下），官仓仅 ${e.treasury.grainShi} 石，开仓平粜的能力有限`,
        actions: ['开仓平粜', '劝谕出粜', '禁止囤积', '招商运粮', '任其涨跌'],
        ifUnresolved: '饥民流徙 / 聚众求食 / 豪强趁机兼并',
        source: 'economy.market', confidence: 'medium',
      });
    }
    // ③ 军需：兵多粮少
    if (e.military && e.military.total > 0 && e.treasury.grainShi < e.military.total * 6) {
      out.push({
        id: 'T-SUPPLY', label: '军粮不继',
        parties: ['将校', '粮吏', '主官'],
        wants: { '将校': '足额按月支粮', '粮吏': '账面能平，不垫自己的钱', '主官': '既不欠饷，也不把仓掏空' },
        whyNotResolved: `在营 ${e.military.total} 人，官仓仅 ${e.treasury.grainShi} 石，不足一季之需`,
        actions: ['减员归农', '就食于外', '向邻州请粮', '暂发半饷', '听任欠发'],
        ifUnresolved: '欠饷 → 逃亡 / 鼓噪 / 劫仓',
        source: 'economy.military+treasury', confidence: 'medium',
      });
    }
  }

  // ④ 派系：真实党争框架
  //    两种存储形态都认：worldgen 写出来的是数组 [{title, sideA, sideB, stake, ...}]，
  //    旧档可能是 { items: [{name, note, ...}] }——只认一种就会读不出矛盾。
  const fitems = Array.isArray(state.factions) ? state.factions
    : ((state.factions && state.factions.items) || []);
  for (const f of fitems) {
    const nm = f.title || f.name || f.label || '';
    if (!nm) continue;
    const sideA = f.sideA || nm, sideB = f.sideB || '其对立一方';
    const stake = String(f.stake || f.note || f.desc || '人事与钱粮之争');
    out.push({
      id: 'T-FACTION-' + String(nm).slice(0, 10), label: nm,
      parties: [sideA, sideB, '主官'],
      wants: { [sideA]: '扩大本派在人事与钱粮上的份额', [sideB]: '阻止对方坐大', '主官': '借力而不被任何一方绑死' },
      whyNotResolved: `两派所求不能并存：${stake.slice(0, 40)}`,
      actions: ['举荐私人', '弹劾对方', '拖延对方所请', '结援于上', '把事捅到台面上'],
      ifUnresolved: '人事僵持 / 政令互相掣肘 / 最终诉诸上位裁决',
      source: 'factions', confidence: 'low',
      basis: 'inferred',
    });
  }

  // ⑤ 地盘归属：控制者与政权不一致
  for (const t of (state.territory || [])) {
    if (t.controlledBy && loc.polity && t.controlledBy !== loc.polity) {
      out.push({
        id: 'T-LAND-' + (t.name || ''), label: (t.name || '') + '归属之争',
        parties: [`${t.name}现据者（${t.controlledBy}）`, '本境官府'],
        wants: { [`${t.name}现据者（${t.controlledBy}）`]: '保住既得之地', '本境官府': '收回或至少名义归附' },
        whyNotResolved: `${t.name}现由${t.controlledBy}所据，与本境所属${loc.polity}不一致，双方都不肯先让`,
        actions: ['遣使宣谕', '以粮帛羁縻', '陈兵境上', '暂置不问', '请朝廷裁断'],
        ifUnresolved: '长期割据 / 边境摩擦 / 一旦中央有变即生战端',
        source: 'territory', confidence: 'low',
      });
    }
  }

  // ⑥ 未了之事：悬而未决本身就是矛盾。
  //    开局就有的线索（lastTouchedTurn 为 0）一样成立——它们本就是「尚未了结的事」，
  //    不该非得拖够三轮才算数，否则刚开局的天下大势一条也读不出来。
  for (const th of (state.threads || [])) {
    if (th.status && th.status !== 'open') continue;
    if (th.hearsay) continue;   // 传闻只作背景，不单独成线
    // 线索若指向年表里的事件：尚未发生 / 消息未到的，不得作为矛盾来源（故障 3 的根因之一：
    // 旧档的线索里存着「侯景军至朱雀桥，合围台城」，开局时它还没发生，却被当成悬案拿去生成剧情）
    const es = eventStatus(state, th.anchor || th.title, th.eventId);
    if (es === 'future' || es === 'unheard') continue;
    // 主角本人处境那条已由 ⓪ 直接读档案，这里不再重复
    if (th.source === 'figure' && out.some(t => t.source === 'figure.situation')) continue;
    const ltt = th.lastTouchedTurn || 0;
    const idle = (state.turn || 0) - ltt;
    const since = ltt > 0 ? `自第${ltt}轮后再无人过问，已拖 ${idle} 轮` : '自开局即悬而未决';
    const short = th.label || String(th.title || '').replace(/^传闻：/, '').split(/[，；。]/)[0].slice(0, 14);
    out.push({
      id: 'T-THREAD-' + (th.eventId || String(th.title || '').replace(/^传闻：/, '').slice(0, 8)), label: th.title || '',
      name: es === 'rumor' || th.hearsay ? `传闻：${short}` : short,
      parties: ['当事各方', '主官'],
      wants: { '当事各方': '了结此事（各按自己有利的方向）', '主官': '不再发酵' },
      whyNotResolved: `「${String(th.title || '').slice(0, 30)}」，${since}`,
      actions: ['重新提上日程', '派人查问', '就此了结', '任其拖着'],
      ifUnresolved: '当事人自行其是 / 旧账翻作新案',
      source: 'threads', confidence: 'medium',
    });
  }

  // ⑦ 人物目标与主官相左（人物行动引擎提供的真实目标）
  for (const n of (state.npcs || [])) {
    const g = n.agency && (n.agency.短期目标 || n.agency.goal);
    if (!g || !n.contact) continue;
    // 依职掌推定的日常所求不是「请求」，不成为矛盾；有档案实载或玩家互动产生的目标才算
    if (/史无明载/.test(String(g)) || n.stanceBasis === '依职掌推定') continue;
    out.push({
      id: 'T-ACTOR-' + n.name, label: n.name + '所请',
      parties: [n.name, '主官'],
      wants: { [n.name]: String(g).slice(0, 30), '主官': '此事不妨碍他的差事' },
      whyNotResolved: `${n.name}所求（${String(g).slice(0, 24)}）需动用主官掌握的钱粮或人事，非他一人能做主`,
      actions: ['当面陈请', '走上层路子', '以他事交换', '暂时按捺'],
      ifUnresolved: '另寻门路 / 敷衍塞责 / 积累怨气',
      source: 'npcAgency', confidence: 'low', basis: 'inferred',
    });
  }
  return out;
}

/* ============================ 第三层：行动者 ============================ */
function castFrom(state, tension) {
  const npcs = (state.npcs || []).filter(n => n && n.contact);
  const pick = i => (npcs[i] ? npcs[i].name : '');
  return {
    发起者: (tension.parties && tension.parties[0]) || pick(0) || '（未定）',
    执行者: pick(1) || (tension.parties && tension.parties[1]) || '（未定）',
    受影响者: (tension.parties || []).slice(1).join('、') || '（未定）',
    阻碍者: (tension.parties && tension.parties[2]) || '（未定）',
    旁观者: npcs.slice(3, 5).map(n => n.name).join('、') || '（未定）',
    获利者: '（由结果决定，不得预先指定）',
    受损者: '（由结果决定，不得预先指定）',
    兼角色说明: '同一人可兼任数角；各角能否行动，须受其身份、权限、资源与所知信息约束',
  };
}

/* ============================ 第四层：触发事件 ============================
   触发必须能追到世界里的具体原因。追不到 = 不生成剧情。 */
function candidatesFor(state, ctx) {
  const c = [];
  const e = state.economy;
  const adv = (ctx && ctx.advanceDays) || 0;
  const y = Number(state.clock && state.clock.gregorianYear) || 0;

  // ① 公文到达：跨了足够天数，按最慢驿程也该到了
  if (adv >= 3) {
    c.push({ kind: '公文到达', grounds: `本轮推进 ${adv} 日，按最慢寻常递程亦应递到`, mode: 'A', scale: 'routine', basis: 'inferred' });
  }
  // ② 一笔税款没有按期缴纳
  if (e && (e.treasury.debtGuan || 0) > 0) {
    c.push({ kind: '欠税未缴', grounds: `账面已欠 ${e.treasury.debtGuan} 贯`, mode: 'A', scale: 'ongoing', basis: 'inferred' });
  }
  // ③ 运输延误
  if ((state.world && /阻|滞|霖雨|雪|泥/.test(String(state.world.交通 || ''))) || (e && e.agriculture && e.agriculture.disaster && e.agriculture.disaster !== '无')) {
    c.push({ kind: '运输延误', grounds: `交通/天时不利：${(state.world && state.world.交通) || (e && e.agriculture.disaster) || ''}`, mode: 'C', scale: 'routine', basis: 'inferred' });
  }
  // ④ 官员提出任命建议
  if ((state.npcs || []).some(n => n.contact && /举|荐|辟|署/.test(String(n.role || '') + String((n.agency && n.agency.短期目标) || '')))) {
    c.push({ kind: '人事请托', grounds: '在册有人正谋举荐/辟署', mode: 'B', scale: 'routine', basis: 'inferred' });
  }
  // ⑤ 命令在地方执行受阻
  if ((state.factions && (state.factions.items || []).length >= 2)) {
    c.push({ kind: '政令受阻', grounds: `${(state.factions.items || []).length} 个势力并存，政令不无掣肘`, mode: 'A', scale: 'ongoing', basis: 'inferred' });
  }
  // ⑥ 诉讼引发争端
  if ((state.threads || []).some(t => /田|产|债|讼|状/.test(String(t.title || '')) && (!t.status || t.status === 'open'))) {
    c.push({ kind: '词讼', grounds: '线索表中有田产债务之争', mode: 'A', scale: 'routine', basis: 'inferred' });
  }
  // ⑦ 粮价变化
  if (e && e.market && e.market.grainWenPerShi && e.market.grainWenPerShi !== 300) {
    c.push({ kind: '粮价变动', grounds: `现价 ${e.market.grainWenPerShi} 文/石，异于常年 300`, mode: 'A', scale: 'routine', basis: 'inferred' });
  }
  // ⓪ 主角本人的史实处境正压在身上（人物档案 situation 指向一个结构性矛盾）
  try {
    const fig = require('./figure-data');
    const t = fig.tensionAt((state.protagonist || {}).name, y, state.clock && state.clock.month);
    if (t) c.push({ kind: '处境所迫', grounds: String(t.situation || '').slice(0, 60), mode: 'A', scale: 'ongoing', basis: t.basis || 'recorded', tensionId: t.id });
  } catch (_) { /* 无档案则跳过 */ }
  // ⑧ 使者带来消息（须先判消息能否传到）
  try {
    const tl = require('./timeline');
    const polity = (state.location && state.location.polity) || null;
    const to = String((state.location && state.location.full) || '');
    const k = tl.knownAt(polity, to, y, state.clock && state.clock.month, state.clock && state.clock.day);
    // 只取「最近才传到」的那条：早已人尽皆知的旧闻不算本轮的新消息
    const fresh = k.known.filter(e => !e.foreign).slice(-1)[0];
    const recentDays = fresh ? tl.dayIndex(y, state.clock && state.clock.month, state.clock && state.clock.day) - tl.dayIndex(fresh.y, fresh.m, fresh.d) : 9999;
    if (fresh && recentDays <= 120) {
      c.push({
        kind: '外部消息', grounds: `${fresh.y}年${fresh.m || ''}月：${fresh.text.slice(0, 30)}（${fresh.src}）`,
        mode: 'C', scale: 'major', basis: 'fact', eventId: fresh.id,
      });
    }
    // 第九条验收场景：真实事件已发生，但消息尚未传到——此时**不得**写他知道
    for (const ev of k.unheard.filter(e => !e.foreign).slice(-1)) {
      c.push({
        kind: '外部消息（未达）', grounds: `${ev.y}年之事，${ev.reach.note}；尚需约 ${ev.reach.arriveInDays} 日方可能传到`,
        mode: 'C', scale: 'background', basis: 'fact', blocked: true, eventId: ev.id,
      });
    }
  } catch (_) { /* timeline 不可用则跳过 */ }
  // ⑨ 军事行动改变力量对比
  if (state.pendingBattle || (ctx && ctx.draft && ctx.draft.battle)) {
    c.push({ kind: '军事行动', grounds: '本轮有战事推演', mode: 'D', scale: 'major', basis: 'inferred' });
  }
  // ⑩ 过去的决定终于产生后果
  const old = (state.decisions || []).filter(d => (state.turn || 0) - (d.turn || 0) >= 3 && !d.settled);
  if (old.length) {
    c.push({ kind: '旧事后果', grounds: `第${old[0].turn}轮的决定（${String(old[0].text || '').slice(0, 20)}）已历 ${(state.turn || 0) - old[0].turn} 轮`, mode: 'A', scale: 'ongoing', basis: 'inferred' });
  }
  // ⑪ 玩家本轮主动动了什么 → 衍生剧情
  if (ctx && ctx.input && String(ctx.input).trim().length > 0) {
    c.push({ kind: '玩家行动衍生', grounds: `玩家本轮：${String(ctx.input).slice(0, 30)}`, mode: 'D', scale: 'ongoing', basis: 'inferred' });
  }
  // ⑫ 人物因自身利益主动提出请求（人物行动引擎）
  const actor = (state.npcs || []).find(n => n.contact && n.agency && n.agency.queue && n.agency.queue.length);
  if (actor) {
    c.push({ kind: '人物主动请求', grounds: `${actor.name}的行动计划：${String((actor.agency.queue[0] && actor.agency.queue[0].label) || actor.agency.短期目标 || '').slice(0, 24)}`, mode: 'B', scale: 'routine', basis: 'inferred' });
  }
  return c;
}

/* ============================ 第五层：行动与反应 ============================
   结果**不预先指定**，只给「可行结果集」——由人物利益与行动条件决定。 */
const REACTION_SETS = {
  公文到达: ['照办', '拖延', '请示上官', '驳回', '转交他人', '压下来不发'],
  欠税未缴: ['补缴', '求展限', '分期', '申诉', '消极应付', '联合交涉', '公开抗缴'],
  运输延误: ['另寻运道', '加价雇脚力', '改期', '就近采买', '向上司报备', '追究经手人'],
  人事请托: ['照准', '搁置', '反问其才具', '另荐他人', '以此为交换', '当面驳回'],
  政令受阻: ['重申', '变通执行', '请上官裁断', '暂缓', '以人易人', '听任搁置'],
  词讼: ['受理', '驳回', '调解', '移交', '压案不理', '当堂对质'],
  粮价变动: ['开仓平粜', '劝谕出粜', '招商运粮', '禁止囤积', '视而不见'],
  外部消息: ['上报', '密而不宣', '据此调整部署', '遣使核实', '按兵不动'],
  '外部消息（未达）': ['（消息未到，本轮不得据此行动）'],
  军事行动: ['进兵', '固守', '退保', '请援', '议和', '招抚'],
  旧事后果: '同「欠税未缴」',
  玩家行动衍生: ['顺从', '阳奉阴违', '当面争辩', '另谋对策', '借机要价', '沉默观望'],
  人物主动请求: ['应允', '驳回', '提条件', '拖延', '反问', '转圜'],
  处境所迫: ['召僚佐议事', '遣使探问虚实', '整军以备', '按兵观望', '上表陈情', '暂置不议、照常理事'],
};

/* ============================ 剧情生成 ============================ */

function newId(p) { p.seq = (p.seq || 0) + 1; return `P${String(p.seq).padStart(3, '0')}`; }

/** 是否允许再开新剧情（第五节节奏规则 4：限制玩家当前能实际处理的事务量） */
function capacity(state) {
  const p = ensurePlot(state);
  const active = p.arcs.filter(a => ['triggered', 'developing', 'stalemate', 'escalating'].includes(a.status));
  const major = active.filter(a => a.scale === 'major').length;
  return { active: active.length, major, canOpen: active.length < 3, canOpenMajor: major < 1 };
}

/**
 * 本轮剧情规划：决定什么事件可能发生、为什么、谁行动。
 * 关键：**条件不足就不生成**，返回 skipped 并说明缺什么。
 */
function planArcs(state, ctx = {}) {
  const p = ensurePlot(state);
  // 同一回合重来（上一份草稿被丢弃）：先撤掉那份草稿规划出的待定剧情线，再重新规划。
  // 旧版每点一次「重来」就多一条线，丢弃的输入（如「查看手中现有的人力钱粮」）还留在剧情里当触发源。
  p.arcs = p.arcs.filter(a => !(a.pending && (a.turn || 0) >= (state.turn || 0)));
  const out = { newArcs: [], advanced: [], skipped: [], blocked: [], capacity: capacity(state) };
  const rnd = seeded((state.turn || 0) * 977 + 13, `${(state.meta && state.meta.id) || ''}|plot`);

  // —— 先推进已有剧情（第七层：后续发展）——
  for (const a of p.arcs) {
    if (['resolved', 'terminated'].includes(a.status)) continue;
    const r = advanceArc(a, state, ctx, rnd);
    if (r) out.advanced.push(r);
  }

  // —— 主角已故：不再为他生成任何新剧情（萧纪 553 年 7 月之后不得再有他的行动）——
  if (!protagonistAlive(state)) {
    out.skipped.push({ why: `主角${(state.protagonist && state.protagonist.name) || ''}已故，不再生成以其为行动者的新剧情` });
    p.plannedTurn = state.turn || 0;
    p.lastPlan = out;
    return out;
  }

  // —— 再考虑开新剧情 ——
  // 否决条款：触发依据指向「尚未发生」或「消息未到」的事件，一律不得作为触发源（故障 3）
  const all = candidatesFor(state, ctx).map(c => {
    if (c.blocked) return c;
    const es = eventStatus(state, c.grounds, c.eventId);
    if (es === 'future') return { ...c, blocked: true, grounds: `${c.grounds}（所指之事尚未发生，否决）` };
    if (es === 'unheard') return { ...c, blocked: true, grounds: `${c.grounds}（消息尚未传到，否决）` };
    const dn = deniedHit(state, c.grounds);
    if (dn) return { ...c, blocked: true, grounds: `${c.grounds}（违反档案否定条目：${dn.text}）` };
    return c;
  });
  const cands = all.filter(c => !c.blocked);
  const blocked = all.filter(c => c.blocked);
  out.blocked = blocked.map(b => ({ kind: b.kind, grounds: b.grounds }));
  if (!cands.length) {
    out.skipped.push({ why: '本轮没有任何可追溯的触发条件，故不生成新剧情（世界照常推进，不强行制造事件）' });
    p.plannedTurn = state.turn || 0;
    p.lastPlan = out;
    return out;
  }
  const tensions = structuralTensions(state).filter(t => !deniedHit(state, `${t.label} ${t.whyNotResolved}`));
  if (!tensions.length) {
    out.skipped.push({ why: '世界里读不出结构性矛盾（无事可争），故不生成新剧情' });
    p.plannedTurn = state.turn || 0;
    p.lastPlan = out;
    return out;
  }
  if (!out.capacity.canOpen) {
    out.skipped.push({ why: `当前已有 ${out.capacity.active} 项进行中的剧情，超过玩家能同时处理的上限，本轮不开新篇` });
    p.plannedTurn = state.turn || 0;
    p.lastPlan = out;
    return out;
  }

  // 重大事件必须少而实：已有 major 在进行，或距上次 major 不足 8 轮，都不开
  const lastMajor = p.arcs.slice().reverse().find(a => a.scale === 'major');
  const majorOk = out.capacity.canOpenMajor
    && (!lastMajor || (state.turn || 0) - (lastMajor.turn || 0) >= 8);

  // —— 判重：同一矛盾已有在跑（或搁置）的剧情，就推进旧线，不另开新线（故障 4）——
  //    规格：「同一矛盾可反复出现但必须有状态变化，不得换汤不换药」。
  const liveArcOf = id => p.arcs.find(a => a.layers && a.layers.L2矛盾 && a.layers.L2矛盾.id === id
    && !['resolved', 'terminated'].includes(a.status));
  // 聚焦：主角的史实处境线在走时，不另开通用矛盾（钱粮、派系、某某所请）——一回合只讲一件事。
  // 实测旧版一回合同时推三条线（京师警讯 + 徐怦所请 + 王僧略所请），正文只好写成三人排队递文书的流水账。
  const mainLive = p.arcs.some(a => !['resolved', 'terminated', 'shelved'].includes(a.status)
    && a.layers && a.layers.L2矛盾 && a.layers.L2矛盾.依据 === 'figure.situation');
  const fresh = tensions.filter(t => !liveArcOf(t.id) && !(mainLive && !(t.priority > 0)));
  if (!fresh.length) {
    // 全部矛盾都已有线：把本轮的触发记到最相关的旧线上（有状态变化依据才动状态）
    const top = tensions.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
    const a = liveArcOf(top.id);
    const trig = cands.find(c => c.tensionId === top.id) || cands[0];
    if (a && trig && !(a.log || []).some(l => l.turn === (state.turn || 0) && l.at === '再触发')) {
      a.log.push({ turn: state.turn || 0, at: '再触发', text: `「${trig.kind}」：${trig.grounds}（同一矛盾，并入旧线，不另开新篇）` });
      if (a.status === 'shelved') {
        const r = move(a, 'triggered', `搁置之事因「${trig.kind}」重新提上日程`, state);
        if (r) out.advanced.push(r);
      }
    }
    out.skipped.push({ why: '本轮可能的矛盾都已有对应剧情在推进，判为同一事，不重复开线' });
    p.plannedTurn = state.turn || 0;
    p.lastPlan = out;
    return out;
  }

  // 只用 1 个新剧情（节奏规则 1：不强制每隔固定回合生成；允许无事发生）
  // 矛盾按优先级取：主角本人的史实处境（priority 10）先于钱粮、粮价这类通用矛盾；同级才随机
  const maxPri = Math.max(...fresh.map(t => t.priority || 0));
  const top = fresh.filter(t => (t.priority || 0) === maxPri);
  const tension = top[Math.floor(rnd() * top.length)];
  // 触发条件与矛盾要对得上：处境矛盾优先配「处境所迫 / 外部消息 / 玩家行动」，不配「粮价变动」
  const fit = cands.filter(c => c.tensionId === tension.id
    || (tension.source === 'figure.situation' && ['外部消息', '玩家行动衍生', '人物主动请求'].includes(c.kind)));
  const pool = fit.length ? fit : cands;
  const pick = pool[Math.floor(rnd() * pool.length)];
  let scale = pick.scale;
  if (scale === 'major' && !majorOk) scale = 'ongoing';

  const arc = {
    id: newId(p),
    // 标题是这件**事**的名字，不是「模板词：史料原文」的拼接
    title: arcTitle(tension),
    mode: pick.mode, modeLabel: MODE[pick.mode],
    scale, scaleLabel: SCALE[scale],
    status: 'triggered',
    basis: pick.basis || 'inferred', basisLabel: BASIS[pick.basis || 'inferred'],
    turn: state.turn || 0, lastTurn: state.turn || 0,
    layers: {
      L1背景: backgroundOf(state),
      L2矛盾: {
        id: tension.id,
        各方: tension.parties,
        各有所求: tension.wants,
        为何难解: tension.whyNotResolved,
        可采取的实际行动: tension.actions,
        久拖之后: tension.ifUnresolved,
        依据: tension.source, 可信度: tension.confidence,
      },
      L3行动者: castFrom(state, tension),
      L4触发: { 类型: pick.kind, 依据: pick.grounds, 可追溯: true },
      L5行动与反应: {
        发起方动作: '（由叙事依其身份、权限与资源写成，不得超出其能力）',
        可行反应集: REACTION_SETS[pick.kind] || ['照办', '拖延', '驳回', '请示'],
        注意: '结果不得预先指定；不得从「要求缴税」直接跳到「阴谋反抗」',
      },
      L6状态变化: [],
      L7后续: { 可能走向: FOLLOWUPS, 当前判定: '发展', 依据: '触发条件已成立，各方反应未定' },
    },
    chain: {
      历史背景: `${(state.clock && state.clock.yearLabel) || '?'}·${(state.location && state.location.full) || '?'}`,
      已知矛盾: tension.id,
      人物目标: '见 L3 行动者',
      触发条件: pick.grounds,
      实际行动: '', 对方反应: '', 直接结果: '', 世界状态变化: '', 后续影响: '',
      gaps: [],
    },
    log: [{ turn: state.turn || 0, at: '创建', text: `因「${pick.grounds}」触发；所争为 ${tension.whyNotResolved}` }],
    lastPlanTurn: state.turn || 0,
    pending: true,   // 玩家采纳本回合草稿后才转正（见 commitPending）
  };
  p.arcs.push(arc);
  if (p.arcs.length > 60) p.arcs = p.arcs.slice(-60);
  out.newArcs.push({ id: arc.id, title: arc.title, mode: arc.modeLabel, scale: arc.scaleLabel, status: STATUS[arc.status], basis: arc.basisLabel });

  p.plannedTurn = state.turn || 0;
  p.lastPlan = out;
  return out;
}

/** 玩家采纳草稿：本回合规划的待定剧情线转正 */
function commitPending(state) {
  for (const a of ensurePlot(state).arcs) if (a.pending) delete a.pending;
}

/** 剧情标题：用矛盾的名字（name），没有就取 label 的第一个分句，最多 16 字 */
function arcTitle(t) {
  if (t.name) return String(t.name).slice(0, 16);
  const s = String(t.label || t.whyNotResolved || '未名之事').replace(/^传闻：/, '');
  const first = s.split(/[，；。,;]/)[0] || s;
  return first.length > 16 ? first.slice(0, 16) + '…' : first;
}

/** 状态机推进（第四节）：状态变化必须有依据，不许「过了几回合自动升级」 */
function advanceArc(a, state, ctx, rnd) {
  const gapTurns = (state.turn || 0) - (a.lastTurn || a.turn || 0);
  if (gapTurns <= 0) return null;
  a.lastTurn = state.turn || 0;

  // 无人过问 → 搁置（而非升级）。这是第五节节奏规则 3 的落地。
  const touched = (ctx && ctx.touched) ? ctx.touched.includes(a.id) : false;
  if (!touched && gapTurns >= 4 && a.status === 'developing') {
    return move(a, 'shelved', `连续 ${gapTurns} 轮无人过问，按「暂时搁置」处理（不自动升级）`, state);
  }
  if (!touched && gapTurns >= 6 && ['triggered', 'stalemate'].includes(a.status)) {
    return move(a, 'shelved', `连续 ${gapTurns} 轮无人推进`, state);
  }
  // 有资源支撑才可能升级；没有就不动
  if (touched && a.status === 'developing') {
    const e = state.economy;
    const hasMeans = !e || (e.treasury.grainShi > 0 || e.treasury.cashGuan > 0);
    if (hasMeans && rnd && rnd() < 0.35) {
      return move(a, 'escalating', '本轮有人推进，且各方尚有可动用之资，冲突范围扩大', state);
    }
    if (rnd && rnd() < 0.25) {
      return move(a, 'easing', '本轮有人推进，一方作出让步，冲突程度下降', state);
    }
  }
  if (a.status === 'escalating' && gapTurns >= 2) {
    return move(a, 'developing', '升级后转入相持，各方重新计算得失', state);
  }
  if (a.status === 'shelved' && gapTurns >= 8) {
    return move(a, 'terminated', '久置不问，已失去后续作用（记录保留，防止将来重新生成同一事件时与旧结果冲突）', state);
  }
  return null;
}

function move(a, to, why, state) {
  const from = a.status;
  if (!(TRANSITIONS[from] || []).includes(to)) {
    a.log.push({ turn: state.turn || 0, at: '非法迁移被拒', text: `${STATUS[from]} → ${STATUS[to]} 不在允许之列，未改状态` });
    return null;
  }
  a.status = to;
  a.log.push({ turn: state.turn || 0, at: '状态', text: `${STATUS[from]} → ${STATUS[to]}：${why}` });
  if (a.layers && a.layers.L7后续) {
    a.layers.L7后续.当前判定 = STATUS[to];
    a.layers.L7后续.依据 = why;
  }
  return { id: a.id, from: STATUS[from], to: STATUS[to], why };
}

/**
 * 回合结算：推进所有剧情的状态机，并把本轮实际发生的状态变化入账。
 * 与 planArcs 的分工：planArcs 在写正文**之前**决定「可能发生什么」，
 * settleArcs 在采纳草稿**之后**落实「实际发生了什么」——没有实际变化就记「无成果」。
 */
function settleArcs(state, ctx = {}) {
  const p = ensurePlot(state);
  const out = { advanced: [], effects: [], noResult: [] };
  const rnd = seeded((state.turn || 0) * 7919 + 3, `${(state.meta && state.meta.id) || ''}|settle`);
  const touched = ctx.touched || [];
  for (const a of p.arcs) {
    if (['resolved', 'terminated'].includes(a.status)) continue;
    const r = advanceArc(a, state, { touched }, rnd);
    if (r) out.advanced.push(r);
  }
  for (const eff of (ctx.effects || [])) {
    if (!eff || !eff.arcId) continue;
    const r = recordEffect(state, eff.arcId, eff);
    out.effects.push(r);
  }
  for (const nr of (ctx.noResult || [])) {
    if (!nr || !nr.arcId) continue;
    const r = recordNoResult(state, nr.arcId, nr.why);
    out.noResult.push(r);
  }
  return out;
}

/* ============================ 第六层：世界状态变化 ============================ */
/** 记录一次剧情造成的实际变化；没有实际变化就记「无成果行动」，不许虚构后果。 */
function recordEffect(state, arcId, eff) {
  const p = ensurePlot(state);
  const a = p.arcs.find(x => x.id === arcId);
  if (!a) return { ok: false, why: `没有编号为 ${arcId} 的剧情` };
  const rec = {
    turn: state.turn || 0,
    项: eff.项 || '',
    变化: eff.变化 || '',
    由谁所致: eff.由谁所致 || '',
    依据: eff.依据 || '',
  };
  if (!rec.项 || !rec.依据) return { ok: false, why: '状态变化必须写明「变了什么」和「凭什么」，缺一不入账' };
  a.layers.L6状态变化.push(rec);
  a.log.push({ turn: state.turn || 0, at: '状态变化', text: `${rec.项}：${rec.变化}（${rec.依据}）` });
  return { ok: true, rec };
}
/** 明确记录「这一轮白忙了」——第一节第 10 条允许无结果的行动 */
function recordNoResult(state, arcId, why) {
  const p = ensurePlot(state);
  const a = p.arcs.find(x => x.id === arcId);
  if (!a) return { ok: false, why: `没有编号为 ${arcId} 的剧情` };
  a.log.push({ turn: state.turn || 0, at: '无成果', text: why || '本轮推进未取得实际结果，不得虚构重大后果填充剧情' });
  return { ok: true };
}

/* ============================ 剧情质量审计（第十一节 14 项） ============================ */
function auditArc(a, state, text) {
  const issues = [];
  const push = (no, name, ok, why) => { if (!ok) issues.push({ no, name, why, arc: a.id }); };
  const L = a.layers || {};

  push(1, '起因检查', !!(L.L4触发 && L.L4触发.依据), '没有可追溯的触发因素');
  push(2, '人物检查', !!(L.L3行动者 && L.L3行动者.发起者 && L.L3行动者.发起者 !== '（未定）'), '发起者未落实');
  push(3, '能力检查', true, '');   // 由叙事层按权限/资源判断，引擎在 4 项里查信息
  // 4 信息检查：远方人物不得掌握尚未传到的消息
  const known = String((state.facts || []).map(f => f.text || '').join(' '));
  push(4, '信息检查', !(/密报|飞报|急递/.test(String(text || '')) && !known), '正文出现急报却无对应的信息登记');
  // 7 状态检查：已终止/解决的剧情不得再当进行时
  push(7, '状态检查', !['resolved', 'terminated'].includes(a.status) || !/正在|持续/.test(String(text || '')), `剧情已「${STATUS[a.status]}」，正文却仍按进行时写`);
  // 8 因果检查：因果链是否有缺口
  const ch = a.chain || {};
  const gaps = [];
  if (!ch.触发条件) gaps.push('缺前置触发');
  if (ch.直接结果 && !ch.实际行动) gaps.push('有结果却无实际行动');
  if (ch.世界状态变化 && !ch.直接结果) gaps.push('有状态变化却无直接结果');
  if (ch.后续影响 && !ch.世界状态变化) gaps.push('有后续影响却无状态变化');
  a.chain.gaps = gaps;
  push(8, '因果检查', gaps.length === 0, `因果链有缺口：${gaps.join('、')}`);
  // 9 重复检查：是否只是旧剧情换了名字
  const dup = (state.plot.arcs || []).filter(x => x.id !== a.id
    && x.layers && L.L2矛盾 && x.layers.L2矛盾 && x.layers.L2矛盾.id === L.L2矛盾.id
    && !['terminated'].includes(x.status));
  push(9, '重复检查', dup.length === 0, `与已有剧情 ${dup.map(d => d.id).join('、')} 同源，是旧事换了名字`);
  // 12 后续检查
  push(12, '后续检查', !!(L.L7后续 && L.L7后续.当前判定 && L.L7后续.依据), '未记录后续状态与判定依据');
  // 13 复杂度检查：同一轮并行过多
  const active = (state.plot.arcs || []).filter(x => ['triggered', 'developing', 'stalemate', 'escalating'].includes(x.status));
  push(13, '复杂度检查', active.length <= 3, `进行中的剧情 ${active.length} 项，超出玩家能实际处理的数量`);
  // 14 可执行性检查
  push(14, '可执行性检查', !!(L.L5行动与反应 && (L.L5行动与反应.可行反应集 || []).length >= 2), '没有给玩家留下真实可行的行动空间');
  return issues;
}

/**
 * 与具体剧情无关、只看正文就能查的四项（第 5/6/10/11 项）。
 * 为什么单列：**没有在跑的剧情时也要能查**——否则开局第一句
 * 「次日，你打定主意…」就没人拦，那正是最容易被放过去的地方。
 */
function checkText(state, text, input = null) {
  const issues = [];
  const T = String(text || '');
  // 5 时间检查：不得跨日推进
  if (/次日|三日后|数月后|半月后|翌日/.test(T)) issues.push({ no: 5, name: '时间检查', why: '正文出现跨日推进（时间不归 GM 管）', arc: null });
  // 6 历史检查：把尚未发生的事写成既成事实
  try {
    const tl = require('./timeline');
    const y = Number(state.clock && state.clock.gregorianYear) || 0;
    const after = tl.eventsAfter((state.location && state.location.polity) || null, y, state.clock && state.clock.month, state.clock && state.clock.day);
    for (const ev of after) {
      // 关键词优先用人工登记的 keys（同一件事有无数种说法，截取原文前几个字是查不出来的）
      const keys = (ev.keys && ev.keys.length) ? ev.keys : [String(ev.text || '').slice(0, 8)];
      for (const key of keys) {
        if (key && T.includes(key)) {
          issues.push({ no: 6, name: '历史检查', why: `把尚未发生的事（${ev.y}年 ${ev.text.slice(0, 20)}）写成了既成事实`, arc: null });
          break;
        }
      }
    }
    // 4 信息检查：已发生、但消息还没传到主角所在地的事，正文不得写成已知
    const place = (state.location && state.location.full) || '';
    const k = tl.knownAt((state.location && state.location.polity) || null, place, y, state.clock && state.clock.month, state.clock && state.clock.day);
    for (const ev of k.unheard) {
      const keys = (ev.keys && ev.keys.length) ? ev.keys : [String(ev.text || '').slice(0, 8)];
      if (keys.some(key => key && T.includes(key))) {
        issues.push({ no: 4, name: '信息检查', why: `「${ev.text.slice(0, 20)}」已发生，但消息${ev.reach && ev.reach.arriveInDays ? `还需约 ${ev.reach.arriveInDays} 日` : '尚未'}才能传到${place}，正文不得写成已知`, arc: null });
      }
    }
  } catch (_) { /* 无 timeline 则跳过 */ }
  // —— 以下三项来自用户对旧版本的原话批评，做成程序硬校验，不再只靠提示词 ——
  // 15 开局节奏：「开头太紧凑了，不够日常」。开局正文的前 150 字不得是急报、密诏、大军压境。
  const isOpening = !(state.log || []).some(l => l.speaker === 'GM');
  if (isOpening && /急报|急递|密诏|密敕|飞骑|八百里|加急|兵临城下|大军压境|烽火|十万火急/.test(T.slice(0, 150))) {
    issues.push({ no: 15, name: '开局节奏检查', why: '开局开篇即写急报/密诏/大军，应先从此时此地的日常政务或一位具体来客落笔', arc: null });
  }
  // 16 行为能力：「什么叫做9岁孩童管理国事」。未成年主角不得被写成亲自理政、调兵、裁决。
  try {
    const cap = require('./capability').capabilityOf(state);
    if (cap && cap.isMinor && /你(亲自)?(批阅|批复|下令|下旨|裁决|裁断|调兵|发兵|升堂|处置|任命|罢免)/.test(T)) {
      issues.push({ no: 16, name: '行为能力检查', why: `主角年方 ${cap.age} 岁，实务由${cap.guardian ? cap.guardian.name : '辅政者'}主持，正文却写他亲自理政/调兵`, arc: null });
    }
  } catch (_) { /* 闸门不可用 */ }
  // 17 生死检查：已故之人不得开口、行动
  {
    const c = state.clock || {};
    const y0 = Number(c.gregorianYear) || 0;
    let fig = null; try { fig = require('./figure-data'); } catch (_) { /* 无档案 */ }
    for (const n of (state.npcs || [])) {
      if (!n || !n.name || n.name.length < 2) continue;
      const dead = n.status === '已故' || n.alive === false
        || (n.died != null && y0 && (Number(n.died) < y0 || (Number(n.died) === y0 && n.diedM && c.month > n.diedM)))
        || (fig && fig.statusAt(n.name, y0, c.month) && !fig.statusAt(n.name, y0, c.month).alive);
      if (dead && new RegExp(`${n.name}(?:[^，。；]{0,4})?(道|说|笑|答|问|拱手|起身|进来|来见|求见|上前)`).test(T)) {
        issues.push({ no: 17, name: '生死检查', why: `${n.name}此时已不在世，正文却让他开口/行动`, arc: null });
      }
    }
  }
  // 18 时代观念：后世观念/词汇（人权、自由恋爱、封建礼教……）
  try { issues.push(...require('./ethics').checkEthics(state, T)); } catch (_) { /* 无底表 */ }
  // 19–22 + 5/11（续）：用户 GM 规范第七章里能由程序判定的错误
  try { issues.push(...require('./gmrules').checkGM(state, T, input)); } catch (_) { /* 规则模块不可用 */ }
  // 6 历史检查（续）：档案明确否定的设定（如「萧纪在江陵」）
  const dn = deniedHit(state, T);
  if (dn) issues.push({ no: 6, name: '历史检查', why: `出现档案已否定的设定「${dn.text}」：${dn.why || ''}`, arc: null });
  // 10 悬念检查：机械悬念模板
  for (const s of SUSPENSE_PATTERNS) {
    if (s.re.test(T)) { issues.push({ no: 10, name: '悬念检查', why: s.why, arc: null }); break; }
  }
  // 11 玩家自主性检查
  if (/你心想|你暗想|你打定主意|你决定/.test(T)) issues.push({ no: 11, name: '玩家自主性检查', why: '替玩家写了内心决定', arc: null });
  // 11（续）替主角下令：实测玩家什么都没输入，正文开头却是「萧纪命人取来府中现掌的人力钱粮簿册」。
  //    只有给了 input 时才能判（input 为 null 表示调用方不知道玩家写了什么，不判）。
  if (input != null) {
    const nm = String((state.protagonist && state.protagonist.name) || '').trim();
    const subj = nm ? `(?:你|${nm})` : '你';
    const order = new RegExp(`${subj}(?:当即|随即|便|遂|于是)?(?:命人|令人|吩咐|下令|传令|命左右|唤人|召来|传来)`);
    const asked = /命|令|吩咐|传|召|唤|叫/.test(String(input || ''));
    if (order.test(T) && !asked) issues.push({ no: 11, name: '玩家自主性检查', why: '玩家本轮没有下令，正文却替主角发号施令（如「命人取来…」）', arc: null });
  }
  // 2 空泛表述：第二节明令禁止
  for (const v of VAGUE) {
    if (v.test(T)) { issues.push({ no: 2, name: '人物检查', why: `出现空泛表述「${String(v).replace(/[/\\]/g, '')}」，须写明具体的人、事、数`, arc: null }); break; }
  }
  return issues;
}

/** 对本轮正文做一次全量审计；返回 { blocking, warnings, issues } */
function auditText(state, text, arcIds) {
  const p = ensurePlot(state);
  const ids = (arcIds && arcIds.length) ? arcIds : p.arcs.filter(a => !['resolved', 'terminated'].includes(a.status)).map(a => a.id);
  const issues = checkText(state, text);
  for (const id of ids) {
    const a = p.arcs.find(x => x.id === id);
    if (!a) continue;
    issues.push(...auditArc(a, state, text));
  }
  const blocking = issues.filter(i => [1, 2, 5, 6, 7, 9, 11, 15, 16, 17, 18, 19].includes(i.no));
  const warnings = issues.filter(i => !blocking.includes(i));
  const rec = { turn: state.turn || 0, at: new Date().toISOString(), arcIds: ids, issues, blocking: blocking.length, warnings: warnings.length };
  p.auditLog.push(rec);
  if (p.auditLog.length > 100) p.auditLog = p.auditLog.slice(-100);
  return { blocking, warnings, issues, count: issues.length };
}

/* ============================ 输出：正文层（可观察） ============================ */
/** 给叙事生成器的指令块：**只给可观察层**。内部数据（隐藏动机、未来结果）绝不进这里。 */
function renderPlotBlock(state) {
  const p = ensurePlot(state);
  const active = p.arcs.filter(a => !['resolved', 'terminated', 'latent'].includes(a.status));
  if (!active.length) {
    return [
      '=== 本轮剧情（引擎规划） ===',
      '· 本轮没有需要推进的剧情。世界照常运转（季节、物价、人心、公文往来），但不必制造事件。',
      '· 若你发现确有可写之事，它必须是**已经存在的人与事**的延续，不得凭空添设新矛盾、新秘密、新危机。',
    ].join('\n');
  }
  const lines = ['=== 本轮剧情（引擎规划，以它为准；你只能写它引发的可观察后果，不得另造事件） ==='];
  // 只给最要紧的一条：主角史实处境线优先，否则取最新一条。一回合只讲一件事
  const main = active.filter(a => a.layers && a.layers.L2矛盾 && a.layers.L2矛盾.依据 === 'figure.situation');
  const focus = (main.length ? main : active).slice(-1);
  for (const a of focus) {
    const L = a.layers || {};
    lines.push(`【${a.id}】${a.title}　——${a.modeLabel} / ${a.scaleLabel} / 状态：${STATUS[a.status]} / 依据：${a.basisLabel}`);
    if (L.L2矛盾) lines.push(`　矛盾：${L.L2矛盾.为何难解}`);
    // 旧触发里的「玩家本轮：……」是**当时那一轮**的输入；原样写进今天的提示词，模型会当成本轮指令
    // （实测：一条早已丢弃的「查看手中现有的人力钱粮」被当成本轮意图，正文完全没回应玩家的新问题）
    if (L.L4触发) lines.push(`　触发：${L.L4触发.类型}（${String(L.L4触发.依据 || '').replace(/^玩家本轮：/, `第${a.turn || 0}轮时玩家曾：`)}）——这是旧事，本轮玩家要做什么以「本轮任务」为准`);
    if (L.L3行动者) lines.push(`　行动者：发起 ${L.L3行动者.发起者}；受其影响 ${L.L3行动者.受影响者}；可能阻碍 ${L.L3行动者.阻碍者}`);
    const rs = (L.L5行动与反应 && L.L5行动与反应.可行反应集) || [];
    if (rs.length) lines.push(`　对方可能的反应（**结果未定，由条件与利益决定，不得预先指定**）：${rs.join(' / ')}`);
    if (L.L7后续) lines.push(`　后续走向：${L.L7后续.当前判定}（${L.L7后续.依据}）`);
  }
  lines.push('【写法要求】');
  lines.push('1. 正文只写可观察之事：谁来了、说了什么、递了什么、脸色如何、当场的结果。');
  lines.push('2. 只写当事人说出口、做出来、看得见的部分；旁人没讲出口的算计与尚未发生的结果，一律不写。');
  lines.push('3. 不得把「要求缴税」直接跳成「阴谋反抗」；先按对方的能力、代价与退路走一遍。');
  lines.push('4. 日常事务就写成日常事务：来递一份寻常公文的人，就让他确实是来递公文的。');
  lines.push('5. 本轮可以没有结果——白跑一趟、拖延、答非所问，都是合法的内容。');
  return lines.join('\n');
}

/* ============================ 输出：内部日志（与正文分离） ============================ */
function renderPlotAudit(state) {
  const p = ensurePlot(state);
  const lines = ['=== 剧情后台日志（内部用，不得混入玩家正文） ==='];
  for (const a of p.arcs.slice(-8)) {
    lines.push(`【${a.id}】${a.title}　${STATUS[a.status]}　${a.modeLabel}/${a.scaleLabel}　依据：${a.basisLabel}`);
    lines.push(`　因果：${a.chain.历史背景} → ${a.chain.已知矛盾} → ${a.chain.触发条件} → ${a.chain.实际行动 || '（待写）'} → ${a.chain.对方反应 || '（待写）'} → ${a.chain.直接结果 || '（待写）'} → ${a.chain.世界状态变化 || '（待写）'} → ${a.chain.后续影响 || '（待写）'}`);
    if ((a.chain.gaps || []).length) lines.push(`　缺口：${a.chain.gaps.join('、')}（缺口未补则不得据此下判断）`);
    for (const l of (a.log || []).slice(-4)) lines.push(`　· 第${l.turn}轮 ${l.at}：${l.text}`);
    for (const e of (a.layers.L6状态变化 || []).slice(-3)) lines.push(`　· 状态变化：${e.项} ${e.变化}（${e.依据}）`);
  }
  const last = p.auditLog[p.auditLog.length - 1];
  if (last) {
    lines.push(`最近一次审计：第${last.turn}轮，阻断 ${last.blocking} 项、提示 ${last.warnings} 项`);
    for (const i of (last.issues || []).slice(0, 8)) lines.push(`　· [${i.no}] ${i.name}：${i.why}`);
  }
  return lines.join('\n');
}

/* ============================ 对外汇总（面板用） ============================ */
function summarize(state) {
  const p = ensurePlot(state);
  const by = {};
  for (const a of p.arcs) by[STATUS[a.status]] = (by[STATUS[a.status]] || 0) + 1;
  return {
    总数: p.arcs.length,
    按状态: by,
    按规模: p.arcs.reduce((m, a) => { m[SCALE[a.scale]] = (m[SCALE[a.scale]] || 0) + 1; return m; }, {}),
    按依据: p.arcs.reduce((m, a) => { m[BASIS[a.basis]] = (m[BASIS[a.basis]] || 0) + 1; return m; }, {}),
    进行中: p.arcs.filter(a => ['triggered', 'developing', 'stalemate', 'escalating'].includes(a.status))
      .map(a => ({ id: a.id, title: a.title, 状态: STATUS[a.status], 规模: SCALE[a.scale], 模式: a.modeLabel, 依据: a.basisLabel, 触发: a.layers.L4触发 && a.layers.L4触发.依据 })),
    最近日志: p.auditLog.slice(-3),
  };
}

module.exports = {
  ensurePlot, planArcs, settleArcs, advanceArc, recordEffect, recordNoResult,
  auditArc, auditText, checkText, renderPlotBlock, renderPlotAudit, summarize,
  structuralTensions, candidatesFor, backgroundOf, castFrom, capacity,
  eventStatus, protagonistAlive, arcTitle, commitPending,
  STATUS, BASIS, SCALE, MODE, FOLLOWUPS, SUSPENSE_PATTERNS, TRANSITIONS, REACTION_SETS,
};
