'use strict';
/**
 * 朝政 / 案牍系统（参照《崇祯模拟器》的玩法：每回合批阅奏报，每个选择都有看得见的数字后果）。
 *
 * 设计要点：
 *   1. 奏报由引擎**按存档里的真实数字**生成（钱粮、粮价、灾情、军心、民心……），不靠大模型编；
 *      没有 AI 也能完整地玩，AI 只负责把批阅结果写成叙事。
 *   2. 每个选项的后果在批阅前就摆在明处（钱 -X、民心 +Y），批完立即入账（四本账留痕）。
 *   3. 四项朝局指标：民心、吏治、威望、匪患（0~100），随赋税、灾荒、钱粮自行变化；
 *      吏治影响钱赋实收，民心与匪患互相牵动——不批不管，局面会自己坏下去。
 *   4. 身份不同，案牍不同：皇帝批奏章，官员看公文，军阀阅军报，平民料理家事。
 */
const { eco, move, post } = require('./economy');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r0 = v => Math.round(v);
const GAUGES = ['民心', '吏治', '威望', '匪患'];

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rnd(state, tag) { let t = hash(`${state.meta ? state.meta.id : ''}|${state.turn || 0}|${tag}`); t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }

function ensureCourt(state) {
  if (state.court && state.court.v === 1) return state.court;
  const idm = state.identityModule || 'official';
  state.court = {
    v: 1,
    民心: 55, 吏治: 50, 威望: idm === 'emperor' ? 55 : idm === 'commoner' ? 30 : 45, 匪患: 25,
    pending: [], history: [], lastTickTurn: state.turn || 0,
  };
  return state.court;
}

/* ---------------- 规模：所有数字随盘子缩放（一县与天下用同一套规则） ---------------- */
function scale(state) {
  const e = eco(state);
  const hh = (e.population && e.population.households) || 1000;
  const troops = (e.military && e.military.total) || 0;
  return {
    hh, troops,
    cashYear: Math.max(20, r0(hh * 0.25)),          // 每户岁纳钱约 0.25 贯（丁口钱、商税、杂课折算的量级）
    payMonth: r0(troops * 0.4),                      // 每兵月饷约 0.4 贯
    grainMonth: r0(troops * 2),                      // 每兵月食约 2 石
    reliefGrain: Math.max(50, r0(hh * 0.3)),         // 赈济：每户约 3 斗
  };
}

/* ---------------- 每回合自行演化 ---------------- */
function tickCourt(state, days) {
  const C = ensureCourt(state);
  const e = eco(state);
  const S = scale(state);
  const months = Math.max(0, (days || 0) / 30);
  if (!months) return [];
  const out = [];
  const tax = e.treasury.taxRate ?? 0.1;
  const disaster = e.agriculture && e.agriculture.disaster && e.agriculture.disaster !== '无';
  const priceRatio = e.market && e.market.grainBaseline ? e.market.grainWenPerShi / e.market.grainBaseline : 1;

  // 钱赋按月实收：吏治越坏，中饱越多（崇祯朝「加派愈多，实入愈少」即此理）
  const collect = clamp(C.吏治 / 65, 0.35, 1.1) * (disaster ? 0.7 : 1) * (tax / 0.1);
  const income = r0(S.cashYear / 12 * months * collect);
  if (income > 0) { move(state, 'cashGuan', '钱', '贯', income, `钱赋杂课实收（吏治${r0(C.吏治)}，实收约${Math.round(collect * 100)}%）`); out.push(`钱赋实收 +${income} 贯`); }
  // 军饷
  if (S.payMonth > 0) {
    const pay = r0(S.payMonth * months);
    const r = move(state, 'cashGuan', '钱', '贯', -pay, `军饷（${S.troops} 人 × ${months.toFixed(1)} 月）`);
    if (r.shortfall) { e.military.morale = clamp((e.military.morale ?? 0.6) - 0.06 * months, 0.1, 1); C.匪患 += 2 * months; out.push(`欠饷 ${-r.shortfall} 贯，军心下滑`); }
  }

  // 民心向目标值缓慢靠拢
  let target = 62 - (tax - 0.1) * 250 - (disaster ? 18 : 0) - Math.max(0, priceRatio - 1) * 35 - Math.max(0, C.匪患 - 50) * 0.3;
  target = clamp(target, 5, 95);
  C.民心 = clamp(C.民心 + (target - C.民心) * Math.min(1, 0.2 * months), 0, 100);
  // 匪患：民心低、灾荒、兵少则起
  const policing = Math.min(1.5, S.troops / Math.max(1, S.hh * 5) * 100);   // 兵多能弹压，但压不住饥民
  C.匪患 = clamp(C.匪患 + months * ((50 - C.民心) / 12 + (disaster ? 2.5 : 0) - policing), 0, 100);
  // 吏治无人整饬便缓慢败坏；威望随民心与匪患浮动
  C.吏治 = clamp(C.吏治 - (C.吏治 > 60 ? 1.2 : 0.6) * months, 0, 100);   // 越清明越难维持
  const wTarget = clamp(50 + (C.民心 - 50) * 0.4 - (C.匪患 - 40) * 0.4 + (C.吏治 - 50) * 0.2, 0, 100);
  C.威望 = clamp(C.威望 + (wTarget - C.威望) * Math.min(1, 0.1 * months), 0, 100);
  // 人口：灾荒与匪患致流亡，太平缓增（tickEconomy 只管太平增长）
  if (disaster || C.匪患 > 60) {
    const lose = r0(e.population.total * 0.004 * months * ((disaster ? 1 : 0) + (C.匪患 > 60 ? 1 : 0)));
    if (lose) { e.population.total -= lose; post(state, 'personnel', { item: '人口', delta: -lose, unit: '口', reason: disaster ? `${e.agriculture.disaster}，流亡死徙` : '匪患，民多逃散', by: '' }); out.push(`流亡 ${lose} 口`); }
  }
  // 未批的奏报过期：留中不发，略损威望
  const stale = C.pending.filter(m => (state.turn || 0) - m.turn >= 2);
  if (stale.length) { C.威望 = clamp(C.威望 - stale.length, 0, 100); C.pending = C.pending.filter(m => !stale.includes(m)); out.push(`${stale.length} 件案牍久置未批`); }
  C.lastTickTurn = state.turn || 0;
  return out;
}

/* ---------------- 奏报模板：条件取自真实数字 ---------------- */
function nouns(state) {
  const idm = state.identityModule || 'official';
  if (idm === 'emperor') return { doc: '奏', from: ['户部', '兵部', '都察院', '某省巡抚', '内阁'], me: '朕' };
  if (idm === 'warlord') return { doc: '军报', from: ['粮台', '中军', '幕府', '探马'], me: '本帅' };
  if (idm === 'commoner') return { doc: '家事', from: ['家人', '里正', '邻里'], me: '我' };
  if (idm === 'noble') return { doc: '禀帖', from: ['管事', '庄头', '门客'], me: '本府' };
  return { doc: '公文', from: ['司户', '县丞', '典史', '上官札付'], me: '本官' };
}
/* 只有真正有官职/职掌的人才会上书、才会被弹劾；主角的妻儿家人不算 */
function officialsOf(state) {
  const pn = String((state.protagonist && state.protagonist.name) || '').replace(/[.*+?^${}()|[\]\\]/g, '');
  const kin = new RegExp(`${pn ? pn + '的?' : '^'}(长|次|幼|嫡|庶|正|继|侧)?(子|女|妻|妾|母|父|兄|弟|姊|妹|侄|孙|婿|媳)|家人|乳母|奴婢|家仆`);
  return (state.npcs || []).filter(x => x && x.name && x.role && x.status !== '死' && !/已故|死/.test(String(x.status || ''))
    && !kin.test(String(x.role)) && !kin.test(String(x.tie || '')) && !/主角的(妻|子|女|父|母|兄|弟|家)/.test(String(x.tie || '')) && !x.relation);
}
function presenter(state, i) {
  const n = nouns(state);
  const officials = officialsOf(state);
  if (officials.length && rnd(state, 'who' + i) < 0.6) {
    const o = officials[Math.floor(rnd(state, 'whom' + i) * officials.length)];
    return `${o.name}（${o.role}）`;
  }
  return n.from[Math.floor(rnd(state, 'from' + i) * n.from.length)];
}

const TEMPLATES = [
  {
    id: 'famine', title: '灾伤请赈', weight: 10,
    when: (s, e) => e.agriculture.disaster && e.agriculture.disaster !== '无',
    build: (s, e, S) => ({
      text: `境内${e.agriculture.disaster}，饥民渐多，粮价已至 ${e.market.grainWenPerShi} 文/石（常年约 ${e.market.grainBaseline}）。请速定赈恤之策。`,
      options: [
        { id: 'relief', label: '开仓赈济', fx: { grain: -S.reliefGrain, 民心: 10, 匪患: -6 } },
        { id: 'remit', label: '蠲免本年赋税三成', fx: { tax: -0.03, 民心: 7, 威望: 2 } },
        { id: 'self', label: '令地方自行筹措', fx: { 民心: -6, 吏治: -3, 匪患: 6 } },
      ],
    }),
  },
  {
    id: 'price', title: '米价腾贵', weight: 7,
    when: (s, e) => e.market.grainBaseline && e.market.grainWenPerShi > e.market.grainBaseline * 1.3,
    build: (s, e, S) => ({
      text: `市上米价 ${e.market.grainWenPerShi} 文/石，较常年高出 ${Math.round((e.market.grainWenPerShi / e.market.grainBaseline - 1) * 100)}%，小民买不起口粮。`,
      options: [
        { id: 'sell', label: '出官仓平粜', fx: { grain: -r0(S.reliefGrain * 0.6), cash: r0(S.reliefGrain * 0.6 * e.market.grainBaseline / 1000), price: -0.15, 民心: 5 } },
        { id: 'cap', label: '出榜限价、禁囤积', fx: { price: -0.08, 民心: 2, 吏治: -2, 威望: 1 } },
        { id: 'none', label: '听其自然', fx: { 民心: -3 } },
      ],
    }),
  },
  {
    id: 'pay', title: '军饷告急', weight: 9,
    when: (s, e, S) => S.troops > 0 && e.treasury.cashGuan < S.payMonth * 2,
    build: (s, e, S) => ({
      text: `库存钱 ${e.treasury.cashGuan} 贯，而 ${S.troops} 名兵每月饷约 ${S.payMonth} 贯，撑不过两月。将士已有怨言。`,
      options: [
        { id: 'levy', label: '加派饷银', fx: { cash: r0(S.cashYear * 0.25), tax: 0.02, 民心: -8, 匪患: 4 } },
        { id: 'cut', label: '裁汰老弱一成', fx: { troopsPct: -0.1, morale: -0.04, 威望: -1 } },
        { id: 'borrow', label: '向富户借贷', fx: { cash: r0(S.payMonth * 3), debt: r0(S.payMonth * 3.6), 威望: -2 } },
      ],
    }),
  },
  {
    id: 'morale', title: '军心不稳', weight: 6,
    when: (s, e, S) => S.troops > 0 && (e.military.morale ?? 0.6) < 0.45,
    build: (s, e, S) => ({
      text: `营中士气低落（约 ${Math.round((e.military.morale ?? 0.6) * 100)}/100），近来时有逃兵。`,
      options: [
        { id: 'reward', label: '发钱犒军', fx: { cash: -r0(S.payMonth * 0.8), morale: 0.12 } },
        { id: 'discipline', label: '整肃军纪，斩逃卒以徇', fx: { morale: 0.04, 威望: 2, 民心: -1 } },
        { id: 'none', label: '暂且不问', fx: { morale: -0.03 } },
      ],
    }),
  },
  {
    id: 'corrupt', title: '吏治败坏', weight: 6,
    when: (s, e, S, C) => C.吏治 < 42,
    build: (s, e, S, C) => ({
      text: `钱赋实收只及应收的${Math.round(clamp(C.吏治 / 65, 0.35, 1.1) * 100)}%，胥吏中饱、层层截留。`,
      options: [
        { id: 'inspect', label: '遣员巡察，黜贪墨', fx: { cash: -r0(S.cashYear * 0.05), 吏治: 9, 威望: 2 } },
        { id: 'example', label: '严办首恶，杀一儆百', fx: { 吏治: 6, 威望: 3, 民心: 2 } },
        { id: 'tolerate', label: '姑且容之，免生事端', fx: { 吏治: -2 } },
      ],
    }),
  },
  {
    id: 'bandit', title: '盗匪蜂起', weight: 9,
    when: (s, e, S, C) => C.匪患 >= 50,
    build: (s, e, S, C) => ({
      text: `境内盗匪日炽（匪患 ${r0(C.匪患)}/100），劫掠乡里，商旅不通。${C.匪患 >= 75 ? '已有聚众攻打城镇之势。' : ''}`,
      options: [
        { id: 'suppress', label: '发兵进剿', fx: { cash: -r0(S.payMonth * 0.6), grain: -r0(S.grainMonth * 0.5), 匪患: -16, morale: -0.03, troopsPct: -0.02 } },
        { id: 'pacify', label: '招抚，给田给粮', fx: { grain: -r0(S.reliefGrain * 0.5), 匪患: -10, 民心: 3, 威望: -1 } },
        { id: 'guard', label: '坚守城池，待其自散', fx: { 匪患: 5, 民心: -3 } },
      ],
    }),
  },
  {
    id: 'surplus', title: '府库有余', weight: 4,
    when: (s, e, S) => e.treasury.cashGuan > S.cashYear * 0.8,
    build: (s, e, S) => ({
      text: `库存钱 ${e.treasury.cashGuan} 贯，足支一年有余。有人请用于地方。`,
      options: [
        { id: 'works', label: '兴修水利', fx: { cash: -r0(S.cashYear * 0.3), 民心: 3, grainPerMu: 0.05 } },
        { id: 'remit', label: '蠲免欠赋', fx: { cash: -r0(S.cashYear * 0.15), 民心: 7, 威望: 2 } },
        { id: 'army', label: '募兵扩军一成', fx: { cash: -r0(S.cashYear * 0.2), troopsPct: 0.1, 匪患: -4 } },
      ],
    }),
  },
  {
    id: 'harvest', title: '秋粮征收', weight: 8,
    when: s => [8, 9].includes(Number(s.clock && s.clock.month)),
    build: (s, e, S, C) => ({
      text: `秋成在即，现行税率${Math.round((e.treasury.taxRate ?? 0.1) * 100)}%，民心 ${r0(C.民心)}。征多则仓实而民怨，征少则反之。`,
      options: [
        { id: 'full', label: '照额足征', fx: {} },
        { id: 'raise', label: '加征（税率加一个百分点）', fx: { tax: 0.01, 民心: -5 } },
        { id: 'lower', label: '减征（税率减一个百分点）', fx: { tax: -0.01, 民心: 5 } },
      ],
    }),
  },
  {
    id: 'impeach', title: '弹章', weight: 3,
    when: s => officialsOf(s).length >= 2 && ['emperor', 'official', 'warlord'].includes(s.identityModule),
    build: (s, e, S, C) => {
      const ns = officialsOf(s);
      const a = ns[Math.floor(rnd(s, 'imp-a') * ns.length)];
      const b = ns.filter(x => x !== a)[Math.floor(rnd(s, 'imp-b') * (ns.length - 1))];
      return {
        text: `有人上书劾${b.name}（${b.role}）「怠职营私」，并牵及${a.name}。所劾之事尚无实据。`,
        options: [
          { id: 'probe', label: '交有司查实再议', fx: { 吏治: 1, cash: -r0(S.cashYear * 0.01) }, npc: { name: b.name, attitude: '惶恐' } },
          { id: 'dismiss', label: '留中不发', fx: { 威望: -1 } },
          { id: 'punish', label: '即行罢斥（无实据）', fx: { 吏治: -2, 威望: 1 }, npc: { name: b.name, attitude: '怨恨' } },
        ],
      };
    },
  },
];

const COMMONER_OK = new Set(['famine', 'price', 'bandit', 'harvest']);

function generate(state) {
  const C = ensureCourt(state);
  const e = eco(state);
  const S = scale(state);
  if (C.pending.some(m => m.turn === (state.turn || 0))) return C.pending;
  const idm = state.identityModule || 'official';
  const have = new Set(C.pending.map(m => m.tpl));
  for (const h of C.history) if ((state.turn || 0) - h.turn < 3 && h.tpl) have.add(h.tpl);
  const cands = TEMPLATES.filter(t => !have.has(t.id) && (idm !== 'commoner' || COMMONER_OK.has(t.id)))
    .filter(t => { try { return t.when(state, e, S, C); } catch { return false; } })
    .map(t => ({ t, score: t.weight + rnd(state, 'pick' + t.id) * 4 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, 3 - C.pending.length));
  const n = nouns(state);
  cands.forEach(({ t }, i) => {
    const b = t.build(state, e, S, C);
    C.pending.push({
      id: `${t.id}-${state.turn || 0}`, tpl: t.id, turn: state.turn || 0, kind: n.doc,
      title: t.title, from: presenter(state, i), text: b.text,
      options: b.options.map(o => ({ ...o, preview: fxText(o.fx) })),
    });
  });
  return C.pending;
}

/* ---------------- 执行后果（全部入账） ---------------- */
function fxText(fx) {
  const parts = [];
  if (fx.cash) parts.push(`钱 ${fx.cash > 0 ? '+' : ''}${fx.cash} 贯`);
  if (fx.grain) parts.push(`粮 ${fx.grain > 0 ? '+' : ''}${fx.grain} 石`);
  if (fx.debt) parts.push(`负债 +${fx.debt} 贯`);
  if (fx.tax) parts.push(`税率 ${fx.tax > 0 ? '+' : ''}${Math.round(fx.tax * 100)}%`);
  if (fx.troopsPct) parts.push(`兵 ${fx.troopsPct > 0 ? '+' : ''}${Math.round(fx.troopsPct * 100)}%`);
  if (fx.morale) parts.push(`军心 ${fx.morale > 0 ? '+' : ''}${Math.round(fx.morale * 100)}`);
  if (fx.price) parts.push(`粮价 ${fx.price > 0 ? '+' : ''}${Math.round(fx.price * 100)}%`);
  if (fx.grainPerMu) parts.push('一年后亩产提高');
  for (const g of GAUGES) if (fx[g]) parts.push(`${g} ${fx[g] > 0 ? '+' : ''}${fx[g]}`);
  return parts.join(' · ') || '无即时变化';
}

function applyFx(state, fx, reason) {
  const C = ensureCourt(state);
  const e = eco(state);
  if (fx.cash) move(state, 'cashGuan', '钱', '贯', fx.cash, reason);
  if (fx.grain) move(state, 'grainShi', '存粮', '石', fx.grain, reason);
  if (fx.debt) { e.treasury.debtGuan = (e.treasury.debtGuan || 0) + fx.debt; post(state, 'finance', { item: '负债', delta: fx.debt, unit: '贯', reason, by: '' }); }
  if (fx.tax) {
    const t = clamp((e.treasury.taxRate ?? 0.1) + fx.tax, 0.02, 0.4);
    e.treasury.taxRate = t; if (e.revenue) e.revenue.taxRate = t;
    post(state, 'finance', { item: '税率', delta: fx.tax, unit: '', reason, by: '' });
  }
  if (fx.troopsPct && e.military.total) {
    const d = r0(e.military.total * fx.troopsPct);
    e.military.total += d; e.military.combat = r0(e.military.total * 0.7); e.military.aux = e.military.total - e.military.combat;
    post(state, 'military', { item: '兵员', delta: d, unit: '人', reason, by: '' });
  }
  if (fx.morale) e.military.morale = clamp((e.military.morale ?? 0.6) + fx.morale, 0.05, 1);
  if (fx.price && e.market) e.market.grainWenPerShi = r0(e.market.grainWenPerShi * (1 + fx.price));
  if (fx.grainPerMu && e.population) { e.population.grainPerMu = +(e.population.grainPerMu * (1 + fx.grainPerMu)).toFixed(3); e.population.annualGrainShi = r0(e.population.farmlandMu * e.population.grainPerMu); }
  for (const g of GAUGES) if (fx[g]) C[g] = clamp(C[g] + fx[g], 0, 100);
}

function decide(state, memorialId, optionId) {
  const C = ensureCourt(state);
  const m = C.pending.find(x => x.id === memorialId);
  if (!m) return { ok: false, why: '这件案牍已经处理过或已过期。' };
  const o = m.options.find(x => x.id === optionId);
  if (!o) return { ok: false, why: '没有这个选项。' };
  applyFx(state, o.fx, `${m.title}：${o.label}`);
  if (o.npc) {
    const n = (state.npcs || []).find(x => x.name === o.npc.name);
    if (n) n.attitude = o.npc.attitude;
  }
  C.pending = C.pending.filter(x => x !== m);
  C.history.push({ turn: state.turn || 0, tpl: m.tpl, title: m.title, from: m.from, choice: o.label, effects: o.preview });
  if (C.history.length > 120) C.history = C.history.slice(-120);
  return { ok: true, text: `${m.title}：${o.label}（${o.preview}）` };
}

/* ---------------- 给 GM 的提示（只叙其事，不得改数字） ---------------- */
function renderCourt(state) {
  const C = ensureCourt(state);
  const recent = C.history.filter(h => h.turn >= (state.turn || 0) - 1);
  const lines = [`=== 朝局指标（引擎计算，正文不得改动数字） ===`,
    `民心 ${r0(C.民心)} / 吏治 ${r0(C.吏治)} / 威望 ${r0(C.威望)} / 匪患 ${r0(C.匪患)}（0~100）`];
  if (recent.length) {
    lines.push('玩家近来批阅的案牍（这些决定已经生效、已入账，本轮正文要写出它们在人身上的回响，不要再让玩家重新决定）：');
    for (const h of recent) lines.push(`· ${h.title}（${h.from}）→ ${h.choice}；后果：${h.effects}`);
  }
  if (C.匪患 >= 70) lines.push('匪患已重：本轮场景里应有盗匪活动的迹象（不必是大战）。');
  if (C.民心 <= 25) lines.push('民心极低：百姓对官府冷淡乃至敌视，应在人物言行里体现。');
  return lines.join('\n');
}

function view(state) {
  const C = ensureCourt(state);
  return {
    gauges: Object.fromEntries(GAUGES.map(g => [g, r0(C[g])])),
    pending: C.pending.map(m => ({ id: m.id, title: m.title, from: m.from, kind: m.kind, text: m.text, options: m.options.map(o => ({ id: o.id, label: o.label, preview: o.preview })) })),
    history: C.history.slice(-10).reverse(),
  };
}

module.exports = { ensureCourt, tickCourt, generate, decide, renderCourt, view, applyFx, fxText, TEMPLATES, GAUGES };
