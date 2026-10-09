'use strict';
/**
 * 四层核查流水线（把 v3.3 的「搜索链」变成可执行流程）
 *
 * 铁律：本模块**不做语义判断**，只做三件事：
 *   1. 按既定步骤构造查询串（你能看见它查了什么、为什么查）
 *   2. 把检索结果原文（标题+摘要+URL）搬回来当证据
 *   3. 给一个机械信号 + 三态定性（存疑 / 未见同名 / 信息缺口）
 *
 * 它永远不会输出"已验证可用"。搜不到 ≠ 不存在，这一点写在每一份报告里。
 */
const { search, sparql, loadConfig, PROVIDERS } = require('../adapters/search');
const { yearOf } = require('./reign');

const normTitle = t => String(t || '').replace(/[（(].*?[)）]/g, '').trim();

/* ---------------- 信号提取（纯机械） ---------------- */

function wikipediaSignal(name, res) {
  const inTitle = (res.results || []).filter(r => normTitle(r.title).includes(name));
  const inSnippet = (res.results || []).filter(r => (r.snippet || '').includes(name));
  return { provider: 'wikipedia', total: (res.results || []).length, inTitle: inTitle.length, inSnippet: inSnippet.length };
}

// Wikidata 的中国历史人物绝大多数来自 CBDB（中国历代人物传记资料库），
// 而且 wbsearchentities 是同时匹配 label 和 alias 的 —— 只要用「姓名」本身检索有返回，
// 就意味着数据库里存在这么一个挂着这个名字的真实人物条目。这比标题精确匹配更适合查重名。
// 代价：误报偏多，所以定性只到「存疑」，让你自己点开条目确认，不替你判死刑。
function wikidataSignal(res) {
  const re = /(dynasty|CBDB|emperor|official|poet|historian|person|人物|朝|民族)/i;
  const described = (res.results || []).filter(r => re.test(`${r.snippet} ${r.title}`));
  const total = (res.results || []).length;
  // 用姓名本身检索有结果 → 视为强信号；其中有 CBDB/朝代描述 → 更强
  return { provider: 'wikidata', total, cbdbLike: described.length, strong: total > 0 };
}

function genericSignal(res) {
  return { provider: res.provider, total: (res.results || []).length, error: res.error };
}

/* ---------------- 第一步：虚构 NPC 五步验证 ---------------- */

async function verifyNpcName({ name, era, eraWords, sources }) {
  const cfg = await loadConfig();
  const primary = sources?.[0] || cfg.provider;
  const secondary = sources?.[1] || (cfg.provider === 'wikidata' ? 'wikipedia' : 'wikidata');
  const steps = [];
  const evidence = [];

  const q1 = `"${name}"`;
  const q2 = `${name} ${era || ''} 历史人物 ${(eraWords || []).join(' ')}`.replace(/\s+/g, ' ').trim();

  steps.push({ n: 1, what: '确定候选姓名', detail: `候选：${name}` });
  steps.push({ n: 2, what: '构造并执行检索', detail: `主源 ${primary}：「${q1}」「${q2}」；补充源 ${secondary}：「${name}」` });

  const r1 = await search(q1, { provider: primary });
  const r2 = await search(q2, { provider: primary });
  const r3 = secondary !== primary ? await search(name, { provider: secondary }) : null;
  evidence.push({ label: `主源 · 精确短语`, ...compact(r1) });
  evidence.push({ label: `主源 · 姓名+时代`, ...compact(r2) });
  if (r3) evidence.push({ label: `补充源 · ${secondary}`, ...compact(r3) });

  let sig;
  if (primary === 'wikidata') sig = wikidataSignal(r1);
  else if (primary === 'wikipedia') sig = wikipediaSignal(name, r1);
  else sig = genericSignal(r1);
  const sig2 = primary === 'wikidata' ? wikipediaSignal(name, r2) : null;
  const sig3 = r3 ? (secondary === 'wikidata' ? wikidataSignal(r3) : wikipediaSignal(name, r3)) : null;

  const allFailed = [r1, r2, r3].filter(Boolean).every(r => r.error) || primary === 'off';
  let state, reason;
  if (allFailed) {
    state = '信息缺口';
    reason = '检索未成功或未启用，本轮无法给出任何关于重名的结论。不要据此假设名字可用。';
  } else {
    const collide =
      (sig.inTitle && sig.inTitle > 0) ||
      (sig.cbdbLike && sig.cbdbLike > 0) ||
      sig.strong === true ||
      (sig2 && sig2.inTitle > 0) ||
      (sig3 && (sig3.cbdbLike > 0 || sig3.inTitle > 0 || sig3.strong === true));
    const weak = (sig.inSnippet && sig.inSnippet > 0) || (sig2 && sig2.inSnippet > 0);
    if (collide) {
      state = '存疑';
      const where = [];
      if (sig.inTitle) where.push(`维基条目标题命中 ${sig.inTitle} 条`);
      if (sig.cbdbLike) where.push(`CBDB/朝代描述命中 ${sig.cbdbLike} 条`);
      if (sig.strong || sig3?.strong) where.push(`补充源 Wikidata 用该姓名直接检得 ${(sig3 || sig).total} 个实体`);
      reason = `${where.join('；')} —— 同名真实人物存在的可能性很高。按你的规则应改名并重跑这五步；直接点开下方证据条目确认真伪，别让引擎替你拍板。`;
    } else if (weak) {
      state = '存疑';
      reason = `未在条目标题命中，但在摘要中与「${era || '该时代'}」语境共现。可能是同名的次要人物、也可能是同字词误命中，需你自己打开证据条目确认。`;
    } else {
      state = '未见同名';
      reason = `当前配置的检索源里没有发现同名条目。**搜不到不等于不存在** —— 未入库的乡里小人物不会被任何搜索引擎收录，这里只能保证"不是有名可查的那批人"。`;
    }
  }

  steps.push({ n: 3, what: '判定', detail: `${state}。${reason}` });
  steps.push({
    n: 4, what: '补齐虚构人物必备三项（你填，引擎不替你编）',
    detail: '① 籍贯：某州某县（必须是该时期真实存在的州县名，再用右栏「核查当前地点」核一遍）② 身份背景：原为何业、何时投效 ③ 与既有人物的一条确切关系',
  });
  steps.push({
    n: 5, what: '登记进存档',
    detail: JSON.stringify({ name, age: '必填（随回合递增）', nativePlace: '待补', background: '待补', tie: '待补', goal: '待补', risk: '待补', defectionCondition: '待补', source: 'fictional' }, null, 0),
  });

  return { kind: 'npc', name, steps, evidence, verdict: { state, reason }, signals: [sig, sig2, sig3].filter(Boolean) };
}

/**
 * 相关性过滤：搜索引擎会返回一堆压根没提到目标词的条目。
 * 证据必须包含被核查的那个词（标题或摘要），否则剔除并如实记录被剔了多少条 ——
 * 宁可报「信息缺口」，也不能拿不相干的条目冒充证据。
 */
function relevant(results, token) {
  const t = String(token || '').trim();
  if (!t) return { keep: results || [], dropped: 0 };
  const keep = (results || []).filter(r => `${r.title || ''}${r.snippet || ''}`.includes(t));
  return { keep, dropped: (results || []).length - keep.length };
}

function compact(r, mustToken) {
  let shown = (r.results || []).slice(0, 5);
  let dropped = 0;
  if (mustToken) { const f = relevant(shown, mustToken); shown = f.keep; dropped = f.dropped; }
  return {
    provider: r.provider, query: r.query, tookMs: r.tookMs, cached: !!r.cached, error: r.error, dropped,
    total: (r.results || []).length,
    results: shown.map(x => ({ title: x.title, url: x.url, snippet: x.snippet, source: x.source })),
  };
}

/* ---------------- 第二步：真实历史人物（生卒年 / 官职 / 该年状态） ---------------- */

async function verifyPerson({ name, yearLabel, gregorianYear, role }) {
  const cfg = await loadConfig();
  const query = (s) => s.trim();
  // 第一条用精确短语：这是唯一能证明"条目里真的写到这个人"的查法
  const queries = [
    query(`"${name}"`),
    query(`${name} 生卒年 字号 籍贯`),
    query(`${name} ${yearLabel || gregorianYear || ''} 官职 事迹 传`),
  ];
  const evidence = [];
  for (const q of queries) evidence.push({ label: '检索', ...compact(await search(q, { provider: cfg.provider }), name) });
  const failed = evidence.every(e => e.error) || cfg.provider === 'off';
  const useful = evidence.some(e => (e.results || []).length > 0);

  // 机械信号：证据里是否出现生卒年数字（含「1027—1097」「1027年－1097年」等写法）
  const yearsSeen = new Set();
  evidence.forEach(e => (e.results || []).forEach(r => {
    const blob = `${r.snippet} ${r.title}`;
    blob.replace(/(\d{3,4})\s*年?\s*[-–—~－至到]\s*(\d{3,4})\s*年?/g, (m, a, b) => { yearsSeen.add(`${a}—${b}`); return m; });
    blob.replace(/(?:卒于|卒年|享年|生于|贬|迁)\D{0,3}(\d{3,4})\s*年/g, (m, a) => { yearsSeen.add(`提到${a}年`); return m; });
  }));

  const verdict = failed
    ? { state: '信息缺口', reason: '检索未成功或未启用，生卒年与官职无法核对。此时让该人物出场是有风险的。' }
    : !useful
      ? { state: '信息缺口', reason: `所有返回的条目在标题和摘要层都不含「${name}」三字，已作为不相干结果剔除。也就是说本轮没有拿到任何关于此人的有效证据，不能据此判断他在${yearLabel || gregorianYear}年前后是否在世。` }
      : yearsSeen.size
      ? { state: '存疑', reason: `证据中出现生卒年线索：${[...yearsSeen].slice(0, 5).join('、')}。是否与主角所在年份（${yearLabel || gregorianYear}）相容，必须你自己打开条目比对，引擎不做推算。` }
      : { state: '信息缺口', reason: `证据里没有明确的生卒年数字。该人物在${yearLabel || gregorianYear}年前后在世与否，本轮无法确认。` };

  return { kind: 'person', name, steps: queries.map((q, i) => ({ n: i + 1, what: '检索', detail: q })), evidence, verdict };
}

/* ---------------- 第三步：地点与控制者 ---------------- */

async function verifyPlace({ place, polity, yearLabel }) {
  const cfg = await loadConfig();
  const queries = [
    `${place} ${polity || ''} ${yearLabel || ''} 治所 沿革`.trim(),
    `${place} ${yearLabel || ''} 属 州县 建置`.trim(),
  ];
  const evidence = [];
  for (const q of queries) evidence.push({ label: '检索', ...compact(await search(q, { provider: cfg.provider }), place) });
  const failed = evidence.every(e => e.error) || cfg.provider === 'off';
  const anyHit = evidence.some(e => (e.results || []).length > 0);

  const verdict = failed
    ? { state: '信息缺口', reason: '检索未成功，地名真实性与归属未核。' }
    : anyHit
      ? { state: '存疑', reason: `查到了与「${place}」相关的条目，但该地在${yearLabel || ''}这一年究竟由谁实际掌控、是否为同名异地，需要你自己读条目确认。行政建置跨朝代变化极大。` }
      : { state: '信息缺口', reason: `未查到「${place}」相关条目。可能是该地在该时期确无独立条目，也可能是名称用字有误。` };

  return { kind: 'place', name: place, evidence, verdict };
}

/* ---------------- 第四步：措辞是否属于该时代 ---------------- */

async function verifyTerm({ term, era }) {
  const cfg = await loadConfig();
  const q = `"${term}" 出处 最早见于 ${era || ''}`.trim();
  const r = await search(q, { provider: cfg.provider });
  const failed = r.error || cfg.provider === 'off';
  const oldHit = (r.results || []).filter(x => /最早|见于|始见于|出自|首见/.test(x.snippet || ''));

  return {
    kind: 'term', name: term,
    evidence: [{ label: '检索', ...compact(r) }],
    verdict: failed
      ? { state: '信息缺口', reason: '检索未成功，无法判断该词的时代属性。' }
      : oldHit.length
        ? { state: '存疑', reason: `命中${oldHit.length}条讨论该词出处的证据，请自行判断是否确为该时代已有。` }
        : { state: '存疑', reason: '没有直接证据说明这个词在该时代已存在。宁可换掉，不要赌。' },
  };
}

/* ---------------- 真人模式：把一个人的史实底子挖出来 ---------------- */
const esc = s => String(s || '').replace(/["\\]/g, m => '\\' + m);

/**
 * 深度核查一个真实历史人物：生卒年、籍贯、亲属、同名候选。
 * 用 SPARQL 而不是通用搜索，因为末年的真人太多，通用搜索只会给你一堆同名条目。
 * 返回的东西全部带来源 ID，且一律标「存疑」——它只能给你候选，不能替你坐实。
 */
/**
 * 按姓名找 QID。不能直接拿中文 label 去 SPARQL 匹配 ——
 * Wikidata 的 zh 标签常是繁体（苏轼存成了「蘇軾」），直查简体一个都查不到。
 * 先用 wbsearchentities（它同时匹配 label 和 alias，且做简繁处理）拿到 QID，再按 QID 查。
 */
async function qidsByName(name, limit = 8) {
  const r = await search(name, { provider: 'wikidata' });
  const qids = (r.results || [])
    .map(x => (String(x.url).match(/\/wiki\/(Q\d+)/) || [])[1])
    .filter(Boolean)
    .slice(0, limit);
  return { qids, lookup: r };
}

/**
 * 判断一个真实人物是否「生活在」某个公元年。
 * 规则（从严，宁可拦住也不放行）：
 *   - 有生年：该年不得早于生年；
 *   - 有卒年：该年不得晚于卒年；
 *   - 只有卒年、无生年：按常寿 ~80 岁估算，该年不得早于 卒年−80（否则等于让他多活几百岁）；
 *   - 生卒全无：无法判断 → 返回 ok:false 且 unknown，让上层提示玩家自行确认。
 */
function personFitsYear({ born, died }, year) {
  const y = Number(year) || 0;
  if (!born && !died) return { ok: false, unknown: true, why: '此人没有生卒年记录，无法判定他是否活在这一年' };
  if (born && y < born) return { ok: false, why: `他生于公元 ${born} 年，不可能出现在 ${y} 年` };
  if (died && y > died) return { ok: false, why: `他卒于公元 ${died} 年，不可能活在 ${y} 年` };
  if (!born && died && y < died - 80) return { ok: false, why: `他卒于公元 ${died} 年，不可能生活在 ${y} 年（相差 ${died - y} 年）` };
  if (born && !died && y > born + 100) return { ok: false, why: `他生于公元 ${born} 年，到 ${y} 年已逾百岁，不合常理` };
  return { ok: true };
}

async function verifyRealPersonDeep({ name, era, gregorianYear }) {
  const { qids, lookup } = await qidsByName(name);
  if (!qids.length) {
    return {
      kind: 'realperson', name, candidates: [], kin: [], anchors: null,
      evidence: [{ label: '实体检索', provider: 'wikidata', query: name, error: lookup.error, results: lookup.results || [] }],
      verdict: { state: '信息缺口', reason: `Wikidata 里检索不到名为「${name}」的人物实体。可能是未收录的小人物，也可能用字不同。真人模式下，查不到底子的人不建议拿来扮演。` },
    };
  }
  const values = qids.map(q => `wd:${q}`).join(' ');
  // 加 P31=Q5 把书画、拓片、军舰、分类页这类同名杂物剔掉（苏轼能搜出一堆拓片）
  const personQ = `SELECT ?p ?pLabel ?dob ?dod ?pobLabel WHERE {
  VALUES ?p { ${values} }
  ?p wdt:P31 wd:Q5 .
  OPTIONAL{?p wdt:P569 ?dob} OPTIONAL{?p wdt:P570 ?dod} OPTIONAL{?p wdt:P19 ?pob}
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh,en" }
}`;
  const kinQ = `SELECT ?p ?kind ?relLabel WHERE {
  VALUES ?p { ${values} }
  { ?p wdt:P22 ?rel . BIND("父" AS ?kind) }
  UNION { ?p wdt:P25 ?rel . BIND("母" AS ?kind) }
  UNION { ?p wdt:P26 ?rel . BIND("配偶" AS ?kind) }
  UNION { ?p wdt:P40 ?rel . BIND("子女" AS ?kind) }
  UNION { ?p wdt:P3373 ?rel . BIND("兄弟姊妹" AS ?kind) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh,en" }
} LIMIT 40`;

  const [a, b] = await Promise.all([sparql(personQ), sparql(kinQ)]);
  const year = yearOf;
  const cands = (a.rows || []).map(r => ({
    qid: (r.p || '').split('/').pop(), label: r.pLabel, born: year(r.dob), died: year(r.dod),
    // 籍贯若是空节点，pobLabel 会返回一段 genid URL，那种值没有意义，丢掉
    birthPlace: (r.pobLabel && !/^https?:/.test(r.pobLabel)) ? r.pobLabel : '',
  }));
  const kin = [];
  const seenKin = new Set();
  for (const r of (b.rows || [])) {
    if (!r.relLabel) continue;
    const k = `${r.kind}|${r.relLabel}`;
    if (seenKin.has(k)) continue;
    seenKin.add(k); kin.push({ relation: r.kind, name: r.relLabel });
  }

  // 给每个候选标注：是否与开局年份相容
  for (const c of cands) { c.fitsEra = gregorianYear ? personFitsYear(c, gregorianYear) : { ok: true }; }
  const aliveAt = cands.filter(c => c.fitsEra && c.fitsEra.ok);
  const compatible = aliveAt;
  const withDates = cands.filter(c => c.born || c.died);

  let state, reason;
  if (a.error && b.error) { state = '信息缺口'; reason = 'SPARQL 查询失败，这个人的底子本轮查不到。真人模式下不建议让他出场。'; }
  else if (!cands.length) { state = '信息缺口'; reason = `Wikidata 里没有名为「${name}」的人物实体。可能是未入库的小人物，也可能名字用字不同（繁简、异体、字号混用）。`; }
  else if (gregorianYear && compatible.length && compatible.length < cands.length) {
    state = '存疑';
    reason = `同名人物 ${cands.length} 个，其中只有 ${compatible.length} 个可能活在你设定的公元 ${gregorianYear} 年（下方标「相容」的）。**其余与你的开局年代不相容，选不得**——真人与时代必须对得上。`;
  } else if (gregorianYear && !compatible.length) {
    state = '存疑';
    reason = `找到 ${cands.length} 个同名人物，但**没有一个活在你设定的公元 ${gregorianYear} 年**。这个姓名与你的开局年代对不上：要么改年号/年份，要么换一个人。`;
  } else if (withDates.length > 1) {
    state = '存疑';
    reason = `同名人物 ${cands.length} 个，其中 ${withDates.length} 个有生卒年 —— 这正是你说的「末年真人太多」。下方列出了全部候选，请指定你要扮演哪一个。`;
  } else if (withDates.length === 1) {
    const c = withDates[0];
    state = '存疑';
    reason = `唯一有生卒年的候选：${c.label}（${c.born ?? '?'}—${c.died ?? '?'}）${c.birthPlace ? '，籍贯 ' + c.birthPlace : ''}。请确认这就是你要扮演的人；确认后我会把生卒年写成硬约束写进提示词。`;
  } else {
    state = '存疑';
    reason = `找到 ${cands.length} 条同名实体但都没有生卒年，无法判断他是否活跃于${era || '该时期'}。请自己补充资料或换人。`;
  }

  return {
    kind: 'realperson', name,
    candidates: cands, kin, aliveAt,
    anchors: withDates.length ? { born: withDates[0].born, died: withDates[0].died, birthPlace: withDates[0].birthPlace, qid: withDates[0].qid } : null,
    evidence: [
      { label: 'SPARQL · 人物', provider: 'wikidata-sparql', query: personQ, tookMs: a.tookMs, error: a.error, results: cands.map(c => ({ title: `${c.label}（${c.born ?? '?'}—${c.died ?? '?'}）${c.birthPlace}`, url: `https://www.wikidata.org/wiki/${c.qid}`, snippet: '' })) },
      { label: 'SPARQL · 亲属', provider: 'wikidata-sparql', query: kinQ, tookMs: b.tookMs, error: b.error, results: kin.slice(0, 12).map(k => ({ title: `${k.relation}：${k.name}`, url: '', snippet: '' })) },
    ],
    verdict: { state, reason },
  };
}

/** 时段内挖人：给「这个朝代这个官职都有谁」一个候选名单 */
async function findCandidates({ name, from, to, limit = 20 }) {
  const f = Number(from), t = Number(to);
  const hasRange = Number.isFinite(f) && Number.isFinite(t);
  if (!name) {
    return {
      kind: 'candidates', count: 0, rows: [],
      verdict: { state: '信息缺口', reason: '不带姓名去筛全库会直接把 Wikidata 查超时。请填姓名（哪怕是姓），或者直接用「核查这个人」按具体人物查。' },
    };
  }
  // 同样先解析 QID：带姓名时走 wbsearchentities，避开繁简/别名问题
  const { qids } = await qidsByName(name, 30);
  const labelFilter = qids.length ? `VALUES ?p { ${qids.map(q => `wd:${q}`).join(' ')} }` : '';
  const dateFilter = hasRange
    ? `OPTIONAL{?p wdt:P569 ?dob} OPTIONAL{?p wdt:P570 ?dod}
       FILTER( (!BOUND(?dob) || YEAR(?dob) <= ${t}) && (!BOUND(?dod) || YEAR(?dod) >= ${f}) )`
    : `OPTIONAL{?p wdt:P569 ?dob} OPTIONAL{?p wdt:P570 ?dod}`;
  const q = `SELECT ?p ?pLabel ?dob ?dod ?sex WHERE {
  ?p wdt:P31 wd:Q5 . ${labelFilter}
  ${dateFilter}
  OPTIONAL{?p wdt:P21 ?sex}
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh,en" }
} LIMIT ${Math.min(Number(limit) || 20, 50)}`;
  let r = await sparql(q);
  // 年代过滤太严导致 0 命中时，放宽到不限年代再查一次，并如实说明放宽了
  let relaxed = false;
  if (hasRange && !(r.rows || []).length) {
    const q2 = `SELECT ?p ?pLabel ?dob ?dod ?sex WHERE {
  ?p wdt:P31 wd:Q5 . ${labelFilter}
  OPTIONAL{?p wdt:P569 ?dob} OPTIONAL{?p wdt:P570 ?dod}
  OPTIONAL{?p wdt:P21 ?sex}
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh,en" }
} LIMIT ${Math.min(Number(limit) || 20, 50)}`;
    const r2 = await sparql(q2);
    if ((r2.rows || []).length) { r = r2; relaxed = true; }
  }
  const year = yearOf;
  const SEX = { Q6581097: '男', Q6581072: '女', Q48270: '非二元' };
  // 同一个实体会因为多个 label/alias 被返回多次，按 QID 去重
  const seen = new Set();
  const rows = [];
  for (const x of (r.rows || [])) {
    const qid = (x.p || '').split('/').pop();
    if (!qid || seen.has(qid)) continue;
    seen.add(qid);
    const sx = (x.sex || '').split('/').pop();
    rows.push({ qid, label: x.pLabel, born: year(x.dob), died: year(x.dod), gender: SEX[sx] || '', url: `https://www.wikidata.org/wiki/${qid}` });
  }
  return {
    kind: 'candidates', count: rows.length, rows, error: r.error,
    verdict: {
      state: r.error ? '信息缺口' : rows.length ? '存疑' : '未见同名',
      reason: r.error ? 'SPARQL 查询失败。'
        : !rows.length ? `按姓名「${name}」没挖到人（${hasRange ? `${f}—${t} 年区间` : '不限年代'}）。Wikidata 对下层人物覆盖很薄，这是它的边界，不是你名字写错了。`
        : `${hasRange ? (relaxed ? `在 ${f}—${t} 年内没命中，已放宽到不限年代，` : `在 ${f}—${t} 年内`) : ''}挖到 ${rows.length} 人，姓名匹配「${name}」。末年同名极多，这是候选不是结论 —— 逐个点开确认你要的是哪一个。`,
    },
  };
}

async function providerStatus() {
  const cfg = await loadConfig();
  const p = PROVIDERS[cfg.provider];
  return {
    current: cfg.provider,
    currentName: p ? p.displayName : (cfg.provider === 'off' ? '关闭检索' : '未知'),
    free: p ? !!p.free : true,
    note: p ? p.note : '',
  };
}

module.exports = { verifyNpcName, verifyPerson, verifyPlace, verifyTerm, verifyRealPersonDeep, findCandidates, providerStatus, personFitsYear };
