'use strict';
/**
 * 世界生成器：新开一局时世界自己「长」出来，玩家不必手写人物和地理。
 *
 * 三块来源：
 *  1) historicalFigures —— 免费 Wikidata SPARQL，按公元年挖出该年在世的中国历史人物
 *     （含生卒、籍贯、一句简介），免 key。
 *  2) 家族 / 本地势力 / 地理 —— 纯规则生成（按身份、地点、年号做种子），离线可用。
 *  3) 地图 —— 以主角所在真实地点为中心，邻境取真实历史地名（非占位符），
 *     节点标注地形/物产/路程天数；点开可见籍贯在此地的相关人物。
 *
 * 全部产出都带来源标记；真人模式下绝不覆盖玩家已填的 anchors / household。
 *
 * 严格遵守 rulepacks 的 npcRequiredFields = [name,age,nativePlace,background,tie]
 * 与 npcAutonomyFields = [goal,risk,defectionCondition]，且不出现任何 bannedTokens。
 */
const { sparql } = require('../adapters/search');
const { resolveRuler } = require('./era-data');
const { yearOf } = require('./reign');
const geo = require('./geo');
const timeline = require('./timeline');
const figure = require('./figure-data');

/* 从职衔/姓名里推断地点：如「鲁阳县令」→鲁阳、「常州通判」→常州、「晋阳太守」→晋阳、
   「陈氏坞坞主」→陈氏坞、「知常州」→常州。这是最常见的「地点该从哪来」——
   玩家没填地点，但头衔里已经写着他在哪儿做官/当家。 */
const OFFICE_WORDS = ['节度使', '观察使', '安抚使', '转运使', '布政使', '按察使', '都指挥使', '经略使', '宣慰使',
  '巡抚', '总督', '经略', '提督', '提刑', '都统', '都护', '太守', '郡守', '知府', '知州', '知县', '县令', '县长',
  '通判', '同知', '县丞', '县尉', '主簿', '典史', '长史', '司马', '参军', '别驾', '治中', '录事', '判官', '掌书记',
  '都督', '刺史', '将军', '校尉', '都尉', '中郎将', '总兵', '副将', '参将', '游击', '守备', '千户', '万户', '达鲁花赤',
  '坞主', '寨主', '堡主', '戍主', '关主', '里正', '保正', '甲首', '社长', '啬夫', '三老', '亭长', '游徼',
  '令', '守', '牧', '尹', '相', '掾', '丞'];
function inferPlaceFromText(...texts) {
  for (const t of texts) {
    const s = String(t || '').trim();
    if (!s) continue;
    // ① 先找官职词（长词优先），取它前面的地名
    for (const o of OFFICE_WORDS) {
      const i = s.indexOf(o);
      if (i <= 0) continue;
      let head = s.slice(Math.max(0, i - 5), i).replace(/^[为任做在到据守知刺领镇屯驻的\s]+/, '');
      const m = head.match(/([\u4e00-\u9fa5]{1,4}[县州府郡道坞寨堡关城镇])$/);
      if (m) return m[1];
      if (head.length >= 2) return head.slice(-3);
    }
    // ② 没有官职词，就看有没有「知/守/刺/领/镇/据/屯/驻 + 地名」的写法
    const m2 = s.match(/(?:知|守|刺|领|镇|据|屯|驻|在)\s*([\u4e00-\u9fa5]{2,4})/);
    if (m2) {
      const mm = m2[1].match(/([\u4e00-\u9fa5]{1,4}[县州府郡道坞寨堡关城镇])/);
      return mm ? mm[1] : m2[1];
    }
    // ③ 退而求其次：句中出现「X县/X州/X府/X郡/X坞」这类地名，直接取
    const m3 = s.match(/([\u4e00-\u9fa5]{1,3}[县州府郡坞寨堡关])/);
    if (m3 && m3[1].length >= 3) return m3[1];
  }
  return '';
}

/* 各政权真实都城：玩家没填地点时的兜底，全部是真实地名，绝不出现「地点待定」。
   **按政权匹配，年号绝不参与**——年号「太清」含「清」，旧逻辑会把南朝梁的首都定到北京。 */
const ERA_CENTERS = [
  { re: /^秦$|大秦/, places: ['咸阳'] },
  { re: /西汉|^汉$/, places: ['长安'] },
  { re: /东汉/, places: ['洛阳'] },
  { re: /曹魏|^魏$|北魏/, places: ['洛阳'] },
  { re: /蜀汉|季汉|^蜀$/, places: ['成都'] },
  { re: /孙吴|^吴$/, places: ['建康'] },
  { re: /西晋|^晋$/, places: ['洛阳'] },
  { re: /东晋/, places: ['建康'] },
  { re: /^宋$|刘宋|^齐$|南齐|^梁$|萧梁|^陈$|南陈|南朝/, places: ['建康'] },
  { re: /东魏|北齐/, places: ['邺城'] },
  { re: /西魏|北周/, places: ['长安'] },
  { re: /^隋$|大隋/, places: ['长安'] },
  { re: /^唐$|大唐|武周/, places: ['长安'] },
  { re: /南唐/, places: ['金陵'] },
  { re: /后唐|后梁|后晋|后汉|后周/, places: ['开封'] },
  { re: /北宋/, places: ['开封'] },
  { re: /南宋/, places: ['临安'] },
  { re: /^元$|大元/, places: ['大都'] },
  { re: /^清$|后金/, places: ['北京'] },
];
/** 按政权给一个真实都城（绝不返回「待定」）。政权 > 公元年，年号不参与。 */
function defaultPlace(eraLabel, polity, gYear) {
  const p = String(polity || '');
  const y = Number(gYear) || 0;
  // 同名政权必须靠公元年消歧，否则会闹笑话：
  //   政权写作「宋」时，赵宋（960-1279）都开封/临安，南朝刘宋（420-479）都建康。
  //   实测踩过：熙宁元年（1068）宋神宗被安到建康，就是漏了这一步。
  if (/^宋$/.test(p)) {
    if (y >= 1127 && y <= 1279) return '临安';
    if (y >= 960 && y <= 1126) return '开封';
    return '建康';           // 南朝刘宋（420-479）
  }
  if (/^汉$/.test(p)) {
    if (y >= 202 && y <= 220) return '洛阳';   // 东汉
    if (y >= -202 && y < 9) return '长安';     // 西汉
    if (y >= 221 && y <= 263) return '成都';   // 蜀汉
    return '长安';
  }
  if (/^魏$/.test(p)) {
    if (y >= 386 && y <= 534) return '洛阳';   // 北魏（孝文迁洛后）
    if (y >= 220 && y <= 266) return '洛阳';   // 曹魏
    return '洛阳';
  }
  if (/^梁$/.test(p)) {
    if (y >= 907 && y <= 923) return '开封';   // 五代后梁
    return '建康';                              // 南朝萧梁
  }
  if (/^唐$/.test(p)) {
    if (y >= 937 && y <= 975) return '金陵';   // 南唐
    if (y >= 923 && y <= 936) return '洛阳';   // 后唐
    return '长安';
  }
  for (const e of ERA_CENTERS) if (e.re.test(p)) {
    // 明：永乐十九年（1421）迁都北京，此前都南京
    if (e.places.length > 1) return e.places[Math.abs(hashStr(p + y)) % e.places.length];
    return e.places[0];
  }
  // 明未写进政权名时按年份判别（1368-1420 南京，1421-1644 北京）
  if (y >= 1368 && y <= 1644) return y >= 1421 ? '北京' : '南京';
  if (y >= 1644) return '北京';
  if (y >= 1271) return '大都';
  if (y >= 1127) return '临安';
  if (y >= 960) return '开封';
  if (y >= 581) return '长安';
  if (y >= 220) return '洛阳';
  if (y >= -221) return '咸阳';
  return '洛阳';
}

/* ---------------- 随机与取名（确定性，按种子稳定） ---------------- */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296; };
}
const SURNAMES = '王李张刘陈杨赵黄周吴徐孙朱马胡郭林何高梁郑罗宋谢唐韩冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文'.split('');
const GIVEN = '文昭明德修远承宗永安景行维世仁义礼智信忠孝节义翰林书彦伯仲叔季公卿士元亨利贞乾坤震巽文武成康昭穆显达富贵荣华清源沛霖山川岩松柏鹤云鹏翔麟凤慎敏惠和顺嘉宁'.split('');
const pick = (r, a) => a[Math.floor(r() * a.length)];
// 明显非本朝的域外君主 / 方外宗教领袖：不进「本朝臣工」池，也不参与本朝党争
const OUTSIDER = /可汗|汗國|汗国|蘇丹|苏丹|哈里發|哈里发|埃米爾|埃米尔|沙阿|法王|教皇|喇嘛|噶瑪巴|噶玛巴|班禪|班禅|達賴|达赖|活佛|汗$/;
const makeName = r => pick(r, SURNAMES) + pick(r, GIVEN) + (r() < 0.5 ? pick(r, GIVEN) : '');
const makeGiven = r => pick(r, GIVEN) + (r() < 0.5 ? pick(r, GIVEN) : '');
// 宗姓：取主角姓氏（名字首字，须为中文字），否则回落到随机姓。父、子、兄弟同宗，随此姓。
function clanSurnameOf(name) {
  const c = (name || '').charAt(0);
  return /[一-鿿]/.test(c) ? c : pick(Math.random, SURNAMES);
}

/* 真实历史地名（跨朝代长期存在），用作虚构人物的籍贯与邻境名，杜绝「邻县1」式占位符 */
const REAL_PLACES = ['洛阳', '长安', '汴梁', '江陵', '成都', '太原', '邯郸', '寿春', '会稽', '番禺',
  '蓟城', '敦煌', '姑臧', '建康', '邺城', '南阳', '襄阳', '江都', '广陵', '余杭',
  '明州', '泉州', '广州', '零陵', '汉中', '天水', '陇西', '河东', '河内', '陈留',
  '汝南', '颍川', '沛国', '下邳', '北海', '平原', '临淄', '代郡', '渔阳', '辽西',
  '交趾', '牂柯', '蜀郡', '巴郡', '彭城', '历阳', '庐江', '吴郡', '会稽', '云中'];

/* 籍贯地缘池：虚构人物的籍贯必须落在本政权实际统辖的地界内。
   旧实现从全国池随机取，于是南朝梁（太清二年）的虚构人物被安上「渔阳」——
   那是北朝幽州的地界，等于让建康的官员生在敌国。南北分裂时期尤其致命。 */
const SOUTH_PLACES = ['建康', '江陵', '成都', '会稽', '吴郡', '余杭', '寿春', '襄阳', '江都', '广陵',
  '历阳', '庐江', '零陵', '番禺', '明州', '泉州', '广州', '牂柯', '交趾', '汉中', '巴郡', '蜀郡', '彭城'];
const NORTH_PLACES = ['洛阳', '长安', '邺城', '太原', '邯郸', '蓟城', '敦煌', '姑臧', '南阳', '天水',
  '陇西', '河东', '河内', '陈留', '汝南', '颍川', '沛国', '下邳', '北海', '平原', '临淄', '代郡', '渔阳', '辽西', '云中'];
/* 该政权是南朝（据江左/荆益）还是北朝（据中原/关中） */
function isSouthPolity(polity, gYear) {
  const p = String(polity || '');
  if (/^宋$|刘宋|^齐$|南齐|^梁$|萧梁|^陈$|南陈|东晋|孙吴|^吴$|南宋|南唐|南朝/.test(p)) return true;
  if (/北魏|东魏|西魏|北齐|北周|曹魏|^魏$|^秦$|^汉$|西汉|东汉|^隋$|^唐$|北宋|^元$|^明$|^清$|北朝/.test(p)) return false;
  // 三国蜀汉据益州，算南方
  if (/蜀汉|季汉|^蜀$/.test(p)) return true;
  return false;
}
/* 本地缘籍贯池：本政权地界内的真实地名；本地（主角所治）恒定在池内并优先。 */
function nativePlacePool(polity, loc, gYear) {
  const base = isSouthPolity(polity, gYear) ? SOUTH_PLACES : NORTH_PLACES;
  const seat = loc && loc !== '本城' ? loc : '';
  // 本地若不在池里（如「益州」「荆州」这类大区名），也要能作为籍贯出现
  return seat ? [seat, ...base.filter(x => x !== seat)] : base;
}

/* ---------------- 1) 真实历史人物（免费 Wikidata，含籍贯/官职/性别） ---------------- */
/* Wikidata 偶发网络失败（沙箱代理不稳），给查询加小重试，避免开局拉不到真人。 */
async function sparqlRetry(q, tries = 3) {
  let last = { rows: [] };
  for (let i = 0; i < tries; i++) {
    const r = await sparql(q);
    if (!r.error) return r;
    last = r;
    await new Promise(t => setTimeout(t, 400 * (i + 1)));
  }
  return last;
}
async function historicalFigures(year, excludeName, isEmperor) {
  const Y = Number(year) || 0;
  // 年份没定就绝不挖人：按公元 0 年（甚至负数）去查，拉回来的会是西汉、先秦的人，
  // 世界直接错代 —— 这是「同代人物全是几百年前的人」的根因。
  if (!Y || Y < -1000) return { rows: [], error: '年份未确定，无法检索同代人物' };
  // 思路：锁定「在公元 Y 年仍在世、且出生在中国」的真实人物（中国籍 P27→Q148 对古人太稀疏，实测 0 命中；
  // 改用「出生于中国 P19→P17=Q148」，覆盖充分且快）。
  //
  // 卒年窗口原来是 Y-3 ~ Y+25，这个「+25」是错的：它把「未来 25 年内会死」的人全算成同代，
  // 于是秦始皇三十四年（前 213）会拉出韩信、项羽、陈胜、刘邦 —— 那一年他们都还是平民或孩童，
  // 秦末汉初的事一件都还没发生。现在收紧到 Y+8：只收「眼下还在世、且近年才故去」的人。
  //
  // 同时加最小年龄：生年须 <= Y-16，即 Y 年至少 16 岁。
  // 否则会把「尚未出生」或「还是小孩」的人塞进朝堂（韩信前 213 年才 18 岁，尚无身份可言）。
  //
  // 姓名用本地 rdfs:label（不走联邦 SERVICE wikibase:label，后者每绑定一次外部调用、慢到超时）。
  // P19 籍贯、P569 生年、P570 卒年。官职 P39 另用扁平查询批量取（避开 GROUP_CONCAT 在 Wikidata 上偶发的 400）。
  const LIMIT = isEmperor ? 40 : 24;
  const q = `SELECT ?p ?pLabel ?dob ?dod ?birthPlaceLabel ?desc ?sex WHERE {
  ?p wdt:P31 wd:Q5 .
  ?p wdt:P19 ?birthPlace . ?birthPlace wdt:P17 wd:Q148 .
  ?p wdt:P570 ?dod .
  ?p rdfs:label ?pLabel FILTER(LANG(?pLabel)="zh")
  FILTER(YEAR(?dod) >= ${Y} && YEAR(?dod) <= ${Y + 8})
  OPTIONAL{?p wdt:P569 ?dob}
  OPTIONAL{?p wdt:P21 ?sex}
  OPTIONAL{?birthPlace rdfs:label ?birthPlaceLabel FILTER(LANG(?birthPlaceLabel)="zh")}
  OPTIONAL{?p schema:description ?desc FILTER(LANG(?desc)="zh")}
  FILTER(BOUND(?dob) && YEAR(?dob) <= ${Y - 16} && YEAR(?dob) >= ${Y - 95})
} LIMIT ${LIMIT}`;
  const r = await sparqlRetry(q);
  const yr = yearOf;
  const seen = new Set();
  const rows = [];
  for (const x of (r.rows || [])) {
    const qid = (x.p || '').split('/').pop();
    if (!qid || seen.has(qid)) continue;
    seen.add(qid);
    const label = x.pLabel || '';
    if (excludeName && label === excludeName) continue;
    const bornY = yr(x.dob), diedY = yr(x.dod);
    if (diedY && bornY && diedY < bornY) continue;            // 数据脏（卒早于生）跳过
    // 生年离谱（推算年龄 >100 或 晚于参考年）→ 视为脏数据，不显示年龄，避免给出错误岁数
    const saneBorn = (bornY && bornY >= Y - 100 && bornY <= Y + 1) ? bornY : null;
    const d = (x.desc || '').replace(/[（(]\s*\d{3,4}.*$/, '').trim(); // 末尾可能附生卒年，去掉
    // 域外君主 / 方外宗教领袖不进「本朝同代人物」名单（如昔班尼汗、噶玛巴），避免塞进朝堂
    if (OUTSIDER.test(label) || OUTSIDER.test(d)) continue;
    const sx = (x.sex || '').split('/').pop();
    rows.push({
      qid, label,
      gender: SEX_QID[sx] || '',
      born: saneBorn, died: diedY,
      nativePlace: (x.birthPlaceLabel || '').trim(),
      desc: d.slice(0, 48) || '历史人物',
      office: '',
    });
  }
  // 扁平查询 P39 官职（真实人事），在 Node 侧按 QID 聚合——避开 Wikidata 偶发 400 的 GROUP_CONCAT。
  if (rows.length) {
    try {
      const vals = rows.map(x => `wd:${x.qid}`).join(' ');
      const oq = `SELECT ?p ?officeLabel WHERE {
        VALUES ?p { ${vals} }
        ?p wdt:P39 ?office .
        ?office rdfs:label ?officeLabel FILTER(LANG(?officeLabel)="zh")
      }`;
      const or = await sparqlRetry(oq);
      const map = {};
      for (const o of (or.rows || [])) {
        const qid = (o.p || '').split('/').pop();
        const lab = (o.officeLabel || '').trim();
        if (!qid || !lab) continue;
        (map[qid] = map[qid] || new Set()).add(lab);
      }
      for (const x of rows) if (map[x.qid]) x.office = [...map[x.qid]].slice(0, 4).join('、').slice(0, 40);
    } catch (e) { /* 官职查询失败不影响主流程 */ }
  }
  // 事后过滤：外族头衔常出现在 P39 官职而非简介，此处再剔一遍，确保不进朝堂
  const kept = rows.filter(x => !(OUTSIDER.test(x.label) || OUTSIDER.test(x.desc) || OUTSIDER.test(x.office || '')));
  return { rows: kept, error: r.error };
}

/* Wikidata 性别 QID → 中文；查不到则留空（不臆断） */
const SEX_QID = { Q6581097: '男', Q6581072: '女', Q48270: '非二元' };

/* 按 QID 取真实亲属（父母/配偶/子女/兄弟姐妹）——用于把「真人的身边人」也用真人。
   返回 [{relation,name,gender,born,birthPlace}]；查不到返回空数组。 */
async function kinOfQid(qid) {
  if (!qid) return [];
  const q = `SELECT ?kind ?relLabel ?dob ?dod ?bpLabel ?sex WHERE {
  VALUES ?p { wd:${qid} }
  { ?p wdt:P22 ?rel . BIND("父" AS ?kind) }
  UNION { ?p wdt:P25 ?rel . BIND("母" AS ?kind) }
  UNION { ?p wdt:P26 ?rel . BIND("配偶" AS ?kind) }
  UNION { ?p wdt:P40 ?rel . BIND("子女" AS ?kind) }
  UNION { ?p wdt:P3373 ?rel . BIND("兄弟姊妹" AS ?kind) }
  ?rel rdfs:label ?relLabel FILTER(LANG(?relLabel)="zh")
  OPTIONAL{?rel wdt:P569 ?dob} OPTIONAL{?rel wdt:P570 ?dod}
  OPTIONAL{?rel wdt:P21 ?sex}
  OPTIONAL{?rel wdt:P19 ?bp . ?bp rdfs:label ?bpLabel FILTER(LANG(?bpLabel)="zh")}
} LIMIT 40`;
  const r = await sparqlRetry(q, 2); // 可选增强，网络差时少重试，别拖住开局
  const yr = yearOf;
  const seen = new Set();
  const out = [];
  for (const x of (r.rows || [])) {
    const nm = (x.relLabel || '').trim();
    if (!nm) continue;
    const k = `${x.kind}|${nm}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const sx = (x.sex || '').split('/').pop();
    out.push({
      relation: x.kind, name: nm, gender: SEX_QID[sx] || '',
      born: yr(x.dob), died: yr(x.dod),
      birthPlace: (x.bpLabel && !/^https?:/.test(x.bpLabel)) ? x.bpLabel : '',
    });
  }
  return out;
}

/* ---------------- 2) 家族 / 本地势力 / 地理（规则生成） ---------------- */
const TERRAIN = ['平原沃壤', '丘陵起伏', '依山傍水', '水乡泽国', '边塞苦寒', '海滨斥卤', '盆地周山', '黄土高原'];
const WATER = ['大河穿境而过', '近江有渡', '湖沼纵横', '山溪可灌田', '井泉足用', '干旱少水'];
const ROAD = ['驿道通州治', '仅通小路', '商道辐辏', '山径崎岖', '水陆皆可'];
const PRODUCT = ['稻米', '小麦', '蚕丝', '茶叶', '海盐', '铁冶', '马政', '漆器', '竹木', '瓷器', '药材', '渔获', '棉麻', '枣梨'];
const DISASTER = ['夏秋易涝', '春旱常见', '间有蝗灾', '时疫流行', '盗贼时起', '边患时闻', '海溢为患', '风雹伤稼'];
/* 官职池：按朝代分桶，杜绝跨朝代错置（如明代皇帝绝不给「节度使」）。
   键为朝代桶，值为该身份在此朝合理出现的角色。 */
const ROLE_POOLS = {
  秦汉: {
    emperor: ['宗室诸侯王', '丞相', '御史大夫', '九卿', '郡太守', '刺史', '郎官', '中常侍', '富商'],
    noble: ['列侯', '食邑相', '门客', '宗族长老', '庄田管家', '郡国相', '盐铁官', '富商'],
    official: ['郡太守', '县令', '县丞/尉', '啬夫（乡官）', '三老', '书佐', '游徼', '豪强'],
    warlord: ['裨将军/校尉', '部曲督', '军司马', '长史（幕府）', '说客', '邻郡豪帅', '商贾', '细作'],
    commoner: ['里正/啬夫', '田主', '亭长', '游徼', '邻人', '三老', '船户', '债主'],
  },
  中古: {
    emperor: ['宗室亲王', '录尚书事（宰辅）', '中书监', '州刺史', '都督', '门阀家主', '世家大族', '富商'],
    noble: ['门阀家主（士族）', '宗正', '姻亲世家', '门生故吏', '庄客头目', '郡守姻亲', '富商'],
    official: ['州刺史', '郡太守', '县令', '别驾/治中', '主簿', '门生故吏', '土豪', '世族'],
    warlord: ['都督/镇将', '参军（谋主）', '部曲督', '长史', '说客', '邻镇豪帅', '商队首领', '细作'],
    commoner: ['里正/里魁', '田主', '胥吏', '行商', '邻人', '里中长者', '船户', '债主'],
  },
  隋唐: {
    emperor: ['宗室亲王', '宰相（同平章事）', '节度使', '枢密使', '御史大夫', '蕃将', '宫人', '富商'],
    noble: ['国公/郡王', '食邑令', '门客', '庄头', '盐铁转运官', '姻亲世交', '富商'],
    official: ['州刺史', '县令', '长史/司马', '判司（户兵曹）', '录事', '里正', '折冲府校尉', '行商'],
    warlord: ['节度使/防御使', '节度判官（谋主）', '牙将（先锋）', '都知兵马使', '掌书记', '说客', '邻镇豪帅', '商队首领', '细作'],
    commoner: ['里正', '田主', '胥吏', '行商', '邻人', '里中长者', '船户', '债主'],
  },
  宋: {
    emperor: ['宗室郡王', '宰执（同平章事）', '参知政事', '三司使', '知州', '转运使', '提刑', '富商'],
    noble: ['国公/郡王', '恩荫子弟', '门客', '庄田管事', '盐茶官姻亲', '富商'],
    official: ['知州/知县', '通判', '签判', '主簿', '县尉', '巡检', '保正/里正', '乡绅', '讼师', '行商'],
    warlord: ['经略安抚使', '参谋（谋主）', '统制/统领（先锋）', '粮料官', '说客', '邻路帅臣', '商队首领', '细作'],
    commoner: ['保正/里正', '田主', '胥吏', '行商', '邻人', '里中长者', '船户', '债主'],
  },
  元: {
    emperor: ['宗王', '中书丞相', '行中书省平章', '达鲁花赤', '万户', '宣慰使', '富商'],
    noble: ['封君/投下领主', '私属（怯怜口）管事', '姻亲', '色目豪商', '富商'],
    official: ['达鲁花赤', '总管/尹', '县达鲁花赤', '儒学教授', '村社长', '富商'],
    warlord: ['万户/千户', '幕官（谋主）', '探马赤（先锋）', '奥鲁官（粮）', '说客', '邻道万户', '商队首领', '细作'],
    commoner: ['村社长', '田主', '胥吏', '行商', '邻人', '社长', '船户', '债主'],
  },
  明: {
    emperor: ['宗室藩王', '内阁大学士', '六部尚书', '都察院御史', '五军都督/总兵', '锦衣卫指挥使', '司礼监太监', '富商'],
    noble: ['勋贵（公侯伯）', '藩王宗亲', '门客清客', '庄田管事', '姻亲乡宦', '盐引商', '富商'],
    official: ['知府/知县', '同知/通判', '县丞/主簿', '典史', '里长/甲首', '乡绅', '生员', '书吏', '讼师', '行商', '粮长'],
    warlord: ['总兵/副将', '参将/游击', '军门幕僚（谋主）', '守备（先锋）', '理饷官', '说客', '邻镇总兵', '商队首领', '细作'],
    commoner: ['里长/甲首', '田主', '书吏', '行商', '邻人', '乡绅', '船户', '债主'],
  },
  清: {
    emperor: ['宗室王公', '军机大臣', '内阁大学士', '六部尚书', '总督/巡抚', '提督/总兵', '八旗都统', '富商'],
    noble: ['世袭公爵', '门客', '庄园管事（庄头）', '姻亲', '盐商', '富商'],
    official: ['知府/知县', '同知/通判', '县丞/典史', '幕友（师爷）', '保甲长', '乡绅', '书吏', '讼师', '行商'],
    warlord: ['提督/总兵', '副将/参将', '幕宾（谋主）', '游击（先锋）', '军需官', '说客', '邻省提督', '商队首领', '细作'],
    commoner: ['保甲长/地保', '田主', '胥吏', '行商', '邻人', '乡绅', '船户', '债主'],
  },
  通用: {
    emperor: ['宗室亲王', '宰辅大臣', '御史', '边将', '宫人', '富商'],
    noble: ['宗正', '姻亲世家的家主', '食邑令', '门客', '庄头', '郡守', '盐铁官', '富商'],
    official: ['长官（州县长官）', '同僚', '书吏', '里正', '巡检', '乡绅', '讼师', '行商'],
    warlord: ['谋主', '先锋将', '亲兵校尉', '粮官', '说客', '邻镇豪帅', '商队首领', '细作'],
    commoner: ['里正', '田主', '胥吏', '行商', '邻人', '里中长者', '船户', '债主'],
  },
};

/* 政权名 → 朝代桶。**年号绝不参与判定**：年号「太清」含「清」，旧逻辑因此把
   南朝梁太清二年（548）判成清朝，套上「满洲亲贵对汉军机大臣」的派系框架。
   年号只表示某朝某年，与朝代归属无关。 */
const POLITY_BUCKET = [
  [/南明|^明$|大明/, '明'],
  [/后金|^清$|大清/, '清'],
  [/^元$|大元|蒙古帝国/, '元'],
  [/北宋|南宋/, '宋'],
  [/^隋$|大隋/, '隋唐'],
  [/^唐$|大唐|武周/, '隋唐'],
  [/南唐|后唐|后梁|后晋|后汉|后周|五代/, '隋唐'],
  [/^秦$|大秦/, '秦汉'],
  [/西汉|东汉|蜀汉|季汉|^汉$/, '秦汉'],
  // 「宋」「汉」这类同名政权必须靠公元年消歧：赵宋（960-1279）与刘宋（420-479）不是一回事
  [/^宋$/, y => (y >= 960 && y <= 1279 ? '宋' : '中古')],
  [/^汉$/, y => (y >= -202 && y <= 220 ? '秦汉' : (y >= 221 && y <= 263 ? '秦汉' : '秦汉'))],
  [/三国|曹魏|^魏$|北魏|东魏|西魏|北齐|北周|^蜀$|^吴$|孙吴|^晋$|西晋|东晋|南北朝|南朝|北朝|^齐$|^梁$|^陈$|刘宋|萧梁|南陈/, '中古'],
];
/* 由政权/公元年推断朝代桶（yearLabel 仅作最后兜底，且只取其中明确的朝代字） */
function dynastyBucket(yearLabel, polity, gregorianYear) {
  const p = String(polity || '');
  const y = Number(gregorianYear) || 0;
  // ① 政权名最可靠（同名政权用年份消歧）
  for (const [re, b] of POLITY_BUCKET) if (re.test(p)) return typeof b === 'function' ? b(y) : b;
  // ② 政权缺失：按公元年粗分（这是最硬的史实锚，年号不可靠）
  if (y >= 1368 && y <= 1644) return '明';
  if (y >= 1644 && y <= 1912) return '清';
  if (y >= 1271 && y < 1368) return '元';
  if (y >= 960 && y < 1279) return '宋';
  if (y >= 581 && y < 907) return '隋唐';
  if (y >= 220 && y < 581) return '中古';
  if (y >= -221 && y < 220) return '秦汉';
  // ③ 最后才看年号串，且只认「朝代名」而非单字（避免「太清」→清）
  const s = String(yearLabel || '');
  if (/南明|大明/.test(s)) return '明';
  if (/后金|大清/.test(s)) return '清';
  if (/大元/.test(s)) return '元';
  if (/北宋|南宋/.test(s)) return '宋';
  if (/大隋/.test(s)) return '隋唐';
  if (/大唐|武周|南唐/.test(s)) return '隋唐';
  return '通用';
}

function localRoles(identity, bucket) {
  return (ROLE_POOLS[bucket] && ROLE_POOLS[bucket][identity]) || ROLE_POOLS['通用'][identity] || ROLE_POOLS['通用'].official;
}
const HOUSEHOLD_OBLIG = {
  emperor: ['宗庙祭祀', '巡幸之费', '驭下之术'],
  noble: ['岁输租税于国', '朝请宿卫', '维系门第婚姻'],
  official: ['考课年限', '税粮上供', '刑名钱谷'],
  warlord: ['养兵之费', '输忠于上或自立', '安抚部曲'],
  commoner: ['赋役本色', '地租', '保甲差遣'],
};
/* 【已废弃】旧的 OPENINGS 模板池（「父亲临终半句话」「井里死了人」「陇西的马场」等）
   已整块删除。那些句子与本年真实发生的事毫无关系——南朝梁太清二年，梁武帝被侯景围在台城，
   系统却给主角安排「近臣要借你的马场」，等于把历史当背景板、把剧情当随机生成器。
   现在的开局处境由 historyOpening() 从历史底盘生成，见下方「历史驱动的线索与开局」。 */

/* 身份在历史事件中的处境：不虚构人物与情节，只说清「这件事落在你身上是什么分量」。
   这是模板，但它是**结构性**的——具体那件「事」永远来自当朝真实大事，不来自想象。 */
const STANCE = {
  emperor: '此事最终要由你定夺，而朝议已分作两途',
  // 旧句「朝廷的诏令已递到你手上，赴援还是观望，全在你一念」对任何宗室、任何年份都一样套，
  // 548 年 10 月的萧纪开局就因此被写成「已奉密诏」——那时台城刚被围，消息还在路上。
  noble: '此事关乎你的封国与名分，进退须自己权衡',
  official: '这事落到你衙里办，办砸了是你的考课，办成了也未必是功',
  warlord: '你手里那支兵，正是此事各方都要借的',
  commoner: '你不在议事的堂上，却在被摊派的册上',
};


/* ---------------- 历史驱动的线索与开局（取代旧的随机模板池） ----------------
   铁律（历史锚定协议）：
     ① 线索只从历史底盘长出——本朝真实大事、当朝天子、主角所据之地与政权归属、该朝真实党争框架；
     ② 每条线索必须标出**史料来源**（source / anchor），查不到来源的线索不生成；
     ③ 不虚构人物、不虚构亲属纠葛、不虚构阴谋；无史料可依时写「待据史补录」，留白而不是编造；
     ④ 随机数只用于在「同等真实的若干条史实之间挑」，绝不用于「造一件事出来」。 */
function historyThreads(state, r) {
  const idm = state.identityModule || 'official';
  const stance = STANCE[idm] || STANCE.official;
  const yearLabel = state.clock && state.clock.yearLabel || '';
  const loc = lastSeg(state.location && state.location.full || '');
  const polity = (state.location && state.location.polity) || '';
  const sovereign = state.reigningSovereign || '';
  const events = (state.eraEvents || []).filter(Boolean);
  const Y = Number(state.clock && state.clock.gregorianYear) || 0;
  const M = state.clock && state.clock.month;
  const D = state.clock && state.clock.day;

  const out = [];
  const push = (title, source, anchor, extra = {}) => out.push({
    id: 'h' + out.length,
    title,
    label: extra.label || shortLabel(title),
    status: 'open',
    lastTouchedTurn: 0,
    source,                 // 史料来源标记
    anchor: anchor || '',   // 依据的原文
    stance: extra.stance || stance,   // 主角在此事中的处境
    ...(extra.eventId ? { eventId: extra.eventId } : {}),
    ...(extra.hearsay ? { hearsay: true } : {}),
    note: source === 'unknown'
      ? '该年真实大事未核定，待据史补录；补录前不得凭空生成剧情'
      : extra.hearsay
        ? '消息尚在途中，只能以传闻出现，未经证实；不得写成主角已确知'
        : '由开局历史底盘生成（来源：' + source + '），待玩家处置',
  });

  // ⓪ 真实人物在**此年此月**的处境（协议 §12.1）——与主角本人直接相关的史实，最优先
  const fd = figure.dossierAt((state.protagonist || {}).name, Y, M);
  if (fd && fd.situation) {
    push(fd.situation.text, 'figure', fd.situation.src || '', {
      label: fd.tension ? fd.tension.name : '本任日常',
      stance: fd.tension ? fd.tension.whyNotResolved : '眼下没有压到你身上的大事，日常政务即是正事',
    });
  }

  // ① 本朝真实大事 —— 只取**已发生、且消息已传到主角所在地**的；路上的消息只能当传闻。
  //    旧版直接取 eraEvents 末两条，于是 548 年 10 月的成都开局就「知道」了建康十月二十四日的合围。
  const place = (state.location && state.location.full) || '';
  const hasTimeline = timeline.EVENTS.some(e => e.polity === polity);
  if (hasTimeline && Y) {
    const k = timeline.knownAt(polity, place, Y, M, D);
    for (const ev of k.known.filter(e => !e.foreign).slice(-2)) push(ev.text, 'eraEvents', ev.text, { eventId: ev.id });
    const rum = k.rumored.filter(e => !e.foreign).slice(-1)[0];
    if (rum) push('传闻：' + rum.text, 'rumor', rum.text, { eventId: rum.id, hearsay: true, stance: '消息未经证实，真伪与详情都还不清楚' });
  } else if (events.length) {
    for (const ev of events.slice(-2)) push(String(ev), 'eraEvents', String(ev));
  } else {
    push('（' + (yearLabel || '本年') + '真实大事未核定）', 'unknown', '');
  }

  // ② 名分所出：当朝天子是谁（权柄的合法性来源，也是冲突的根源）
  if (sovereign && !fd) push('当朝天子' + sovereign + '，你的名分与权柄皆出于他', 'ruler', sovereign);

  // ③ 立足之地：有本地档案的，写他在此地实际在经营什么（史料原文），而不是一句空话
  if (fd && fd.resources && fd.resources.note) {
    push(`${fd.seat || loc}任上：${fd.resources.note}`, 'figure-resources', fd.resources.src || '', { label: '蜀中政务', stance: '这是你的根本，也是各方都盯着的家底' });
  } else if (loc && loc !== '本城') {
    push('你据' + loc + (polity ? '（' + polity + '）' : '') + '，治下编户与兵仗皆出于此', 'geography', loc);
  }

  // ④ 该朝真实存在的党争框架（成员留空，由 GM 依史实指认，绝不随机塞人）。有本地档案时用档案里的派系，不套模板
  if (!fd) {
    const bucket = dynastyBucket(state.clock && state.clock.yearLabel, polity, state.clock && state.clock.gregorianYear);
    const pairs = FACTION_PAIRS[bucket] || FACTION_PAIRS['通用'];
    if (pairs.length && events.length) {
      const [a, b, stake] = pairs[Math.floor(r() * pairs.length)];
      push(a + '与' + b + '相争：' + stake, 'faction', a + '/' + b);
    }
  }

  // 线索条数：2~4 条，全部有来源；绝不为了凑数编造
  return out.slice(0, 4);
}

/* 按职掌推定的日常所求（只说这个位置上的人通常要办的事，不编私人恩怨） */
function roleWants(role) {
  const r = String(role || '');
  if (/世子/.test(r)) return '在父亲面前立身，学着理事，将来承袭王爵';
  if (/之子|子$/.test(r)) return '随侍父侧，求得父亲器重';
  if (/长史/.test(r)) return '替府主理顺幕府文书与钱粮，遇事先替府主拿主意';
  if (/司马/.test(r)) return '掌府中军务，主张兵备不可懈怠';
  if (/参军/.test(r)) return '把分内的兵将、宿卫管好，不出差错';
  if (/部将|将军/.test(r)) return '带兵立功，求得升迁与赏赐';
  if (/宗室|侄/.test(r)) return '在叔父幕下谋一个实任，立下名声';
  if (/刺史|太守/.test(r)) return '保境安民，考课不落人后';
  return '把分内的差事办好，不受牵连';
}

/* 线索/剧情的短名：取第一个分句，最多 14 字（标题不能是整段史料原文） */
function shortLabel(text) {
  const s = String(text || '').replace(/^传闻：/, '');
  const first = s.split(/[，；。,;]/)[0] || s;
  return first.length > 14 ? first.slice(0, 14) + '…' : first;
}

/* 按月份的日常政务（只写该季节在州郡里必然要办的事，不编具体事件） */
const MONTHLY_AFFAIRS = {
  1: '正旦受贺、劝农布令', 2: '劝课春耕、修治陂堰', 3: '春耕正忙、蚕事将起',
  4: '蚕桑上簇、盐井课入', 5: '夏收麦稼、核点仓储', 6: '夏税将征、防备江水',
  7: '秋稼渐熟、巡视水利', 8: '秋收在即、整修仓廪', 9: '秋收入仓、核定租调',
  10: '征收租调、收储冬粮', 11: '岁终考课、整理上计簿书', 12: '岁末封印、核算一年钱粮',
};

/* 开场白：把本年最要紧的那件真事摆到主角面前，并要求他决断。
   绝不出现虚构的人物、阴谋与家庭惨剧——有的只是史实与你在其中的位置。 */
function historyOpening(state, r, threads) {
  const yearLabel = (state.clock && state.clock.yearLabel) || '';
  const head = yearLabel ? yearLabel + '，' : '';

  // —— 开局处境必须与「他此刻能做什么」相称 ——
  // 旧版把「本年大事」直接当处境，于是九岁的马希声一上来就面对称帝、征伐、供亿这类国事，
  // 既不合身份，也把开场挤成一篇大势梗概。未成年/无职衔者改走日常切面。
  let cap = null;
  try { cap = require('./capability').capabilityOf(state); } catch { /* 闸门失效则退回旧行为 */ }
  if (cap && (cap.isMinor || (!cap.hasOffice && !cap.isEmperor))) {
    const place = (state.location && state.location.full) || '';
    const who = cap.guardian ? `${cap.guardian.name}（${cap.guardian.relation}）` : '府中主事者';
    const age = cap.age != null ? `年方 ${cap.age} 岁` : '年岁未核定';
    // 注意：本函数返回值是**玩家可见**的「开局处境」，也是喂给 GM 的底盘。
    // 曾在此处追加「开场须落在…不得开篇即写军国大势」这类导演指令，
    // 结果 UI 直接把提示词原文显示给了玩家。导演指令一律只放 prompt.js。
    return head + (place ? place + '。' : '') + `你${age}，随${who}居于此地。`
      + '府中实务不由你决断：公文、钱粮、军务皆经' + who + '之手。'
      + '你能触及的是堂上旁听、师傅的功课、身边人的言谈与府中往来的来客。';
  }

  if (!threads || !threads.length) return head + '（本年大事未核定，待据史补录后再开局）';
  const first = threads[0];
  if (first.source === 'unknown') {
    return head + '本年真实大事尚未核定。在补录之前，我不替你编造处境——请先提供该年的史实，或换一个已核实的年代开局。';
  }
  // —— 开局从日常落笔，大事只作背景 ——
  // 用户原话：「开头太紧凑了，不够日常」。旧版直接把第一条大事 + 一句「全在你一念」当开场，
  // 等于一睁眼就是军国急报。现在：先写此时此地该办的日常政务，再交代眼下的处境，
  // 远方的消息按是否已传到写成「已知」或「传闻」，尚未传到的一个字也不写。
  const place = (state.location && state.location.full) || '';
  const month = Number(state.clock && state.clock.month) || 0;
  const daily = MONTHLY_AFFAIRS[month] || '';
  const pn = state.protagonist && state.protagonist.name;
  const title = figure.titleAt(pn, state.clock && state.clock.gregorianYear)
    || (state.protagonist && (state.protagonist.office || state.protagonist.role)) || '';
  const parts = [];
  parts.push(head + (month ? `${month}月，` : '') + (place ? `${place}。` : ''));
  if (title) parts.push(`你以${title}的身份在${place || '任'}理事。`);
  // 旧句「府中照例有簿书、请示要你过目」实测把开场引成僚属排队报账，改为只交代时令
  if (daily) parts.push(`时值${daily}。`);
  const sit = threads.find(t => t.source === 'figure');
  if (sit) parts.push(`眼下的处境：${sit.title}。`);
  const news = threads.filter(t => t.source === 'eraEvents').map(t => t.title);
  if (news.length && !(sit && news.some(n => sit.title.includes(shortLabel(n))))) parts.push(`已传到此地的远方消息：${news.join('；')}。`);
  const rum = threads.find(t => t.hearsay);
  if (rum) parts.push(`另有一则未经证实的传闻：${rum.anchor}。`);
  // 旧版在此追加导演指令（「开场须落在…不得开篇即写急报密诏」），
  // 而这段文字玩家在界面上看得见——等于把提示词贴给玩家看。
  // 同样的话 prompt.js 的「开场的节奏」「开场严禁」两节已写全，此处只留事实。
  return parts.join('');
}

/* 历史一致性检查（协议 §3.1/§3.2/§12.1/§4.3）：真实人物核验 + 时间切片。
   seed（新局）与 rebuildPlot（旧档重算）共用，保证「先核对史实，再生成场景」。
   返回本次施加的修正清单，便于审计与展示。 */
function applyHistoryChecks(state) {
  const log = [];
  if (!state || !state.clock) return log;
  const year = state.clock.gregorianYear || 0;
  const polity = (state.location && state.location.polity) || '';
  const pname = (state.protagonist && state.protagonist.name) || '';

  // ① 真实人物核验：驻地 / 官职 / 年龄，一律以档案为准。
  //    引擎此前把历史人物当成「一个名字 + 一个身份模块」，于是萧纪被放到江陵——
  //    那其实是他七兄萧绎（荆州刺史）的治所；萧纪自大同三年起镇成都。
  const fd = figure.dossierAt(pname, year, state.clock.month);
  if (fd) {
    if (fd.seat && !String(state.location.full || '').includes(fd.seat)) {
      const playerSet = state.location.placeFrom === 'player';
      if (!playerSet) {
        const fromLoc = String(state.location.full || '');
        state.location.full = fd.seat;
        state.location.placeFrom = 'figure-verified';
        state.figureCorrection = {
          field: 'location', from: fromLoc, to: fd.seat, name: pname, year,
          note: `按人物档案修正驻地：${pname}于${year}年的实际治所为${fd.seat}` +
                (fd.post ? `（${fd.post.title}）` : '') + `，原地点「${fromLoc}」无史实依据。`,
          source: 'figure-data', confidence: 'high',
        };
        log.push(state.figureCorrection.note);
      } else {
        // 玩家手填的地点：不静默改，标为待确认的架空（协议 §12.6）
        state.figureWarning = {
          field: 'location', set: state.location.full, expected: fd.seat, name: pname, year,
          note: `你指定了驻地「${state.location.full}」，但档案记载${pname}于${year}年治${fd.seat}。` +
                `已按你的设定保留，并标记为**待确认的架空设定**——若你本意是史实局，请改回${fd.seat}。`,
          source: 'figure-data', confidence: 'high',
        };
        log.push(state.figureWarning.note);
      }
    }
    if (fd.age != null && state.protagonist.age == null) {
      state.protagonist.age = fd.age;
      state.protagonist.birthYear = fd.born;
    }
    if (fd.post && !state.protagonist.role) state.protagonist.role = fd.post.title;
    state.figureDossier = fd;
  }

  // ② 时间切片：只把「当前时点之前已发生」的事当作既成事实。
  //    旧实现把「侯景围台城，梁武帝饿踣将殁」整包丢给太清二年，
  //    可武帝饿死是太清三年（549）五月的事，早了整整一年。
  refreshEraEvents(state);
  return log;
}

/**
 * 按「此时此地」重算天下大势（开局与每次时钟推进都要调）：
 *   eraEvents        —— 已发生且消息已传到主角所在地的（可写成已知）；
 *   eraEventsRumored —— 已发生、消息可能已到的（只能写成传闻）；
 *   eraEventsPending —— 尚未发生的（后台留存，严禁写进正文）。
 * 旧版只按「已发生」切，于是成都的萧纪在建康合围的当天就「知道」了。
 */
function refreshEraEvents(state) {
  if (!state || !state.clock) return;
  const polity = (state.location && state.location.polity) || '';
  const place = (state.location && state.location.full) || '';
  const { gregorianYear: y, month: m, day: d } = state.clock;
  if (!y || !timeline.EVENTS.some(e => e.polity === polity)) return;
  const k = timeline.knownAt(polity, place, y, m, d);
  state.eraEvents = k.known.map(e => e.text);
  state.eraEventsSource = 'timeline';
  state.eraEventsRumored = k.rumored.map(e => e.text);
  state.eraEventsUnheard = k.unheard.map(e => e.id);
  // 尚未发生的事：留在后台，严禁写进正文当作已知（协议 §17.1 第 5 条）
  state.eraEventsPending = k.future.map(e => ({ y: e.y, m: e.m || null, text: e.text }));
}

/* 旧存档体检：判断这个档的开局剧情是不是旧随机模板池的产物。
   判据：① 线索没有 source 字段（历史驱动版每条都带来源）；
        ② 开场白命中已删除的模板句（「陇西的马场」「井里」等）。 */
const DEAD_OPENING = /陇西|马场|井里|父亲咽气|赐婚的诏书|乳母快死|清君侧|举荐你升迁|就地正法|征丁的榜文|菜园|地契上的界|义仓开仓|十年副将|你的粮只够十天|幼子被掳|最小的儿子被对头掳/;
function needsPlotRebuild(state) {
  if (!state) return false;
  const th = state.threads || [];
  if (!th.length) return true;
  if (th.some(t => !t.source)) return true;
  if (DEAD_OPENING.test(String(state.opening || ''))) return true;
  return false;
}
/* 就地把旧档的开局剧情重算为历史驱动版（只动引擎生成的字段，不动玩家手填的档案） */
function rebuildPlot(state, r) {
  r = r || mulberry32(hashStr(String(state.meta && state.meta.id || '') + '|replot'));
  const idm = state.identityModule || 'official';
  const polity = (state.location && state.location.polity) || '';
  const bucket = dynastyBucket(state.clock && state.clock.yearLabel, polity, state.clock && state.clock.gregorianYear);
  const before = {
    threads: (state.threads || []).map(t => t.title),
    opening: state.opening || '',
    factions: (state.factions || []).map(f => f.title),
    location: String(state.location && state.location.full || ''),
    age: state.protagonist && state.protagonist.age,
  };
  // 先核对史实（驻地 / 年龄 / 时间切片），再生成场景（协议 §5.1）
  const checks = applyHistoryChecks(state);
  const threads = historyThreads(state, r);
  state.threads = threads;
  state.opening = historyOpening(state, r, threads);
  state.factions = generateFactions(idm, bucket, state);
  return {
    rebuilt: true,
    checks,
    before,
    after: {
      threads: threads.map(t => t.title),
      opening: state.opening,
      factions: state.factions.map(f => f.title),
      location: String(state.location && state.location.full || ''),
      age: state.protagonist && state.protagonist.age,
    },
  };
}

/* 兼容旧导出：一律走历史驱动版本，随机模板池已废 */
function generateThreads(stateOrIdentity, r) {
  if (stateOrIdentity && stateOrIdentity.clock) return historyThreads(stateOrIdentity, r);
  // 旧签名（只给 identity）已不再支持凭空生成：没有任何史料，就只给「待补录」一条
  return [{
    id: 'h0', title: '（本年真实大事未核定）', status: 'open', lastTouchedTurn: 0,
    source: 'unknown', anchor: '', stance: '',
    note: '未传入历史底盘（state.clock/eraEvents），待据史补录；补录前不得凭空生成剧情',
  }];
}

/* 开场白：结合身份与已生成的线索，落到具体的一桩事上，避免空泛。
   已改为历史驱动——见上方 historyOpening()。 */
function chooseOpening(stateOrIdentity, r, threads) {
  if (stateOrIdentity && stateOrIdentity.clock) return historyOpening(stateOrIdentity, r, threads);
  return '（本年真实大事未核定，待据史补录后再开局）';
}

/* 自主三字段（goal/risk/defectionCondition）—— 全部为古人语境，不含任何后世词汇 */
const GOALS = ['扩自家田产', '保住官职不失', '替主君笼络人心', '把女儿嫁入高门', '查清一桩旧案', '压住本地盐利', '囤粮待价而沽', '结好邻镇豪强', '掩盖当年亏空', '为族人争个出身'];
const RISKS = ['朝中有人参他', '粮价一跌便露怯', '手下亲信生异心', '旧案被人翻出', '上官骤然调任', '义仓亏空被人察觉', '子弟惹出人命官司', '商路被劫断了财源'];
const DEFS = ['一旦夺了他核心利益便倒戈', '见风使舵，哪边势大靠哪边', '许以重利即背旧主', '主君失势他便另投', '事急则弃众自保'];

/* 身份背景模板（rulepack 要求虚构人物给出「身份背景」） */
const BACKGROUND = {
  '宗室亲王': '天潢贵胄，仪仗所至州县辟易，心思却未必在封地。',
  '宰执大臣': '门下省日决万机，一言之褒贬可定人升沉。',
  '枢密使': '掌军机调动，最知边将虚实与朝廷猜忌。',
  '节度使': '一道兵民财赋尽在掌握，与中央是又依又防。',
  '监察御史': '风闻言事，专以劾人升迁，人人惮之。',
  '蕃将': '率本部兵马宿卫，功高而见疑，进退两难。',
  '宫人': '朝夕侍侧，最得窥人主喜怒，也最易获罪。',
  '富商': '赀财敌县，却无官身，遇事全凭结交权贵。',
  '宗正': '掌皇族属籍，爵位承袭的谱系全经他手。',
  '姻亲世家的家主': '门第联姻织成网，一荣俱荣一损俱损。',
  '食邑令': '替宗室收租理邑，夹在主家与佃户之间。',
  '门客': '寄人篱下，献策画策只为安身。',
  '庄头': '代主理庄田，鞭扑佃客，最知庄中底细。',
  '郡守': '一郡之主，课农桑、理刑狱、供上命。',
  '盐铁官': '专卖之利尽出于手，白银过手最易生贪。',
  '商人': '逐利四方，消息比官府还灵。',
  '长官（州县长官）': '一县之主，考课升沉系于税粮刑名。',
  '同僚': '与你同署办事，面上和气，暗里争功。',
  '书吏': '掌案牍出入，衙门底细尽在笔下。',
  '里正': '催科派役全凭他一张嘴，乡民又怕又恨。',
  '巡检': '捕盗缉奸，手下有弓手，地头极熟。',
  '座师同年': '科场渊源，恩门与年谊最是难却的人情。',
  '乡绅': '田连阡陌，说话能压过县令三分。',
  '讼师': '刀笔之下能活人也能杀人，最会钻律文缝隙。',
  '谋主': '运筹帷幄，主公成败系于其谋。',
  '先锋将': '陷阵先登，功高而赏薄，易生怨望。',
  '亲兵校尉': '宿卫帐前，忠心与否只在主公待他如何。',
  '粮官': '掌全军嚼谷，粮尽则军散，权重而危。',
  '说客': '凭三寸舌穿梭诸侯，今日为东明日可为西。',
  '邻镇豪帅': '拥兵自守，结则生乱，叛则成患。',
  '商队首领': '走南闯北，暗通情报，钱途即前途。',
  '细作': '潜形匿迹，一纸密报可倾人城。',
  '田主': '薄田数顷，最怕旱涝与加租。',
  '胥吏': '衙前奔走，律令熟于胸，最会上下其手。',
  '行商': '贩贱鬻贵，一路风霜，消息最灵。',
  '邻人': '比屋而居，知你底细也最易生嫌隙。',
  '里中长者': '一乡齿尊，调停争讼，说话有分量。',
  '船户': '操舟为业，水路关津尽识。',
  '债主': '放债取息，逼讨时面冷心硬。',
};
/* 关键词→背景（覆盖朝代分桶后的新官职名，按包含匹配） */
const BG_KEYWORDS = [
  ['尚书', '部院之长为官民表率，一纸行文可动天下钱谷刑名。'],
  ['御史', '风闻言事，专以劾人升迁，人人惮之。'],
  ['知县', '一县之主，刑名钱谷考课尽系于此。'],
  ['知府', '一府之主，辖数县，刑名钱谷考核所归。'],
  ['县令', '一县之主，催科断狱全凭他。'],
  ['县丞', '佐知县理事，县中庶务多经其手。'],
  ['主簿', '掌簿书出纳，钱粮数目尽在册中。'],
  ['典史', '县中捕盗典狱，最知衙门阴私。'],
  ['巡检', '捕盗缉奸，手下有弓手，地头极熟。'],
  ['教授', '学官，掌一郡生徒课业，清流所聚。'],
  ['提刑', '提点刑狱，专核一路狱讼，囚犯生死系焉。'],
  ['转运使', '掌一路财赋漕运，钱粮出入尽过其手。'],
  ['通判', '与知州分庭抗礼，监州之任，最易生龃龉。'],
  ['同知', '府之佐贰，协理刑名钱谷。'],
  ['总督', '节制数省文武，威权重而嫌疑深。'],
  ['巡抚', '一省军民咸受节制，恩威并用。'],
  ['总兵', '统兵一方，兵权在手而朝堂猜忌随形。'],
  ['提督', '一省绿营之主，操练征伐皆出于此。'],
  ['副将', '副总兵之任，位高而功赏常薄。'],
  ['参将', '部将之一，冲锋在后指挥在前。'],
  ['游击', '游击之将，往来策应，最知行间虚实。'],
  ['守备', '守一城一堡，兵微而责重。'],
  ['校尉', '营中武官，麾下士卒唯其令是从。'],
  ['将军', '统军之号，功高震主者往往不保。'],
  ['都督', '都府掌兵，位尊而权分，易成尾大不掉。'],
  ['刺史', '分刺一州，监察守相，权轻而责重。'],
  ['太守', '一郡之主，课农桑、理刑狱、供上命。'],
  ['郡王', '宗室疏属，封号尊而实权薄。'],
  ['藩王', '就藩外镇，名分亲而朝廷防之。'],
  ['亲王', '天潢近支，仪制拟天子，一举一动皆关国本。'],
  ['国公', '勋旧之封，爵尊而恩宠难测。'],
  ['丞相', '百官之首，一言之进退可动朝局。'],
  ['宰相', '秉钧当轴，调和鼎鼐，最是伴君如伴虎。'],
  ['大学士', '阁臣入直，票拟批红，实掌相权。'],
  ['中常侍', '掖庭近臣，出纳王命，最易弄权。'],
  ['九卿', '列卿典九寺，各司其职而互相牵制。'],
  ['三老', '乡官之尊，掌教化，一乡舆论所系。'],
  ['游徼', '乡亭缉盗之吏，地头蛇也。'],
  ['亭长', '十里一亭，主捕盗讼事，微官而近民。'],
  ['啬夫', '乡官，听讼收赋，民之休戚系焉。'],
  ['保甲', '编户稽查，连坐相保，民畏之。'],
  ['保正', '统百家而供县役，乡里之爪牙。'],
  ['甲首', '什伍之长，催科派役皆出其手。'],
  ['里长', '轮充之役，催粮应差，夹在官民之间。'],
  ['乡宦', '致仕乡居，名在缙绅，言可动县。'],
  ['生员', '庠序之士，免役见官不跪，乡人敬而官怜。'],
  ['锦衣卫', '禁中缉事，诏狱生杀皆出其手，人人畏之。'],
  ['司礼监', '内廷秉笔，批红出阉人之手，权侔内阁。'],
  ['军机', '帷幄谋议，承旨书谕，机事不密则祸。'],
  ['宗室', '天家血脉，恩礼与猜忌相随。'],
  ['宗王', '草原封君，兵牧自擅，与朝廷若即若离。'],
  ['达鲁花赤', '蒙元置监，掌印治民，色目人居多。'],
  ['万户', '千夫之长，世掌军户，兵农合一。'],
  ['千户', '百夫之长，部勒军户，屯戍相兼。'],
  ['宣慰使', '行省屏藩，抚绥一方，然尾大不掉。'],
  ['平章', '行省执政，钱谷刑名一省咸决于其手。'],
  ['管事', '主家事务皆经其手，奴仆中之有权者。'],
  ['姻亲', '因婚而亲，休戚与共而利害交织。'],
  ['门生', '受业座下，恩义与利用交织。'],
  ['幕僚', '运筹帷幄，主公成败系于其谋。'],
  ['幕宾', '宾师之礼，献谋画策，去留自由。'],
  ['谋主', '运筹帷幄，主公成败系于其谋。'],
  ['先锋', '陷阵先登，功高而赏薄，易生怨望。'],
  ['粮', '掌军中馈饷，粮绝则众散。'],
  ['兵马', '掌一军征伐，号令所出士卒从之。'],
  ['书记', '掌笺奏文书，文檄皆出其手。'],
  ['长史', '幕府辅官，综理军政，最知内情。'],
  ['部曲', '私兵之帅，唯主公之命是从。'],
  ['司马', '治军旅、司兵籍，营中之干吏。'],
  ['安抚', '经略一路，兵民兼制，威权甚重。'],
  ['饷', '理一军粮饷，银米出入皆经其手。'],
  ['军需', '办军中器械粮秣，责重而利厚。'],
  ['帅臣', '一路统帅，兵民兼治。'],
  ['勋贵', '开国或戚畹之贵，爵高而恩宠难恃。'],
  ['盐', '垄断盐利，赀财巨万而结交权贵。'],
  ['色目', '异族行商，凭本朝优借而富。'],
  ['恩荫', '凭父祖余荫入仕，骄奢而少才。'],
  ['领主', '裂土而治，私属如云，与朝廷若即若离。'],
  ['诸侯', '裂土分封，屏藩王室而尾大不掉。'],
];
function backgroundFor(role, r) {
  if (BACKGROUND[role]) return BACKGROUND[role];
  for (const [k, v] of BG_KEYWORDS) if (role.includes(k)) return v;
  return pick(r, ['地方上有头脸的人物，黑白两道都认得几分。', '在此地盘踞多年，根基极深。', '新来乍到，正寻靠山立足。', '手眼通天，寻常官面也要让他三分。']);
}

/* 与主角的一条确切关系（rulepack 要求「与他人的一条确切关系」） */
function tieToProtagonist(r, pname) {
  return pick(r, [
    `受${pname}管辖，平日表面恭顺`,
    `与${pname}有田产旧怨，见面便冷笑`,
    `曾于危难中救过${pname}一命`,
    `是${pname}座师门下的同年，暗通声气`,
    `受${pname}之托办事，各有算计`,
    `与${pname}是同乡，借此在本地说话`,
    `是${pname}的倾慕者，凡事肯帮衬`,
    `${pname}升迁的绊脚石，暗中使绊`,
  ]);
}

function lastSeg(loc) {
  if (!loc || loc === '（地点待定）') return '本城';
  const parts = loc.split(/[\s·、]/).filter(Boolean);
  return parts[parts.length - 1] || '本城';
}
function upperSeg(loc) {
  if (!loc || loc === '（地点待定）') return '州治';
  const parts = loc.split(/[\s·、]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '州治';
}

/* 家庭生成：宗法结构（宗姓/外姓）、性别、嫡庶、妾媵与内宅管事。
   用户诉求：连男女性别、后宅、内宅都搞不明白 —— 故每人都标 gender，
   男性且有身份者（皇/贵/官）才生成妾与内宅管事，子女分嫡庶。 */
function generateHousehold(identity, protagonist, r, pname, loc, polity, gYear) {
  // 宗姓锁定：父、子、兄弟随主角姓；母亲/配偶/妾保留本姓（外姓，符合宗法）
  const clan = clanSurnameOf(protagonist.name);
  // 籍贯只在本政权地界内取（南朝人不会生在渔阳）
  const pool = nativePlacePool(polity, loc, gYear);
  const localNative = (upperSeg(loc) && upperSeg(loc) !== '州治') ? upperSeg(loc) : pick(r, pool);
  const age = Number(protagonist.age) || 30;
  const isFemale = (protagonist.gender || '') === '女';
  // 妾媵与内宅只对男性且在位者（君/贵/官）成立，符合古代家庭结构；平民不设
  const hasInnerCourt = !isFemale && ['emperor', 'noble', 'official'].includes(identity);
  const members = [];
  // ownSurname=true 表示外姓（母/妻/妾/媳）；否则随宗姓
  const add = (relation, relAge, role, bg, ownSurname, gender, extra = {}) => members.push({
    name: (ownSurname ? pick(r, SURNAMES) : clan) + makeGiven(r),
    relation, age: relAge, gender, status: '在世', role: role || '',
    attitude: '', note: '由开局自动生成，未核实',
    nativePlace: ownSurname ? pick(r, pool) : localNative,
    background: bg || backgroundFor(role || relation, r),
    tie: extra.tie || `主角的${relation}`,
    ...(extra.rank ? { rank: extra.rank } : {}),
    ...(extra.inner ? { inner: true } : {}),
  });
  if (r() < 0.95) add('父', age + 24 + Math.floor(r() * 8), '（已退养/在堂）', '一家之主，阅历最深，最在意门第与田产。', false, '男');
  if (r() < 0.9) add('母', age + 20 + Math.floor(r() * 6), '（在堂）', '主持中馈，最知家中进项与亲族往来。', true, '女');
  // 正室：主角为女则「夫」，为男则「妻」
  if (age > 18 && r() < 0.75) add(isFemale ? '夫' : '妻', age - 2 + Math.floor(r() * 4), isFemale ? '（夫主）' : '（结发正室）',
    isFemale ? '结发之夫，家中名分所系。' : '结发正室，掌中馈、管妾媵与家中进项，最清楚你的私交。', true, isFemale ? '男' : '女');
  // 妾媵（仅男性且在位者）：位分有别，是内宅争斗的常见源头
  let nConcubine = 0;
  if (hasInnerCourt && r() < 0.8) nConcubine = 1 + Math.floor(r() * 3);
  for (let i = 0; i < nConcubine; i++) {
    add('妾', Math.max(15, age - 8 + Math.floor(r() * 10)), pick(r, ['（侧室）', '（侍妾）', '（孺人）']),
      pick(r, ['出身寒微，凭姿容入府，最盼生个儿子。', '本为婢女抬举，根基浅而心气高。', '娘家小有势力，在内宅自成一派。']),
      true, '女', { inner: true });
  }
  // 子女：嫡出（正室所生）与庶出（妾所生）分明
  const nKids = Math.floor(r() * 4);
  const maxKid = age > 22 ? Math.max(1, age - 15) : 4;
  for (let i = 0; i < nKids; i++) {
    const kidGender = r() < 0.5 ? '男' : '女';
    const isDi = nConcubine === 0 || i === 0; // 有妾时，长子为嫡，余可庶出
    const rank = isDi ? '嫡' : '庶';
    const rel = rank + (kidGender === '男' ? '子' : '女');
    add(rel, 1 + Math.floor(r() * maxKid), '', isDi ? '正室所出，名分最正。' : '妾室所出，地位随母，易生嫡庶之争。', false, kidGender, { rank: isDi ? '嫡' : '庶', inner: true });
  }
  // 手足
  const nSib = Math.floor(r() * 3);
  for (let i = 0; i < nSib; i++) add(r() < 0.5 ? '兄' : '弟', age - 3 + Math.floor(r() * 6), '', '同辈手足，或同心或相忌。', false, '男');
  if (r() < 0.4) add(r() < 0.5 ? '姊' : '妹', age - 2 + Math.floor(r() * 6), '', '同辈姊妹，多用于联姻，其婚事亦是家中大事。', false, '女');
  // 内宅管事（女）：内宅事务的实际操持者，连通内外消息
  if (hasInnerCourt) add('内宅管事', 35 + Math.floor(r() * 20), pick(r, ['（管家娘子）', '（内宅掌事）']),
    '内宅钱粮、奴仆、采买尽经其手，最知内宅阴私与人情往来。', true, '女', { inner: true });
  // 皇帝：宗庙禁军内帑，不是「十亩薄田」那套庶民家当
  const property = identity === 'emperor'
    ? { 宫禁: '紫禁深严，侍卫环卫', 宗庙: '太庙四时致祭', 禁军: '京营、亲军宿卫', 内帑: '天下财赋所归', 后妃: '中宫与诸妃分居东西六宫' }
    : {
      田: `${10 + Math.floor(r() * 200)}亩`,
      宅: r() < 0.5 ? '城中宅一区' : '祖宅数楹',
      赀财: r() < 0.5 ? '中人之产' : '薄有积蓄',
      奴婢: r() < 0.4 ? `${1 + Math.floor(r() * 6)}口` : '无',
      ...(hasInnerCourt ? { 内眷: '正室与妾侍分居内外，嫡庶有别' } : {}),
    };
  return {
    clan: clan + '氏',
    members,
    property,
    obligations: HOUSEHOLD_OBLIG[identity] || ['赋役', '税粮'],
    note: '由开局自动生成，家族成员为虚构，真实人物模式请以核查为准',
  };
}

function generateNeighbors(identity, location, r, polity, gYear) {
  const seat = lastSeg(location);
  const up = upperSeg(location);
  const pool = nativePlacePool(polity, seat, gYear);
  const neighbors = [];
  // 上级治所：取一个本政权地界内的真实历史地名，而非「州治」虚名
  const cap = pick(r, pool);
  neighbors.push({ label: cap, kind: 'capital', terrain: pick(r, TERRAIN), products: pick(r, PRODUCT) + '、' + pick(r, PRODUCT), distanceDays: 1 + Math.floor(r() * 3) });
  const extra = 2 + Math.floor(r() * 2);
  const used = new Set([cap]);
  for (let i = 0; i < extra; i++) {
    let lab;
    do { lab = pick(r, pool); } while (used.has(lab));
    used.add(lab);
    neighbors.push({ label: lab, kind: 'neighbor', terrain: pick(r, TERRAIN), products: pick(r, PRODUCT), distanceDays: 2 + Math.floor(r() * 8) });
  }
  return { seat, neighbors };
}

function generateGeography(identity, location, r, neighbors) {
  const g = {
    地形: pick(r, TERRAIN),
    水系: pick(r, WATER),
    道路驿站: pick(r, ROAD),
    距州治: (neighbors.neighbors[0] ? `${neighbors.neighbors[0].distanceDays} 日程` : '未详'),
    邻境: neighbors.neighbors.slice(1).map(n => n.label + '（' + n.distanceDays + '日）').join('、') || '未详',
    物产: [...new Set(neighbors.neighbors.map(n => n.products).join('、').split('、'))].join('、') || pick(r, PRODUCT),
    常发灾异: pick(r, DISASTER),
    note: '由开局自动生成（地名取真实历史地名，地理关系为推演，未逐一核实）',
    generated: true,
  };
  return g;
}

function generateLocalCast(identity, r, pname, loc, bucket, polity, gYear) {
  const roles = localRoles(identity, bucket);
  // 本地人物：多数籍贯为本乡（本地），少数来自外地（任职/行商/流寓）——
  // 但「外地」也必须是本政权地界内的外地，不能是敌国（旧实现取到渔阳，即北朝幽州）。
  const pool = nativePlacePool(polity, loc, gYear);
  const localNative = (upperSeg(loc) && upperSeg(loc) !== '州治') ? upperSeg(loc) : pick(r, pool);
  const out = [];
  const k = 3 + Math.floor(r() * 3);
  for (let i = 0; i < k; i++) {
    const role = pick(r, roles);
    const name = makeName(r);
    const np = r() < 0.7 ? localNative : pick(r, pool);
    // 本地人物多为仕宦/行商等公共角色，默认男性；偶出女冠、媒婆、稳婆、女掌柜等
    const isFemaleRole = /媒|婆|女冠|尼|稳婆|女掌柜|女医|乳母/.test(role) || r() < 0.12;
    out.push({
      name,
      gender: isFemaleRole ? '女' : '男',
      age: 22 + Math.floor(r() * 45),
      nativePlace: np,
      background: backgroundFor(role, r),
      tie: tieToProtagonist(r, pname),
      goal: pick(r, GOALS),
      risk: pick(r, RISKS),
      defectionCondition: pick(r, DEFS),
      role,
      source: 'generated',
    });
  }
  return out;
}

/* 真人局的「家」：
   - 成员优先用**真实亲属**（用户要求：真人的身边人也必须是真人）；
   - 只有侍从/内侍/婢仆这类无名小人可以是虚构，且标 source:'fictional-attendant'，绝不冒充史实；
   - 真实亲属查不到就留空，不编造。 */
const ATTENDANTS = {
  emperor: ['内侍监', '掌灯内侍', '司礼监书办', '尚食奉御'],
  noble: ['门客', '亲随', '掌事婢女', '护院'],
  official: ['长随', '书吏', '门房', '厨役'],
  warlord: ['亲兵什长', '掌旗卒', '饲马卒', '帐前听用'],
  commoner: ['邻家帮工', '同村雇工'],
};
function realHousehold(identity, protagonist, r, realKin = []) {
  const property = identity === 'emperor'
    ? { 宫禁: '紫禁深严，侍卫环卫', 宗庙: '太庙四时致祭', 禁军: '京营、亲军宿卫', 内帑: '天下财赋所归', 后妃: '中宫与诸妃分居东西六宫（妃嫔须依史实）' }
    : (identity === 'noble' || identity === 'official')
      ? { 田: '请依史实补录', 宅: '请依史实补录', 赀财: '请依史实补录', 内眷: '正室与妾侍、嫡庶之别须依史实，引擎不虚构' }
      : { 田: '请依史实补录', 宅: '请依史实补录', 赀财: '请依史实补录' };

  // 真实亲属：用真实姓名与关系（来自 Wikidata 亲属关系）
  const members = (realKin || []).map(k => {
    const age = (k.born != null && protagonist.birthYear) ? (protagonist.birthYear - k.born) : null;
    return {
      name: k.name, gender: k.gender || '', relation: k.relation, rank: '',
      age: age != null && age >= 0 ? age : null, status: '在世',
      role: '', attitude: '', nativePlace: k.birthPlace || '',
      background: '真实历史人物（由 Wikidata 亲属关系自动填入，未逐一核实）',
      tie: `主角的${k.relation}`, source: 'real-kin',
    };
  });

  // 虚构侍从/内侍：允许（无名小人），但明确标为虚构，不与史实人物混淆
  const pool = ATTENDANTS[identity] || ATTENDANTS.official;
  const n = 1 + Math.floor(r() * 2);
  const used = new Set();
  for (let i = 0; i < n; i++) {
    let role = pool[Math.floor(r() * pool.length)];
    if (used.has(role)) continue;
    used.add(role);
    members.push({
      name: `${pick(r, SURNAMES)}${makeGiven(r)}`,
      gender: r() < 0.35 ? '女' : '男',
      relation: '近侍', rank: '', age: 16 + Math.floor(r() * 30), status: '在世',
      role, attitude: '', nativePlace: '', inner: ['emperor', 'noble', 'official'].includes(identity),
      background: '无名近侍，与主角朝夕相处，最知内宅与私事。', tie: '主角的近侍',
      source: 'fictional-attendant',
    });
  }

  return {
    clan: '', members, property,
    obligations: HOUSEHOLD_OBLIG[identity] || ['赋役', '税粮'],
    realMode: true,
    note: '真实人物：亲属用真实关系（查不到则留空、不编造）；侍从内侍为虚构并已标明，不冒充史实。',
  };
}

/* 派系 / 内斗：只给「历史上真实存在的党争框架」（谁与谁争、争什么），
   绝不随机把真人塞进某一派 —— 归属须由 GM 依真实史实指认，以免编造党争。 */
const FACTION_PAIRS = {
  明: [['内阁票拟之臣', '司礼监秉笔（内廷）', '票拟与批红之权相争，阁权与宦权此消彼长'],
       ['清流言官', '阉党近幸', '言路与内廷互讦，科道弹章与诏狱相随'],
       ['主战边臣', '主和枢臣', '战守之议相持，边饷与和款两难']],
  清: [['满洲亲贵', '汉军机大臣', '满汉用人之争，满员压汉、汉臣渐掌枢要'],
       ['帝党', '后党宗室', '帝后两宫各树私人，进退皆系宫闱'],
       ['主战之臣', '主和之臣', '和战之争，夷务与边衅并起']],
  元: [['蒙古宗王', '色目理财之臣', '蒙古旧俗与理财新法相格，宗王怨望'],
       ['怯薛近臣', '汉法派儒臣', '内廷怯薛与行汉法之臣相争']],
  宋: [['新党（变法一派）', '旧党（元祐一派）', '新法旧法之争，台谏与宰执迭相攻讦'],
       ['主战之臣', '主和之臣', '战和两议，边衅与岁币之利害相左']],
  隋唐: [['宰相朝臣', '宦官中尉', '相权与宦权相轧，北司与南衙对峙'],
        ['藩镇悍将', '中央文臣', '藩镇跋扈与朝廷削藩之争'],
        ['进士清流', '门荫世家', '科第与门第之争，牛李党争余绪']],
  中古: [['门阀士族', '寒门新贵', '士庶之别，清浊分途，选举与门第相争'],
        ['宗室诸王', '外戚权臣', '宗王与外戚争权，皆觊觎中枢']],
  秦汉: [['儒臣博士', '酷吏法家', '儒法之争，宽严之政迭用'],
        ['外戚', '宦官', '外戚与中人交争，皆居中用事'],
        ['功臣列侯', '宗室', '军功集团与宗室争权']],
  通用: [['旧臣宿将', '新进幸臣', '旧勋与新宠相轧，恩宠即权柄'],
        ['主战一派', '主和一派', '和战之议相持不下']],
};
/* 按朝代给出真实存在的党争框架；成员留空，由 GM 依史实指认，不随机分配。 */
function generateFactions(identity, bucket, state) {
  // 有本地档案的真实人物：用档案里按时点生效的派系（梁末不该套「宗室对外戚」的通用模板）
  if (state && state.protagonist && state.clock) {
    const fx = figure.factionsAt(state.protagonist.name, state.clock.gregorianYear, state.clock.month);
    if (fx && fx.length) {
      return fx.map(x => ({
        title: x.title, stake: x.stake, sideA: x.sideA, sideB: x.sideB,
        membersA: [], membersB: [], provisional: false, source: 'figure-data', src: x.src, conf: x.conf,
      }));
    }
  }
  const pairs = FACTION_PAIRS[bucket] || FACTION_PAIRS['通用'];
  return pairs.map(([a, b, stake]) => ({
    title: `${a} 对 ${b}`, stake, sideA: a, sideB: b,
    membersA: [], membersB: [], provisional: true,
  }));
}

/* 地图：按「最近时期」检索真实历史地图图片。
   1) 先算出本局年代对应谭其骧《中国历史地图集》哪一册/图组（权威的「最近时期」参照）；
   2) 用「地名+年号+年份+朝代」多组词去共享资源搜，再**按年代贴近度排序**，最接近本局的排最前；
   3) 附上几个真实地图站点的检索入口，供玩家自行查证（含史图馆——它没有公开接口，只能给检索页）。 */
const DYNASTY_MAP_KEY = {
  秦: ['秦', '秦朝', 'Qin'], 汉: ['汉', '漢', 'Han'], 三国: ['三国', '三國'], 魏: ['魏', '曹魏'],
  晋: ['晋', '晉', 'Jin'], 南北朝: ['南北朝', '梁', '陈', '魏'], 隋: ['隋', 'Sui'],
  唐: ['唐', 'Tang'], 五代: ['五代', '后梁', '后唐'], 宋: ['宋', 'Song', '北宋', '南宋'],
  元: ['元', 'Yuan', '蒙古'], 明: ['明', 'Ming'], 清: ['清', 'Qing', '滿清'],
};
/* 朝代的英文名：共享资源上用英文检索命中率与精准度都更好（如 "Map of the Ming dynasty (1500)"）。 */
const DYNASTY_EN = {
  秦: 'Qin', 汉: 'Han', 三国: 'Three Kingdoms', 魏: 'Cao Wei', 晋: 'Jin',
  南北朝: 'Northern and Southern dynasties', 隋: 'Sui', 唐: 'Tang',
  五代: 'Five Dynasties', 宋: 'Song', 元: 'Yuan', 明: 'Ming', 清: 'Qing',
};
function dynastyEn(s) { for (const [k, v] of Object.entries(DYNASTY_EN)) if (s.includes(k)) return v; return ''; }

async function realMap(eraLabel, polity, place, gYear) {
  const s = (polity || '') + ' ' + (eraLabel || '');
  const keys = [];
  for (const [dyn, ks] of Object.entries(DYNASTY_MAP_KEY)) if (s.includes(dyn)) keys.push(...ks);
  keys.push('中国', 'China', '疆域', '舆图', '地圖', '地图', 'map', 'Map', 'dynasty', 'Empire');

  const y = Number(gYear) || 0;
  const A = geo.atlasOf(y);
  const pol = (polity || '').replace(/[（）()/·\s].*$/, '').trim();
  const en = dynastyEn(s);
  const yearWord = y > 0 ? `${y}年` : '';
  // 越靠前的检索词越贴近本局年代，命中即用（英文词在共享资源上命中率更高）
  const queries = [
    place ? `${place} ${yearWord} 地图` : '',
    en ? `${en} dynasty map ${y > 0 ? y : ''}`.trim() : '',
    en ? `${en} dynasty map` : '',
    en ? `${en} empire map` : '',
    place ? `${place} 历史地图` : '',
    `${pol} ${eraLabel || ''} 地图`.trim(),
    `${pol}朝 疆域 ${yearWord}`.trim(),
    `${pol} 疆域 地图`,
    `${pol} 历史地图`,
    '中国历史地图',
  ].filter(Boolean);

  let images = [];
  for (const q of queries) {
    if (!q) continue;
    images = await geo.historicalMaps(q.trim(), 4, keys, y || null);
    if (images.length) break;
  }

  const note = images.length
    ? `按「最近时期」检索（本局年代对应谭其骧《中国历史地图集》${A.volume}·${A.period}）；下列图片已按年代贴近度排序，最接近本局的排在最前。均为共享资源原图，引擎未改绘。`
    : '没检索到该年代的相关历史地图图片。可换一个朝代/政权，或直接点下面的站点自行查找。';

  return { images, place: place || '', atlas: A, sources: geo.mapSources(eraLabel, polity, y), note };
}

/* ---------------- 顶层：按存档生成整个世界 ---------------- */
async function seed(state, opts = {}) {
  const idm = state.identityModule || 'official';
  const year = state.clock.gregorianYear || 0;
  const polity = state.location.polity || '';
  const pname = state.protagonist.name || '你';
  const bucket = dynastyBucket(state.clock.yearLabel, polity, year);

  // —— 历史一致性检查（协议 §5.1「先核对史实，再生成场景」）——
  applyHistoryChecks(state);

  // —— 地点：绝不「待定」。优先级：玩家已填 > 职衔里的地名 > 真人的真实籍贯 > 该时代真实行政中心 ——
  let rawLoc = String(state.location.full || '').trim();
  let locFrom = state.location.placeFrom || 'player';
  if (!rawLoc || /待定|未定|不详|未知/.test(rawLoc)) {
    const fromRole = inferPlaceFromText(state.protagonist.role, state.protagonist.background);
    const np = String(state.protagonist.nativePlace || '').trim();
    if (fromRole) { rawLoc = fromRole; locFrom = 'role'; }
    else if (np) { rawLoc = np; locFrom = 'real-person'; }
    else { rawLoc = defaultPlace(state.clock.yearLabel, polity, year); locFrom = 'era-default'; }
    state.location.full = rawLoc;
    state.location.placeFrom = locFrom;
  }

  const r = mulberry32(hashStr(state.meta.id + '|' + year + '|' + rawLoc));

  // 真人模式：守住玩家已有的 household / anchors，不覆盖
  const isReal = state.mode === 'real';
  // 真实亲属：优先用已有的（玩家核查时已拉的 kin）；没有就用锚点 QID 现拉
  const existing = (state.household && state.household.members) || [];
  let realKin = existing.filter(m => m.source === 'real-kin');
  if (isReal && !realKin.length && state.anchors && state.anchors.qid) {
    try { realKin = (await kinOfQid(state.anchors.qid)).map(k => ({ ...k, source: 'real-kin' })); } catch { /* 拉不到就留空 */ }
  }
  let household;
  if (isReal) {
    household = realHousehold(idm, state.protagonist, r, realKin);
    // 保留玩家自己手填的成员（非引擎生成的），别覆盖他的资料
    const manual = existing.filter(m => m.source !== 'real-kin' && m.source !== 'fictional-attendant' && m.source !== 'generated');
    household.members = [...manual, ...household.members];
  } else {
    household = generateHousehold(idm, state.protagonist, r, pname, rawLoc, polity, year);
  }

  // —— 真实地理：从维基条目正文抽取，抽不到写「不详」，绝不随机编；一律用当时古地名 ——
  const geoResult = await geo.placeGeography(rawLoc, { adapter: opts.adapter, config: opts.adapterCfg, eraLabel: state.clock.yearLabel, polity }).catch(() => null);
  const geography = {
    ...((geoResult && geoResult.fields) || {}),
    note: (geoResult && geoResult.note) || '地理由真实检索生成；未查到的字段为「不详」，不编造。',
    source: (geoResult && geoResult.source) || '',
    eraName: (geoResult && geoResult.eraName) || rawLoc,
    real: true,
  };

  // 历史人物（联网，失败也不阻塞）；皇帝身份多拉人，这些就是他的朝臣
  const isEmperor = idm === 'emperor';
  let historicalNpcs = [];
  let histError = null;
  // 有本地档案的人物：身边人用档案里核过的真实僚属/亲属，远方要人列为「尚未交往」。
  // 不再走 Wikidata 批量拉人——实测 548 年萧纪开局拉回了高欢（547 年已死）、
  // 高澄（东魏权臣，远在邺城）、司马子如（被标成「西晋司马」），没有一个在他身边。
  const circle = figure.circleAt(state.protagonist.name, year, state.clock.month);
  const fdSeat = figure.seatAt(state.protagonist.name, year) || rawLoc;
  if (circle.length) {
    historicalNpcs = circle.map(c => ({
      name: c.name, gender: c.gender || '男',
      age: c.born ? (year - c.born + 1) : null,
      birthYear: c.born || null, born: c.born || null, died: c.died || null, diedM: c.diedM || null,
      nativePlace: '',
      // 档案 note 里常是此人「后来」的结局（如「后谏阻东下被杀」「553 年降西魏」），
      // 写进背景就等于把未来剧透给 GM——背景只给出处，结局另存 histNote，不进提示词
      background: `史有其人（${c.src || '史载'}）`,
      histNote: c.note || '',
      tie: `主角的${c.relation}`,
      // 史书多只记职掌与结局。旧版填「个人所图史无明载」，结果提示词里满屏「他要『史无明载』」，
      // 剧情引擎还据此造出「某某所请」的空剧情。现在按其职掌给出推定的立场（标明是推定），远方要人不给。
      goal: c.far ? '' : (c.wants || roleWants(c.role)),
      risk: c.far ? '' : (c.fears || '在府主面前失信、担上误事之责'),
      defectionCondition: '', stanceBasis: c.far ? '' : (c.wants ? 'figure-data' : '依职掌推定'),
      role: c.role, office: c.role, seat: c.seat || '',
      contact: !c.far && (!c.seat || c.seat === fdSeat),
      source: 'historical', verified: 'high', verifySource: 'figure-data.circle',
      src: c.src, conf: c.conf,
    }));
  } else try {
    const hf = await historicalFigures(year, state.protagonist.name, isEmperor);
    histError = hf.error;
    historicalNpcs = hf.rows.slice(0, isEmperor ? 18 : 12).map(x => ({
      name: x.label,
      gender: x.gender || '',
      age: x.born ? (year - x.born + 1) : null,
      birthYear: x.born || null,
      nativePlace: x.nativePlace || '',
      background: x.desc || '历史人物，详情待核',
      // 史实人物与主角的确切关系通常无记载：如实标注，不编造（规则第10条）
      tie: x.nativePlace ? `与主角同代，籍贯${x.nativePlace}` : '与主角同代，无直接交往记载',
      goal: '', risk: '', defectionCondition: '',
      // 真实人物优先用真实职掌（人事），没有再用简介
      role: (x.office && x.office !== x.label) ? x.office : (x.desc || '历史人物'),
      office: x.office || '',
      qid: x.qid, born: x.born, died: x.died,
      source: 'historical',
    }));
  } catch (e) { histError = String(e && e.message || e); }

  // 皇帝：朝中大臣/近侍一律用真实同代人物（上面已按皇帝身份多拉），不再造虚构官员
  // 有真实僚属名单时不再随机生成「门阀家主/庄客头目」一类虚构本地人物：真人身边用真人
  const localCast = (isEmperor || circle.length) ? [] : generateLocalCast(idm, r, pname, rawLoc, bucket, polity, year);

  // 派系 / 内斗：只给真实党争框架，成员由 GM 依史实指认（不随机塞人）
  const factions = generateFactions(idm, bucket, state);

  // 开局线索：**由历史底盘生成**（本朝真实大事 / 当朝天子 / 所据之地 / 该朝党争框架）。
  // 不再按身份随机抽「父亲临终半句话」这类模板——那与这一年真实发生的事毫无关系。
  const threads = historyThreads(state, r);
  // 地图：按「最近时期」取真实历史地图图片
  const map = await realMap(state.clock.yearLabel, polity, rawLoc, year).catch(() => ({ images: [], note: '地图检索失败。', place: rawLoc, sources: [] }));
  // 地盘：初值仅记「所在地」，归属由检索/GM 逐年更新（不随机编）
  const territory = state.territory && state.territory.length ? state.territory : [{
    name: rawLoc,
    controlledBy: (state.location.controller && state.location.controller !== '未核实') ? state.location.controller : (polity || '不详'),
    note: '开局所在地；归属按史实检索得出，之后随战事更新', source: 'worldgen', updatedTurn: 0,
  }];

  // 主角年龄：玩家没填、且非真人模式（真人由核查/维基填真实年龄）的，按身份估计；
  // 真人模式若核查也未给出年龄，也在此兜底，确保年龄字段不为空、界面不显示「null岁」。
  if (state.protagonist.age == null) {
    await ensureProtagonistAge(state, year, opts.adapter, opts.adapterCfg);
  }

  return {
    historicalNpcs, localCast, household, geography, map, threads, factions, territory,
    opening: state.opening || historyOpening(state, r, threads), histError,
  };
}

/* 主角年龄兜底：玩家没填、且非真人模式（真人模式由 dossier/核查填真实年龄）时，
   按身份用大模型估一个合乎情理的岁数；适配器不可用或解析失败，再按身份给中性默认值。
   这是用户诉求「我可以自定义年龄，要求你估计」的落地——虚构人物不再被强行填 20/28。 */
async function ensureProtagonistAge(state, year, adapter, adapterCfg) {
  if (state.protagonist.age != null) return;
  const idm = state.identityModule || 'official';
  const role = state.protagonist.role || '';
  if (adapter) {
    try {
      const est = await adapter.call({
        system: '你是历史角色设定助手。只输出一个整数（该角色此时的合情年龄，中国古代用虚岁），不要任何解释或标点。',
        prompt: `时代：${state.clock.yearLabel || ''}（公元${year || '?'}年），政权：${state.location.polity || ''}。身份模块：${idm}。职衔：${role}。姓名：${state.protagonist.name || ''}。请给出这个角色此时合理的年龄（15-75 之间的整数；帝王/贵族/高官多在 30-55，平民多在 20-45，老臣可更高）。只回数字。`,
        temperature: 0.2, maxTokens: 8,
      }, adapterCfg);
      const n = parseInt(String(est.text || '').replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n) && n >= 15 && n <= 80) {
        state.protagonist.age = n;
        if (year) state.protagonist.birthYear = year - n + 1;
        return;
      }
    } catch { /* 估不到就走下面默认值 */ }
  }
  const def = { emperor: 35, noble: 38, official: 40, warlord: 42, commoner: 30 }[idm] || 35;
  state.protagonist.age = def;
  if (year) state.protagonist.birthYear = year - def + 1;
}

/* 年代→真实君主锚定：选了「某年 + 皇帝」开局时，若玩家没填姓名，主角就自动成为该年
   在位的真实君主（用户诉求：年号即定皇帝）；若玩家填了姓名，则**尊重玩家设定**，绝不把
   一个虚构皇帝/别的真实人物覆盖成另一个真皇帝。
   解析顺序：① 预置年代直查 rulersByEra → ② 按「政权 + 公元年」离线年表 resolveRuler
   （覆盖任意自定义年号，如正德元年）。解析不到才留空并提示 GM，绝不臆造帝号。
   非皇帝身份也记录「当朝天子」与该朝真实大事，供提示词自然提及。 */
function anchorRuler(pack, eraId, state) {
  const idm = state.identityModule || 'official';
  const gYear = state.clock.gregorianYear || 0;
  const polity = state.location.polity || '';

  // 1) 预置年代直查；2) 否则按 年份 + 政权 离线年表解析（任意自定义年号都行）
  let ruler = (pack.rulersByEra || {})[eraId];
  if (!ruler) ruler = resolveRuler(polity, gYear);

  // 真实大事：先用该君主在位大事，再用预置年代大事兜底
  const events = (ruler && ruler.events) || (eraId && (pack.eventsByEra || {})[eraId]) || [];

  // 玩家是否自己填了姓名（没填 → 表示「我要当这一年的真皇帝/真君主」）
  const explicitName = !!(state.protagonist.name && !/未命名|无名|（未命名）|\(未命名\)$/.test(state.protagonist.name));

  if (!ruler) {
    // 解析不到君主：不要瞎编，明确标记，让 GM 据实处理
    if (idm === 'emperor' && !explicitName) {
      state.protagonist.background = state.protagonist.background || '（未能自动查明该年真实君主，请勿臆造帝号与年岁，待你据史填定）';
    }
    state.eraEvents = events;
    return;
  }

  if (idm === 'emperor') {
    const isThisRuler = explicitName && ruler.name === state.protagonist.name;
    if (!explicitName) {
      // 没填姓名 → 玩家就是这一年的真实君主（年号即定皇帝）
      state.protagonist.name = ruler.name;
      state.protagonist.gender = ruler.gender || '男';
      if (ruler.born && gYear) { state.protagonist.age = gYear - ruler.born + 1; state.protagonist.birthYear = ruler.born; }
      else if (ruler.born) { state.protagonist.birthYear = ruler.born; }
      state.protagonist.role = `${ruler.title}（真实历史人物）`;
      state.protagonist.background = ruler.desc || state.protagonist.background;
      if (ruler.birthPlace) state.protagonist.nativePlace = ruler.birthPlace;
      state.location.controller = ruler.title;
      state.mode = 'real';
      state.anchors = {
        born: ruler.born || null,
        died: ruler.died || null,
        birthPlace: ruler.birthPlace || '',
        officeHistory: ruler.title,
        kin: '',
        events: ruler.events || [],
        qid: '',
      };
      state.eraEvents = ruler.events || [];
    } else {
      // 玩家填了姓名：尊重设定，不做覆盖。
      //  · 若与这一年真君主同名 → 他就是这位真君主，仅在他年龄缺失时补真实年龄；
      //  · 若不同名（别的真人物、或虚构人物）→ 既是他自称的皇帝，就不再强行注入与之冲突的君主大事，
      //    该年真实大势交由 runTurn 的「逐年检索」提供，避免叙事自相矛盾。
      state.eraEvents = isThisRuler ? (ruler.events || []) : [];
      if (isThisRuler && ruler.born && gYear && state.protagonist.age == null) {
        state.protagonist.age = gYear - ruler.born + 1; state.protagonist.birthYear = ruler.born;
      }
    }
    return;
  }

  // 非皇帝：记录当朝天子与该朝真实大事，供提示词自然提及
  state.reigningSovereign = `${ruler.title} ${ruler.name}`;
  state.eraEvents = events;
}

module.exports = { seed, historicalFigures, kinOfQid, inferPlaceFromText, generateHousehold, generateLocalCast, generateFactions, chooseOpening, dynastyBucket, localRoles, generateThreads, anchorRuler, defaultPlace, historyThreads, historyOpening, needsPlotRebuild, rebuildPlot, nativePlacePool, isSouthPolity, refreshEraEvents, shortLabel, roleWants };
