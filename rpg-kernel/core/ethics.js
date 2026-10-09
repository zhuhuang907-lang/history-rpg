'use strict';
/**
 * 时代伦理底表（起步版，2026-10-08）。
 *
 * 目的：让人物的是非观、代价、说话方式符合当时，而不是现代人穿古装。
 * 做法分两半：
 *   ① ERA_ETHICS：每个时代「理所当然的」与「不会出现的」观念，按身份给出立场差异；
 *   ② checkEthics()：正文里出现后世观念/词汇即报（plot.checkText 第 18 项）。
 * 目前只录了「南朝梁」；其他时代暂走 GENERIC（只查后世词汇）。往后按同样结构补。
 */

/* 后世观念与词汇：古人不会这样想、这样说（命中即报） */
const MODERN = [
  { re: /人权|民主|自由平等|人人平等|生而平等|平等权利/, why: '现代平权观念' },
  { re: /自由恋爱|婚姻自由|恋爱自由/, why: '现代婚恋观' },
  { re: /个人主义|自我实现|实现自我|人格独立/, why: '现代个人观念' },
  { re: /封建(社会|迷信|礼教|糟粕)|剥削阶级|阶级斗争|地主阶级|农民阶级/, why: '后世史学/政治术语' },
  { re: /民族主义|爱国主义|中华民族/, why: '近代民族国家观念' },
  { re: /科学(地|的方法)|迷信思想|唯物|唯心/, why: '近代科学/哲学话语' },
  { re: /男女平等|女权|性别歧视/, why: '现代性别观念' },
  { re: /法治社会|宪法|公民权|纳税人/, why: '近代政治观念' },
];

const ERA_ETHICS = {
  梁: {
    label: '南朝梁（502–557）',
    // 当时理所当然、不必辩护的
    given: [
      '君臣父子之名分高于一切：子不救父难、臣不赴君难，是终身的污名（萧纪「不赴援」即被史家如此评断）',
      '门第决定仕途：士族与寒人清浊分途，寒人得势会被视为「幸进」',
      '宗室诸王各领重镇，兄弟相争以「承制」「讨逆」为名分，而非以对错论',
      '佛教极盛，舍身、造寺、斋戒为美德；同时杀伐与崇佛并存不以为怪',
      '部曲、奴婢、僮仆依附主家是常态；连坐、族诛是常规刑罚',
      '妇女以贞节、从夫为德，婚姻由家族议定，门当户对',
    ],
    // 人物说理时的口径（按身份）
    voices: {
      宗室: '讲名分、孝道、祖宗基业；忌讳「僭越」与「不孝」之名',
      士族: '讲门第、清议、礼法；看不起寒人与武人',
      寒人武将: '讲功劳、恩遇、实利；投靠强者不以为耻',
      僧人: '讲因果、慈悲、护法；劝人止杀但不触名分',
      百姓: '讲收成、赋役、平安；对朝廷大事只知传言',
    },
  },
};

function eraOf(state) {
  const p = (state && state.location && state.location.polity) || '';
  return ERA_ETHICS[p] || null;
}

/** 正文检查：后世观念。返回 [{no:18, name, why}] */
function checkEthics(state, text) {
  const T = String(text || '');
  const out = [];
  for (const m of MODERN) {
    const hit = T.match(m.re);
    if (hit) out.push({ no: 18, name: '时代观念检查', why: `出现「${hit[0]}」（${m.why}），不合${(eraOf(state) || {}).label || '当时'}人的想法与说法`, arc: null });
  }
  return out;
}

/** 给 GM 的短块：本时代的伦理底色（只在有底表时给，不长篇说教） */
function renderEthics(state) {
  const e = eraOf(state);
  if (!e) return '';
  return [
    `=== 时代伦理（${e.label}；人物的是非、代价与措辞须按此，不得用现代观念评判或说话） ===`,
    ...e.given.map(g => `· ${g}`),
    '· 各色人等说理的口径：' + Object.entries(e.voices).map(([k, v]) => `${k}——${v}`).join('；'),
  ].join('\n');
}

module.exports = { ERA_ETHICS, MODERN, checkEthics, renderEthics, eraOf };
