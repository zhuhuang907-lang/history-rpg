'use strict';
/**
 * 真实人物档案核定
 *
 * 用户的核心诉求：
 *   「你不能通过真实人物的搜索信息来给其适配身份 —— 身份、年龄、位置、事件，都应该按搜索的来。」
 *
 * 所以这个模块做的事是：**搜到什么，就按什么填**，不靠模型临场编。
 *   1. 先搜索（配置的检索后端 / 维基百科正文）拿到这个人的真实记载
 *   2. 从记载里抽取：生年、卒年 → 年龄；朝代 + 官职/身份 → 身份；籍贯；所处地；同时代事件
 *   3. 与 Wikidata 的结构化生卒年交叉验证，冲突时以「有出处的那条」为准并记下来
 *   4. 查无此人 → 明确返回 found:false，绝不拿一个编造的身份糊弄过去
 *
 * 抽取是保守的：抽不出来就留空并标「未核实」，绝不猜。
 */

const { search } = require('../adapters/search');
const { sparql } = require('../adapters/search');
const { wikiExtract } = require('./geo');
const { yearOf } = require('./reign');

/* ============================ 文本抽取 ============================ */

/* 公元 / 公元前年份：「前284年」「公元前284年」「284年」 */
function parseYear(s) {
  if (s == null) return null;
  const t = String(s);
  let m = t.match(/(?:公元)?前\s*(\d{2,4})\s*年/);
  if (m) return -Number(m[1]);
  m = t.match(/(?:公元)?\s*(\d{3,4})\s*年/);
  if (m) return Number(m[1]);
  return null;
}

/* 日期片段：年、年月、年月日。「1007年8月6日」这种带月日的也要能整段吃掉 */
const DATE = '(?:公元)?前?\\s*\\d{2,4}\\s*年(?:\\s*\\d{1,2}\\s*月(?:\\s*\\d{1,2}\\s*日)?)?';

/* 生卒年：常见写法「（约前284年－前208年）」「（284年—208年）」「（?-208）」「（1007年8月6日－1072年9月22日）」 */
function parseLifeSpan(text) {
  const t = String(text || '').slice(0, 400);   // 生卒一般就在开头
  const m = t.match(new RegExp(`[（(]\\s*(?:约)?\\s*(${DATE}|\\?)\\s*[－\\-—~至到]\\s*(${DATE}|\\?)\\s*[)）]`));
  if (m) return { born: parseYear(m[1]), died: parseYear(m[2]), raw: m[0] };
  // 单行写法：「李斯，战国末期至秦朝政治家，公元前284年生」
  const b = t.match(/(?:生于|出生于)\s*((?:公元)?前?\s*\d{2,4})\s*年/);
  const d = t.match(/(?:卒于|死于|逝于)\s*((?:公元)?前?\s*\d{2,4})\s*年/);
  if (b || d) return { born: b ? parseYear(b[1]) : null, died: d ? parseYear(d[1]) : null, raw: (b || d)[0] };
  return { born: null, died: null, raw: '' };
}

/* 身份词：这是「他是干什么的」的答案。按可信度排序，命中越靠前越可信。 */
const ROLE_PAT = [
  /(丞相|宰相|太尉|御史大夫|廷尉|少府|郎中令|卫尉|太仆|宗正|大鸿胪|大司农|少府卿)/,
  /(太守|郡守|刺史|州牧|县令|县长|县丞|县尉|主簿|功曹|别驾|治中|长史|司马|参军)/,
  /(节度使|观察使|转运使|安抚使|经略使|布政使|按察使|巡抚|总督|知府|知州|知县|通判|同知)/,
  /(大将军|将军|校尉|都尉|中郎将|都督|总兵|副将|参将|游击|守备|千户|万户)/,
  /(皇帝|天子|大王|诸侯王|郡王|亲王|太子|皇后|太后|丞相)/,
  /(尚书|侍郎|郎中|员外郎|给事中|中书舍人|翰林学士|御史|谏议大夫|大学士|内阁首辅)/,
  /(政治家|军事家|文学家|诗人|词人|书法家|画家|史学家|哲学家|思想家|教育家|医学家|科学家|数学家|天文学家)/,
  /(谋士|幕僚|门客|食客|游侠|刺客|隐士|名士|学者|僧人|道士|方士|宦官|外戚|权臣|名臣|循吏|酷吏)/,
  /(起义军领袖|义军首领|民变领袖|军阀|割据|豪强|世族|士族|商贾|工匠|农夫|牧民)/,
];
/* 修饰语：朝代 / 时期 */
const DYNASTY_PAT = /(西汉|东汉|新朝|秦朝|秦国|战国|春秋|西周|东周|商朝|夏朝|三国|曹魏|蜀汉|孙吴|西晋|东晋|南北朝|北魏|南梁|南陈|北齐|北周|隋朝|隋|唐朝|唐|五代|后梁|后唐|后晋|后汉|后周|北宋|南宋|宋|辽|金|西夏|元朝|元|明朝|明|清朝|清)/;

function parseRole(text, name) {
  const t = String(text || '').slice(0, 300);
  const dy = (t.match(DYNASTY_PAT) || [])[1] || '';
  for (const re of ROLE_PAT) {
    const m = t.match(re);
    if (m) {
      // 「官至丞相」「拜为上卿」这类带动词的更可信
      const withVerb = t.match(new RegExp(`(?:官至|拜为?|迁为?|升为?|擢为?|封为?|授为?|累迁至?|曾任|历任)\\s*${m[1]}`));
      const role = withVerb ? m[1] : m[1];
      return { role: dy ? `${dy}${role}` : role, via: withVerb ? '正文「官至/拜/迁」' : '正文', dynasty: dy };
    }
  }
  return { role: '', via: '', dynasty: dy };
}

/* 籍贯 / 出生地。
   坑：以前用「(.{2,8})(?:国|州|...)?人[，,]。」这种贪心写法，会把「为秦相吕不韦的舍人，」
   里的「为秦相吕不韦的舍」当成籍贯。现在改成一组**由窄到宽**的定式，并对结果做过滤。 */
const NATIVE_PATS = [
  /([\u4e00-\u9fa5]{2,6})县?\s*[（(]今[^）)]{0,30}[)）]\s*(?:人氏|人)/,       // 齐州章丘县（今河南省…）人
  /([\u4e00-\u9fa5]{2,6}(?:县|州|郡|府|道|路|乡|里|村|城))\s*(?:人氏|人)/,  // 齊州人 / 上蔡县人
  /(?:籍贯|祖籍|世居)\s*([\u4e00-\u9fa5]{2,6})/,
  /(?:出生于|生于)\s*([\u4e00-\u9fa5]{2,6})(?:县|州|郡|府)?/,
];
/* 明显不是地名的东西（多是定语或动词短语被误吞） */
const NOT_PLACE = /(的|之|舍|相|将|军|师|父|子|弟|兄|妻|夫|家|门|客|族|党|众|人)$/;
function parseNative(text) {
  const t = String(text || '').slice(0, 400);
  for (const re of NATIVE_PATS) {
    const m = t.match(re);
    if (!m) continue;
    const v = String(m[1]).trim();
    // 「中国人」「秦朝人」这类太泛，没有定位价值
    if (!v || NOT_PLACE.test(v)) continue;
    if (/^(中国|本朝|当朝|唐朝|宋朝|明朝|秦朝|汉朝|楚国|秦国)$/.test(v)) continue;
    return v;
  }
  return '';
}

/* 所处地：他在哪儿做事。取职衔里的地名，或正文里的任职地。
   安全策略：被动词带出的地名必须满足「以行政区划字结尾（县/州/府/郡/城/京/都…）」
   或「是已知的历史名城/大区（长安/洛阳/益州/淮南…）」之一；否则「参知政事」会被吞成「政事」、
   「领导者之一」会被吞成「导者之一」、「落草为寇」会被吞成「落草」。 */
const PLACE_WORDS = '长安|洛阳|汴京|临安|金陵|建康|燕京|大都|上都|江都|成都|襄阳|邺城|姑苏|会稽|广陵|彭城|寿春|涿郡|晋阳|凤翔|兴庆|河中|丹阳|历阳|庐州|荆州|益州|并州|幽州|雍州|扬州|青州|徐州|冀州|兖州|豫州|凉州|秦州|蜀郡|吴郡|河东|河南|河北|山东|山西|淮南|江南|岭南|朔方|陇右|剑南|山南|关内';
const PLACE_AFTER_VERB = new RegExp('(?:出镇|出任|迁往|徙于|镇守|刺史|太守|都督|知州|县令|治|守|刺|知|镇|据|屯|驻|督|巡|领)\\s*([\\u4e00-\\u9fa5]{2,4}(?:县|州|府|郡|城|京|都|关|邑|阳)|' + PLACE_WORDS + ')');
const PLACE_AFTER_POST = new RegExp('([\\u4e00-\\u9fa5]{2,4}(?:县|州|府|郡|城|京|都|关|邑|阳))\\s*(?:任|为|太守|刺史|县令|知州|知府|通判)');
const PLACE_TITLE = /^(刺史|太守|都督|知州|县令|县尉|通判|知府|节度使|将军|校尉)$/;
// 地名不会含这些虚词；含之者说明是把正文里的「领导者之一」「据某某说」误吞了
const PLACE_GUARD = /[者之其一以而为何的也曰于等并及内中外上下]/;
function parsePlace(text) {
  const t = String(text || '').slice(0, 600);
  const m = t.match(PLACE_AFTER_VERB);
  if (m && !PLACE_TITLE.test(m[1]) && !PLACE_GUARD.test(m[1])) return m[1];
  const m2 = t.match(PLACE_AFTER_POST);
  if (m2 && !PLACE_TITLE.test(m2[1]) && !PLACE_GUARD.test(m2[1])) return m2[1];
  return '';
}

/* 同时代事件：正文里带年份的短句，作为开局可用的真实事件 */
function parseEvents(text, year) {
  const t = String(text || '');
  const out = [];
  const re = /([^。；;\n]{0,40}(?:公元前)?前?\s*\d{2,4}\s*年[^。；;\n]{0,60})/g;
  let m;
  while ((m = re.exec(t)) && out.length < 8) {
    const s = String(m[1]).trim();
    if (s.length < 8) continue;
    const y = parseYear(s);
    // 只留开局前后 30 年内的，太远的跟这一局没关系
    if (y != null && year && Math.abs(y - year) <= 30) out.push({ year: y, text: s.slice(0, 70) });
    else if (y == null && out.length < 4) out.push({ year: null, text: s.slice(0, 70) });
  }
  return out.slice(0, 6);
}

/* ============================ 主流程 ============================ */

/**
 * 核定一个人。
 * @param {string} name 姓名
 * @param {number} year 开局公元年（用来算年龄、筛事件）
 * @param {string} polity 政权/朝代提示（用来消歧）
 */
async function identify(name, year, polity = '') {
  const nm = String(name || '').trim();
  const Y = Number(year) || 0;
  if (!nm) return { found: false, why: '没有姓名' };

  const sources = [];
  let text = '';

  // ① 维基百科正文（最全的一段生平，抽取的主要来源）
  try {
    const wx = await wikiExtract(nm);
    if (wx && wx.extract) { text = wx.extract; sources.push({ label: '维基百科', provider: 'wikipedia', title: wx.title, url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(wx.title)}` }); }
  } catch (e) { /* 忽略 */ }

  // ② 配置的检索后端（博查等）：拿到更多说法，也能验证上面的正文
  let searchHit = null;
  try {
    const r = await search(`${nm} ${polity || ''} 生平 生卒`, { noCache: false });
    const hits = (r.results || []).filter(h => String(h.title || '').includes(nm) || String(h.snippet || '').includes(nm));
    if (hits.length) {
      searchHit = hits[0];
      sources.push({ label: '检索', provider: r.provider, title: searchHit.title, url: searchHit.url, snippet: String(searchHit.snippet || '').slice(0, 120) });
      const blob = hits.slice(0, 3).map(h => `${h.title}：${h.snippet}`).join('\n');
      if (!text || text.length < 80) text = blob;
      else text += '\n' + blob;
    }
  } catch (e) { /* 忽略 */ }

  // ③ Wikidata 结构化生卒年 / 性别（交叉验证）
  let wd = null;
  try {
    const q = `SELECT ?p ?pLabel ?dob ?dod ?pobLabel ?sex ?desc WHERE {
      ?p rdfs:label "${nm}"@zh . ?p wdt:P31 wd:Q5 .
      OPTIONAL{?p wdt:P569 ?dob} OPTIONAL{?p wdt:P570 ?dod}
      OPTIONAL{?p wdt:P19 ?pob . ?pob rdfs:label ?pobLabel FILTER(LANG(?pobLabel)="zh")}
      OPTIONAL{?p wdt:P21 ?sex}
      OPTIONAL{?p schema:description ?desc FILTER(LANG(?desc)="zh")}
    } LIMIT 3`;
    const r = await sparql(q);
    const row = (r.rows || [])[0];
    if (row) {
      const sx = row.sex ? String(row.sex).split('/').pop() : '';
      wd = {
        qid: (row.p || '').split('/').pop(),
        label: row.pLabel || nm,
        born: yearOf(row.dob), died: yearOf(row.dod),
        birthPlace: (row.pobLabel && !/^https?:/.test(row.pobLabel)) ? row.pobLabel : '',
        gender: ({ Q6581097: '男', Q6581072: '女', Q48270: '非二元' }[sx] || ''),
        desc: (row.desc || '').trim(),
      };
      sources.push({ label: 'Wikidata', provider: 'wikidata-sparql', title: `${wd.label}（${wd.born ?? '?'}—${wd.died ?? '?'}）`, url: `https://www.wikidata.org/wiki/${wd.qid}` });
    }
  } catch (e) { /* 忽略 */ }

  // ③b 兜底：维基正文抽不到、SPARQL 又没给出生卒时，再走一次「候选人物」查询。
  //     实测赵顼（宋神宗）会偶发地只命中检索源，生卒全空——那等于没核定，
  //     年龄与卒年就会一直悬着。多查一次比留一个空洞的身份强。
  if ((!wd || (wd.born == null && wd.died == null)) && Y) {
    try {
      const { findCandidates } = require('./verify');
      const v = await findCandidates({ name: nm, from: Math.max(-3000, Y - 120), to: Y + 120 });
      const row = (v.rows || []).find(x => x.born || x.died);
      if (row) {
        wd = wd || {};
        if (wd.born == null && row.born != null) wd.born = row.born;
        if (wd.died == null && row.died != null) wd.died = row.died;
        if (!wd.qid && row.qid) wd.qid = row.qid;
        if (!wd.gender && row.gender) wd.gender = row.gender;
        if (!sources.find(s => s.provider === 'wikidata-sparql')) {
          sources.push({ label: 'Wikidata（候选）', provider: 'wikidata-sparql', title: `${row.label || nm}（${row.born ?? '?'}—${row.died ?? '?'}）`, url: row.qid ? `https://www.wikidata.org/wiki/${row.qid}` : '' });
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  // 三处都没有 → 史无此人（或名字用字不同）。绝不编一个身份出来。
  // 但要区分「真的查无」与「网络被限流/超时」：后者不该阻断建档，只记警告。
  const wikiOk = !!(sources.find(s => s.provider === 'wikipedia'));
  const searchOk = !!(sources.find(s => s.provider && s.provider !== 'wikidata-sparql' && s.provider !== 'wikipedia'));
  const wdOk = !!wd;
  const allSourcesFailed = !wikiOk && !searchOk && !wdOk;
  if (!text && !wd) {
    return {
      found: false, name: nm, year: Y,
      why: allSourcesFailed
        ? `检索后端暂不可用（维基百科 / 检索 / 维基数据全部无响应，可能是限流或网络问题），无法核实「${nm}」。`
        : `检索不到「${nm}」的生平记载。可能是未收录的小人物，也可能名字用字不同（繁简/异体/字号混用）。`,
      allSourcesFailed,
      sources,
    };
  }

  const life = parseLifeSpan(text);
  const role = parseRole(text, nm);
  const native = parseNative(text);
  const place = parsePlace(text);
  const events = parseEvents(text, Y);

  // 生卒年：正文与 Wikidata 冲突时，两边都记下来；数值以「有具体年份的那条」为准，
  // 两边都有且冲突 → 取 Wikidata（结构化、可溯源），并把差异写进 note。
  let born = life.born, died = life.died, note = '';
  if (wd && (wd.born != null || wd.died != null)) {
    if (born == null) born = wd.born;
    if (died == null) died = wd.died;
    if (life.born != null && wd.born != null && life.born !== wd.born) {
      note = `生年两说：正文 ${life.born}、Wikidata ${wd.born}，已按 Wikidata 记`;
      born = wd.born;
    }
    if (life.died != null && wd.died != null && life.died !== wd.died) {
      note = (note ? note + '；' : '') + `卒年两说：正文 ${life.died}、Wikidata ${wd.died}，已按 Wikidata 记`;
      died = wd.died;
    }
  }

  // 身份：正文抽不到就用 Wikidata 的描述（描述通常就是「中国秦朝政治家」这种）
  let finalRole = role.role;
  let roleVia = role.via || '正文';
  if (!finalRole && wd && wd.desc) {
    finalRole = wd.desc.replace(/[（(]\s*-?\d{3,4}.*$/, '').replace(/[，,].*$/, '').trim();
    roleVia = 'Wikidata 描述';
  }

  // 年龄：按开局年份算（中国古代用虚岁，故 +1）
  let age = null;
  if (born != null && Y) {
    age = Y - born + 1;
    if (age < 1 || age > 110) { age = null; note = (note ? note + '；' : '') + `推算年龄 ${Y - born + 1} 岁不合常理，已置空`; }
  }

  // 时代相容性：他真的活在这一年吗
  let fits = null;
  if (Y && (born != null || died != null)) {
    if (born != null && Y < born) fits = { ok: false, why: `他生于公元前 ${-born} 年，不可能出现在 ${fmtYear(Y)}` };
    else if (died != null && Y > died) fits = { ok: false, why: `他卒于${fmtYear(died)}，不可能活在${fmtYear(Y)}` };
    else if (born == null && died != null && Y < died - 80) fits = { ok: false, why: `他卒于${fmtYear(died)}，与${fmtYear(Y)}相差百年以上` };
    else fits = { ok: true };
  }

  return {
    found: true,
    name: nm, year: Y,
    born, died, age,
    gender: (wd && wd.gender) || '',
    role: finalRole, roleVia,
    dynasty: role.dynasty,
    nativePlace: native || (wd && wd.birthPlace) || '',
    place,
    events,
    fits,
    note,
    qid: wd ? wd.qid : '',
    sources,
    network: { wiki: wikiOk, search: searchOk, wd: wdOk },
    excerpt: String(text || '').slice(0, 240),
  };
}

function fmtYear(y) {
  const n = Number(y);
  if (!n) return `${y} 年`;
  return n < 0 ? `公元前 ${-n} 年` : `公元 ${n} 年`;
}

/* 把核定结果写进存档的主角与时钟（不覆盖玩家明确填过的，除非 force） */
function applyToState(state, d, { force = false } = {}) {
  const out = { changed: [] };
  if (!d || !d.found) return out;
  const p = state.protagonist;
  if (d.gender && (force || !p.gender || p.gender === '男')) {
    p.gender = d.gender;
  }
  if (d.age != null && (force || !p.age || p.age === 20)) {
    out.changed.push(`年龄 ${p.age} → ${d.age}（生于${fmtYear(d.born)}）`);
    p.age = d.age; p.birthYear = d.born;
  }
  if (d.role && (force || !p.role || /待定|真实历史人物|宗室|世家贵族|朝廷命官|一方军阀|平民/.test(String(p.role)))) {
    out.changed.push(`身份「${p.role}」→ 「${d.role}」`);
    p.role = d.role;
  }
  if (d.nativePlace && (force || !p.nativePlace)) {
    out.changed.push(`籍贯 → ${d.nativePlace}`);
    p.nativePlace = d.nativePlace;
  }
  if (d.place && (force || !state.location || /待定|未定/.test(String(state.location.full || '')))) {
    out.changed.push(`所在地 → ${d.place}`);
    state.location = { ...(state.location || {}), full: d.place, placeFrom: 'dossier' };
  }
  // 硬约束写进 anchors：提示词每轮都会读到，写他时必须遵守。
  // 同时写入 renderAnchors 兼容字段（birthPlace / officeHistory / events 字符串），
  // 否则下面的「史实硬约束」块渲染不出真实身份。
  const prev = state.anchors || {};
  const evStrings = (prev.events && prev.events.length && typeof prev.events[0] === 'string')
    ? prev.events
    : (d.events || []).map(e => `${fmtYear(e.year)} ${e.text}`);
  state.anchors = {
    ...prev,
    born: d.born != null ? d.born : prev.born,
    died: d.died != null ? d.died : prev.died,
    birthPlace: d.nativePlace || prev.birthPlace,
    officeHistory: d.role || prev.officeHistory,
    kin: prev.kin || '',
    role: d.role || prev.role,
    nativePlace: d.nativePlace || prev.nativePlace,
    qid: d.qid || prev.qid,
    desc: d.excerpt || prev.desc,
    events: evStrings.slice(0, 6),
    dossierAt: new Date().toISOString(),
  };
  return out;
}

/* 真实身份是不是「君主 / 统治者」 */
const RULER_ROLE = /(皇帝|天子|帝王|君主|大王|诸侯王|郡王|亲王|国王|太后|皇后|女皇)/;
function roleIsRuler(role) { return RULER_ROLE.test(role || ''); }

/* 按真实身份反推该用哪个身份模块（用于纠正「点错成皇帝」） */
function classifyIdentity(role) {
  const r = role || '';
  if (roleIsRuler(r)) return 'emperor';
  if (/(宗室|贵族|王族|外戚|公主|郡主|世家)/.test(r)) return 'noble';
  if (/(起义军|义军|首领|领袖|军阀|割据|豪强|叛|贼|盗|起事)/.test(r)) return 'warlord';
  if (/(平民|农夫|农户|农户|商贾|工匠|小贩|农|氓|庶民|白丁|百姓)/.test(r)) return 'commoner';
  return 'official'; // 有官职 / 有身份 → 朝廷命官（兜底）
}

/* 事件（字符串或 {year,text}）→ 只留年份不晚于 Y 的；年份认不出的保留 */
function pastEvents(events, Y) {
  const out = [];
  for (const e of (events || [])) {
    const s = typeof e === 'string' ? e : `${fmtYear(e.year)} ${e.text}`;
    const y = typeof e === 'string' ? parseYear(e) : e.year;
    if (Y && y != null && y > Y) continue;
    out.push(s);
  }
  return out;
}

/* 提示词用：把这个人的核定结果压成一段硬约束 */
function renderDossier(state) {
  const a = state && state.anchors;
  const p = state && state.protagonist;
  if (!a && !p) return '';
  const lines = [];
  if (p) lines.push(`· 主角：${p.name}，${p.age} 岁，${p.role}${p.nativePlace ? `，${p.nativePlace}人` : ''}`);
  if (a) {
    if (a.born != null || a.died != null) lines.push(`· 生卒（硬约束）：${fmtYear(a.born)} — ${a.died != null ? fmtYear(a.died) : '不详'}`);
    if (a.nativePlace) lines.push(`· 籍贯：${a.nativePlace}`);
    // 只给「截至本年已发生」的事：旧版把开局后 30 年内的事（称帝、兵败身死）一并塞给 GM，等于剧透未来
    const past = pastEvents(a.events, state.clock && state.clock.gregorianYear);
    if (past.length) lines.push(`· 与他相关的真实事件（截至本年）：${past.join('；')}`);
    if (a.desc) lines.push(`· 史料原文摘录：${String(a.desc).slice(0, 160)}`);
  }
  if (!lines.length) return '';
  return '=== 主角档案（经检索核定，写他时必须照此；不得另编一套身份年龄） ===\n' + lines.join('\n');
}

module.exports = { identify, applyToState, renderDossier, pastEvents, parseYear, parseLifeSpan, parseRole, parseNative, parsePlace, parseEvents, fmtYear, classifyIdentity, roleIsRuler };
