'use strict';
/**
 * 剧情张力引擎。
 *
 * 解决的问题：原引擎只会「响应玩家的指令」，开局又尽是积案、考课这类琐务，
 * 玩家不动，剧情就不动；动起来也是鸡毛蒜皮 —— 于是「无聊」。
 *
 * 做法：每轮掷一个**有分量的戏剧节拍**（dramatic beat）：
 *   · actor    —— 由谁推动（优先用档案里已有的真人/本地人物真名）
 *   · move     —— 他/她做了什么（推进自己的企图，可能与主角利害冲突）
 *   · stakes   —— 这件事的利害（不办会怎样）
 *   · dilemma  —— 摆在主角面前的两难（两条路都要付代价）
 *   · deadline —— 时限或触发条件（拖着不办会更糟）
 *
 * 引擎只负责「给节拍」，具体怎么写由 GM 演。节拍逐轮推进、可与既有线索咬合，
 * 让剧情始终朝有价值的方向走，而不是打转。
 */

/* 每种身份的「有分量的两难」池。都是要人命或要人良心的事，不是公文。 */
const DILEMMAS = {
  emperor: [
    { hook: '军中有人借「清君侧」串联', a: '拆穿他，则可能立刻激变', b: '不拆穿，则他的党羽日盛', stake: '此事拖过旬日，京营将不再听你的话' },
    { hook: '边将杀良冒功的证据就在你手里', a: '问他的罪，北边防线可能当场崩', b: '装不知道，边镇从此信不过你', stake: '他若察觉你已知道，第一件事就是反' },
    { hook: '你宠信之人与宰相的门生私下见过面', a: '当面问他，他会跪下发誓', b: '暗中查他，查到什么都是你的错', stake: '无论怎么选，你都会先失去一个可用之人' },
    { hook: '灾民与外戚的庄子隔一条河', a: '开官仓，则宗室怨你', b: '不开，则三天内必生民变', stake: '米价一日三涨，拖一天就多一批饿死的人' },
  ],
  noble: [
    { hook: '有人拿着你父辈的一封旧信去见了宗正', a: '抢先自辩，则等于承认信有所指', b: '按兵不动，则对方先把话说完', stake: '宗正若信了他，你这一支就贬为庶人' },
    { hook: '你的姻亲在关键时刻改了主意', a: '退婚，两家成仇', b: '忍着，你的儿子就得娶他的女儿', stake: '他想借这门亲事，把你拖进他自己的麻烦里' },
    { hook: '府中死人的事有了第二个人证', a: '拿钱封口，则把柄递到人手', b: '动硬的，则闹大', stake: '人证一旦到了别家手里，你弟弟就得抵命' },
    { hook: '你的门客背着你替人办了一件事', a: '装不知，则事情成了算你的', b: '揭发他，则你的对手先干净', stake: '这件事越晚摊开，越像你自己做的' },
  ],
  official: [
    { hook: '你的座师与他的死敌同时要你「帮个小忙」', a: '帮座师，则得罪当权者', b: '帮当权者，则同门视你为叛', stake: '两边都在等你回话，回晚了就是两边都得罪' },
    { hook: '命案的关键证人昨夜被人接走了', a: '追下去，会查到妻兄', b: '不追，则另一个人替你定罪', stake: '卷宗明日就要上呈，字是你签的' },
    { hook: '上官要你「便宜行事」处置一批人', a: '照办，你手上就沾了血', b: '不办，他就换一个愿意办的人', stake: '你不办，那些人一样会死，只是不用你签字' },
    { hook: '你辖境内的赈粮被上头扣住了', a: '上疏力争，则触怒宰相', b: '私开常平仓，则犯了律', stake: '灾民每日都在死，你的乌纱帽能换多少人活' },
  ],
  warlord: [
    { hook: '你的副将出去见过对头的信使', a: '杀他，则麾下人人自危', b: '留他，则等于睡在他刀口上', stake: '他若真反，你的人头就是投名状' },
    { hook: '军中开始有人问你「什么时候有饭吃」', a: '劫邻郡，则招来官军', b: '降朝廷，则你的部曲要被拆分', stake: '粮只剩十天，十天后不用你选，他们会替你选' },
    { hook: '幕僚夜里来献计，言下之意是让你杀几个人立威', a: '用他的计，则失人心', b: '不用，则众人当你软弱可欺', stake: '城里的富户在等，看你是强是弱再决定交不交粮' },
    { hook: '对头送来你儿子的手指', a: '拿渡口去换，则失天险', b: '不换，则你以后没有儿子', stake: '对方要的是你犹豫这几天，等官兵合围' },
  ],
  commoner: [
    { hook: '征丁轮到你家', a: '让儿子去，多半回不来', b: '花钱打点，则要卖田', stake: '再过三天就截止了，里正已经盯着你家' },
    { hook: '你看见了不该看见的事', a: '报官，则得罪邻里，也未必有人信', b: '装瞎，则以后每晚都睡不安稳', stake: '埋尸的人知道你看过他一眼' },
    { hook: '地契的事说不清了', a: '认亏，则一家没地可种', b: '闹，则你先被押进牢里', stake: '秋前就要落实田界，拖一天你的麦子就少一分' },
    { hook: '里正念错了名字，多给了你家一份粮', a: '认下，则砍手的律条等着你', b: '说破，则得罪里正', stake: '领粮簿上有你按的手印，事后赖不掉' },
  ],
};

/* 「有人自己动起来」的桥段：NPC 按自己的企图行动，制造压力 */
const NPC_MOVES = [
  '他悄悄联络了另一个与你不对付的人',
  '他把一件本该告诉你的事瞒了下来',
  '他借着你的名义办了件你从没答应的事',
  '他开始给自己留后路，把家小送出了城',
  '他当着别人的面，替你说了一句你并不想听的话',
  '他把你私下跟他说的话，说给了另一个人听',
  '他忽然对你格外恭顺，恭顺得反常',
  '他托人向你讨一件你绝不便答应的事',
];

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];

/**
 * 本轮戏剧节拍的「史实锚点」：那件**正在发生的事**必须来自历史底盘，不得凭空造。
 * 取用顺序：① 开放且有史料来源的线索（历史驱动版线索都带 source）
 *          ② 本朝真实大事（eraEvents）
 *          ③ 都没有 → 返回 null，本轮不掷，绝不为了「有戏」而编一件事出来。
 * 这是用户协议的核心：历史局势是主发动机，随机事件只是极低优先级的噪声。
 */
function historyAnchorFor(state, r) {
  const th = (state.threads || []).filter(t => t.status === 'open' && t.source && t.source !== 'unknown');
  if (th.length) {
    const t = th[Math.floor(r() * th.length)];
    return { text: t.title, stakes: t.stance || '', source: t.source };
  }
  const ev = (state.eraEvents || []).filter(Boolean);
  if (ev.length) {
    return { text: ev[Math.floor(r() * ev.length)], stakes: '', source: 'eraEvents' };
  }
  return null;
}

/**
 * 掷一个戏剧节拍。
 * 旧实现：每轮 75% 从 DILEMMAS 池随机抽一个「有人拿你父辈的旧信去见宗正」这类
 *        凭空编造的狗血，再随机塞一个 NPC 进去——即用户明令禁止的「身份匹配+随机事件」。
 * 新实现：① 那件「事」必须来自历史底盘（开放线索 / 本朝大事），查不到就不掷；
 *        ② 触发概率降到约 25%（噪声级，不再是剧情主发动机）；
 *        ③ DILEMMAS 只借用「两难的表达形式」（a/b），hook 与 stake 一律由史实覆盖；
 *        ④ NPC 的动作取他自己在册的目标（agency 台账），不再随机套一个动作。
 * @param state 存档；用 turn 做种子，保证可复现
 */
function rollDrama(state, opts = {}) {
  const idm = state.identityModule || 'official';
  const pool = DILEMMAS[idm] || DILEMMAS.official;
  const turn = state.turn || 0;
  const r = rng(hash(`${state.meta ? state.meta.id : ''}|${turn}|drama`));

  // ① 没有史实可依 → 本轮不掷（绝不凭空造事）
  const anchor = historyAnchorFor(state, r);
  if (!anchor) return null;
  // ② 噪声级触发：约 25%（旧为 75%——那等于把随机当成剧情主发动机）
  if (!opts.force && r() < 0.75) return null;

  // 两难必须与那件事对得上。旧版从 DILEMMAS 池随机抽 a/b，于是「台城被围」配上了
  // 「拆穿他则可能立刻激变」——前言不搭后语，正是用户说的「不合理」。
  // 现在：主角有史实处境矛盾的，两难取该矛盾的「可采取的实际行动」；没有就不给两难，只给情势。
  let d = null;
  try {
    const fig = require('./figure-data');
    const t = fig.tensionAt((state.protagonist || {}).name, Number(state.clock && state.clock.gregorianYear) || 0, state.clock && state.clock.month);
    if (t && (t.actions || []).length >= 2) {
      const acts = t.actions.slice();
      const a = acts.splice(Math.floor(r() * acts.length), 1)[0];
      const b = acts[Math.floor(r() * acts.length)];
      d = { a, b, stake: t.ifUnresolved || '' };
      if (!anchor.stakes) anchor.stakes = t.whyNotResolved;
    }
  } catch (_) { /* 无档案 */ }
  void pool;
  // actor：只用「已结交」的人；远方要人（未结交）不得被拉来当本轮的推动者
  const met = (state.npcs || []).filter(n => n.contact === true || n.source === 'generated' || n.source === 'real-kin' || (n.firstSeenTurn && n.firstSeenTurn > 0));
  const actor = met.length ? pick(r, met) : null;
  // NPC 的动作：用他自己在册的目标（若无则不编，留空由 GM 依史实处理）
  const move = actor && actor.goal ? `他眼下要的是：${actor.goal}` : '';

  return {
    turn,
    identity: idm,
    hook: anchor.text,            // ← 史实，不再来自模板池
    stakes: anchor.stakes || (d && d.stake) || '',
    source: anchor.source,        // 史料来源，便于核查
    dilemma: d ? { a: d.a, b: d.b } : null,
    actor: actor ? { name: actor.name, role: actor.role || '', tie: actor.tie || '', goal: actor.goal || '' } : null,
    actorMove: move,
  };
}

/** 给 GM 的段落 */
function renderDrama(d) {
  if (!d) return '';
  const lines = [
    '=== 本轮戏剧张力（引擎掷出；情势取自历史底盘，须自然织入本轮场景，不得无视） ===',
    `当前情势：${d.hook}。${d.source ? '（来源：' + d.source + '）' : ''}`,
  ];
  if (d.stakes) lines.push(`利害：${d.stakes}。`);
  if (d.dilemma) lines.push(`两难：一边是「${d.dilemma.a}」，另一边是「${d.dilemma.b}」——两条路都有代价；玩家也可以另想办法，但代价须按实情结算。`);
  if (d.actor) lines.push(`推动这件事的人：${d.actor.name}${d.actor.role ? '（' + d.actor.role + '）' : ''}${d.actor.tie ? '，' + d.actor.tie : ''}。他 ${d.actorMove}——**让他按自己的企图行动，不必等主角发问**。`);
  lines.push('要求：经由具体的人带到主角面前（来客、僚佐进言、文书、市井传言），写出具体的人、话与分寸；远方的事只能以已传到的消息或传闻出现。选项留在主角手里，你不替他选。');
  return lines.join('\n');
}

const listDilemmas = () => Object.fromEntries(Object.entries(DILEMMAS).map(([k, v]) => [k, v.map(x => x.hook)]));

module.exports = { rollDrama, renderDrama, listDilemmas, historyAnchorFor, DILEMMAS, NPC_MOVES };
