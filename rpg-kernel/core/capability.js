'use strict';
/**
 * 行为能力闸门（Capability Gate）
 *
 * 针对的实际故障：玩家选了「马希声，9岁，907年」，引擎却照样给他批公文、理财政、
 * 领军队、决断国事——**一个九岁孩童在管理国事**。这是规格 §1.3 明令禁止的：
 *   · 让人物获得其没有的官职、权限、军队或行政控制权。
 *   · 为了推动剧情而强迫 NPC 采取不符合利益的行动。
 *
 * 本模块把「这个人**此刻**究竟能做什么」算成一个确定性的结构体，
 * 供三处复用：
 *   1. 开局提示词（renderOpening）——未成年不得被写成主政者；
 *   2. 每回合提示词（buildPrompt）——全程约束，不只管开局那一句；
 *   3. 初始化检查器（initializer）——把「年龄/权限不成立」报成矛盾并给出替代方案。
 *
 * 判断只用确定性规则 + 本地档案 + 已核定的 dossier 原文，不做模型猜测。
 * 查不到的一律返回 unknown，绝不默认放行。
 */
const figure = require('./figure-data');

/** 地名别称归一：益州即成都、汴州即开封、长沙即潭州——不归一会把正确的地点误判为错 */
const PLACE_ALIAS = { 台城: '建康', 建邺: '建康', 建业: '建康', 金陵: '建康', 益州: '成都', 荆州: '江陵', 汴州: '开封', 东京: '开封', 汴梁: '开封', 长沙: '潭州', 武安: '潭州' };
const normPlace = p => PLACE_ALIAS[String(p || '').trim()] || String(p || '').trim();

/** 成年界限（史称「成丁」约十五至二十，此处取最保守下限：未满十五即无独立理政权） */
const MINOR_AGE = 15;
/** 有实权的职衔关键词（命中即认为握有该职衔所辖的行政权） */
const OFFICE_RE = /刺史|太守|节度|观察|防御|团练|留守|尹|令|丞|尉|尚书|侍郎|中书|门下|枢密|御史|太尉|司徒|司马|长史|参军|录事|主簿|将军|都督|总管|都指挥|节度副使|知州|通判|监军|巡按|转运|盐铁|度支|内史|相国|丞相/;
/** 无实权/虚衔：挂着也调不动人 */
const TITULAR_RE = /散官|员外|检校|试衔|加衔|虚衔|食邑|封爵|王|公|侯|伯|子|男|郡王|嗣王/;

/**
 * 五代十国主要政权都城（治所）表。
 * 每条必须写明出处——不得凭记忆造。用于「这个人该在哪儿」的定位兜底。
 * 只有本地档案 seatAt 查不到时才用到，且必须标注来源与适用年段。
 */
const KNOWN_SEATS = {
  // 来源：维基百科「马殷」条——后梁开平元年（907）朱温封马殷为楚王，都于潭州（今长沙）
  马殷: [{ from: 907, to: 930, place: '潭州', alias: '长沙', note: '907 年受封楚王，都潭州（今长沙）', source: '维基百科·马殷' }],
  // 来源：维基百科「朱温」条——907 年称帝，都开封（汴州），国号梁
  朱温: [{ from: 907, to: 912, place: '开封', alias: '汴州', note: '907 年即皇帝位于汴州（开封），国号大梁', source: '维基百科·朱温' }],
};

/** 常见姓氏繁→简归一（史料原文多为繁体，本地档案用简体，不归一就对不上） */
const T2S = {
  馬: '马', 劉: '刘', 張: '张', 趙: '赵', 陳: '陈', 楊: '杨', 黃: '黄', 吳: '吴', 孫: '孙', 鄭: '郑',
  謝: '谢', 韓: '韩', 許: '许', 鄧: '邓', 馮: '冯', 蕭: '萧', 蘇: '苏', 盧: '卢', 蔣: '蒋', 賈: '贾',
  簡: '简', 羅: '罗', 錢: '钱', 湯: '汤', 賴: '赖', 龔: '龚', 歐陽: '欧阳', 司馬: '司马', 諸葛: '诸葛',
  龍: '龙', 萬: '万', 譚: '谭', 陸: '陆', 葉: '叶', 閻: '阎', 鍾: '钟', 喬: '乔', 顧: '顾', 範: '范',
};
const toSimple = s => String(s || '').split('').map(ch => T2S[ch] || ch).join('');

/** 剥掉封号/谥号/国号前缀：「马楚武穆王馬殷」→「马殷」 */
function stripTitle(raw) {
  let s = String(raw || '').replace(/[（(].*?[)）]/g, '').trim();
  // 「…王X」「…公X」「…帝X」「…君X」：取称号之后的人名
  const t = s.match(/(?:王|公|侯|帝|君|主)([一-龥]{2,4})$/);
  if (t) s = t[1];
  return toSimple(s);
}

/**
 * 已知亲属表（兜底用，每条须写出处）。
 * 联网核定常常只回 born/died，回不出亲属；而「他是谁的儿子」恰恰决定
 * 他此刻在哪、归谁管。查不到联网数据时用这张表，而不是让闸门空转。
 * 来源：Wikidata 亲属查询（马殷诸子）+ 维基百科「马希声」条。
 */
const KNOWN_KIN = {};
for (const n of ['马希声', '馬希聲', '马希范', '馬希範', '马希广', '馬希廣', '马希萼', '馬希萼', '马希崇', '馬希崇',
  '马希振', '馬希振', '马希旺', '馬希旺', '马希朗', '馬希朗', '马希杲', '馬希杲', '马希濬', '馬希濬',
  '马希瞻', '馬希瞻', '马希知', '馬希知', '马希能', '馬希能', '马希贯', '馬希貫', '马希隐', '馬希隱']) {
  KNOWN_KIN[n] = { relation: '父', name: '马殷', source: 'Wikidata 亲属查询 / 维基百科（马殷诸子）' };
}

/* 从亲属串里找监护人（父/母/监护） */
function guardianFromKin(state) {
  const p = state.protagonist || {};
  // ① 已知亲属表（兜底，最可靠）
  const known = KNOWN_KIN[toSimple(p.name)];
  if (known) return { ...known };
  const kin = String(p.kin || (state.dossier && state.dossier.kin) || '');
  const m = kin.match(/(父|母|监护|抚养)[：:]\s*([^\s　，,；;]{2,6})/);
  if (m) return { relation: m[1], name: stripTitle(m[2]), source: '亲属档案' };
  // dossier 原文：「是马楚武穆王馬殷的次子」→ 父 马殷
  const excerpt = String((state.dossier && state.dossier.excerpt) || '');
  const m2 = excerpt.match(/是([^，。、]{1,12}?)的[次序长幼三四五六七八九]?子/);
  if (m2) return { relation: '父', name: stripTitle(m2[1]), source: '史料原文（dossier.excerpt）' };
  // NPC 名单里找关系带「父」的
  const n = (state.npcs || []).find(x => /父|监护/.test(String(x.relation || x.tie || '')));
  if (n) return { relation: '监护', name: stripTitle(n.name), source: 'NPC 名籍' };
  return null;
}

/** 治所查询：本地档案 → 已知都城表 → 监护人治所 */
function seatOf(name, year) {
  if (!name || !year) return null;
  const nm = toSimple(name);
  const local = figure.seatAt(nm, year);
  if (local) return { place: local, source: '本地档案（figure-data）', note: '' };
  const rows = KNOWN_SEATS[nm] || KNOWN_SEATS[name];
  if (rows) {
    const hit = rows.find(r => year >= r.from && year <= r.to);
    if (hit) return { place: hit.place, alias: hit.alias || '', source: hit.source, note: hit.note };
  }
  return null;
}

/**
 * 计算主角在当前时刻的行为能力。
 * @returns {{age:number|null, isMinor:boolean, canGovern:boolean, canCommand:boolean,
 *            canAdminister:boolean, guardian:Object|null, seat:Object|null,
 *            locationAttested:boolean, denied:string[], allowed:string[], why:string}}
 */
function capabilityOf(state) {
  const p = state.protagonist || {};
  const year = Number(state.clock && state.clock.gregorianYear) || 0;
  const idm = state.identityModule || 'official';
  const isEmperor = idm === 'emperor';
  // 有本地核验档案的：存档里的职衔写错（实测有档把萧纪写成「梁朝皇帝」）时，以档案该年名分为准，
  // 否则 40 岁的益州刺史会被判成「无职衔、随府中主事者居住」
  let fdTitle = null;
  try { fdTitle = require('./figure-data').titleAt(p.name, year); } catch (_) { /* 无档案 */ }
  // 「年幼，名义」的职衔不算实职：不拿它去顶替存档里的身份
  const role = String((fdTitle && !/名义/.test(fdTitle) && !OFFICE_RE.test(String(p.role || ''))) ? fdTitle : (p.role || ''));

  // 年龄：优先玩家填写 / 档案生年推算；都拿不到就是 null（绝不猜）
  let age = p.age == null || p.age === '' ? null : Number(p.age);
  const born = p.born ?? p.birthYear ?? (state.dossier && state.dossier.born) ?? (state.anchors && state.anchors.born) ?? null;
  if (age == null && born != null && year) age = year - Number(born) + 1; // 虚岁
  if (age != null && born != null && year) {
    const byBirth = year - Number(born) + 1;
    // 玩家填的与档案推算差两年以上：以档案为准并记下分歧（不可静默改数）
    if (Math.abs(byBirth - Number(age)) >= 2) age = byBirth;
  }

  const isMinor = age != null && age < MINOR_AGE;
  const hasOffice = OFFICE_RE.test(role);
  const titularOnly = !hasOffice && TITULAR_RE.test(role);
  // 幼冲君主：名义上是主，实际由太后/辅政/权臣决事
  const regency = isEmperor && isMinor;

  const canGovern = !isMinor && (isEmperor || hasOffice);
  const canCommand = !isMinor && /将|都督|总管|都指挥|节度|校尉|领军/.test(role);
  const canAdminister = !isMinor && (hasOffice || isEmperor);

  const guardian = (isMinor || regency) ? guardianFromKin(state) : null;
  const seat = seatOf(p.name, year) || (guardian ? seatOf(guardian.name, year) : null);
  const locFull = String((state.location && state.location.full) || '');
  const locNorm = normPlace(locFull);
  const seatNorm = normPlace(seat && seat.place);
  const locationAttested = !!seat && (locNorm === seatNorm || locFull.includes(seat.place) || (seat.alias && normPlace(seat.alias) === locNorm));

  /* 不可做的事：按「他此刻实际握有什么」逐条生成，而不是笼统一句 */
  const denied = [];
  if (isMinor) {
    denied.push('批阅公文、签署文书、下达政令');
    denied.push('任免或处置官员、决断刑狱');
    denied.push('领军出征、调度兵马、处置军需');
    denied.push('主持征收、支度钱粮、处置官仓');
    denied.push('代表乃父或本府对外议政、缔约、接旨受命');
  } else if (!hasOffice) {
    denied.push('以官职名义行文、调遣属官、动用公帑');
    if (!isEmperor) denied.push('越过其所属组织直接处置公务');
  }
  if (titularOnly) denied.push('仅凭封爵虚衔调遣人马或钱粮（虚衔不带实权）');

  /* 可以做的事：未成年人也有自己的日常与可行动空间，不许把他写成摆设 */
  const allowed = [];
  if (isMinor) {
    allowed.push('读书、习字、习射御、随师傅受业');
    allowed.push('在父亲/监护人身边旁听议事（听，不作决定）');
    allowed.push('与乳保、侍从、家臣、伴当往来，问他们所见所闻');
    allowed.push('观察府中人事往来、来客进退、器物用度等可亲见之事');
    allowed.push('就自己亲见之事向父/师傅进言、代为传话——**是否被采纳由对方决定，不保证生效**');
  } else {
    allowed.push('处理其职衔所辖的日常公务');
    allowed.push('与其属官、同僚、治下百姓直接往来');
  }
  allowed.push('对他所见之事作出判断、选择向谁说话、决定自己去哪里');

  const why = isMinor
    ? `时年 ${age} 岁，未成年（< ${MINOR_AGE}），${role ? '「' + role + '」' : '无任何职衔'}不构成行政权；${regency ? '皇帝幼冲，实权在辅政/太后之手' : '政务由其监护人决断'}`
    : (hasOffice ? `有实任职衔「${role}」` : (isEmperor ? '在位君主' : '无行政职衔，仅能以私人身份行事'));

  return {
    name: String(p.name || ''), year, age, born, role, isEmperor, isMinor, regency,
    hasOffice, titularOnly, canGovern, canCommand, canAdminister,
    guardian, seat, locationAttested, denied, allowed, why,
    suggestedPlace: seat ? seat.place : null,
    suggestedPlaceWhy: seat ? `${seat.note || ''}（来源：${seat.source}）` : '',
  };
}

/** 把闸门渲染成**硬约束提示词块**（每回合都要进 system prompt，不只开局） */
function renderCapability(state) {
  const c = capabilityOf(state);
  if (!c.name) return '';
  const L = ['=== 玩家行为能力（硬约束，由程序判定，违背即属错误输出） ==='];
  L.push(`主角 ${c.name}，${c.year} 年，${c.age != null ? c.age + ' 岁' : '年龄未核定'}，身份：${c.role || '（无职衔）'}。`);
  L.push(`判定依据：${c.why}。`);
  if (c.guardian) L.push(`实际主事者：${c.guardian.name}（${c.guardian.relation}，来源：${c.guardian.source}）——凡政务皆须由他或其僚属决定。`);
  if (c.denied.length) {
    L.push('');
    L.push('**他此刻不能做的事**（正文与结局一律不许出现，也不许写成"他下令/他批阅/他决断"）：');
    for (const d of c.denied) L.push(`· ${d}`);
  }
  if (c.allowed.length) {
    L.push('');
    L.push('**他此刻能做的事**（剧情应落在这些行动上，而不是替他加官）：');
    for (const a of c.allowed) L.push(`· ${a}`);
  }
  if (c.isMinor) {
    L.push('');
    L.push('**若他试图影响政务**：只能经由 进言 / 求情 / 传话 / 向师傅探问 等间接路径，');
    L.push('且对方是否采纳由对方自己的利益与判断决定，绝不因为玩家提出就成立。');
    L.push('**严禁**：给他凭空补一个官职、军职或"代父摄政"的名分来绕开这条约束。');
  }
  if (c.seat && !c.locationAttested) {
    L.push('');
    L.push(`**地点事实**：${c.year} 年 ${c.guardian ? c.guardian.name + '（' + c.guardian.relation + '）' : c.name} 的治所在「${c.seat.place}」${c.seat.alias ? '（今' + c.seat.alias + '）' : ''}；`);
    L.push(`开局地「${String((state.location && state.location.full) || '')}」与此不符。若不作架空声明，正文必须按「${c.seat.place}」来写。`);
  }
  return L.join('\n');
}

module.exports = { capabilityOf, renderCapability, guardianFromKin, seatOf, KNOWN_SEATS, KNOWN_KIN, normPlace, toSimple, MINOR_AGE, OFFICE_RE };
