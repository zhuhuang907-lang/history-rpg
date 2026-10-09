'use strict';
/**
 * 真实地理检索层：把「随机生成的地形/物产」换成「从史料与地图里查出来的真实信息」。
 *
 * 三件事：
 *  1) resolvePlace()     —— 地名 → 维基条目 + 真实正文（带检索兜底，找不到就明说找不到）
 *  2) placeGeography()   —— 从真实正文里抽出地形/水系/道路/物产（交给 LLM 结构化，抽不到的字段写「不详」，绝不编）
 *  3) historicalMaps()   —— 从维基共享资源(Commons)取**当时的真实历史地图图片**，直接贴到界面上
 *
 * 原则仍是「宁缺毋滥」：查不到就说查不到，不用随机词冒充真实地理。
 */
const { search } = require('../adapters/search');

const UA = { 'User-Agent': 'PivotEngine/0.1 (history-rpg; contact: local)' };

async function getJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!res.ok) { last = new Error(`HTTP ${res.status}`); await new Promise(r => setTimeout(r, 400 * (i + 1))); continue; }
      return await res.json();
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
  throw last;
}

/** 取某维基条目的纯文本正文（redirects 跟随繁简/别名重定向） */
async function wikiExtract(title, lang = 'zh') {
  const u = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`;
  const j = await getJson(u);
  const pages = (j && j.query && j.query.pages) || {};
  for (const k of Object.keys(pages)) {
    const p = pages[k];
    if (p && p.extract && p.extract.length > 30) return { title: p.title, extract: p.extract };
  }
  return null;
}

/**
 * 地名 → 真实条目。先直接查，查不到再用检索找候选条目，最后回退到「去掉末字」的上级地名
 * （如「鲁阳县」→「鲁山县」，古籍里常写作鲁阳）。
 */
async function resolvePlace(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  // 逐个候选试：原样 → 去掉行政区后缀 → 古名/别名对应的真实条目 → 去掉末字
  const cands = [raw];
  const stripped = raw.replace(/[县州府郡路省市道镇城]$/, '');
  if (stripped && stripped !== raw) cands.push(stripped);
  for (const key of [raw, stripped]) {
    if (key && RESOLVE_ALIAS[key]) cands.push(...RESOLVE_ALIAS[key]);
  }

  for (const t of cands) {
    try { const r = await wikiExtract(t); if (r) return { ...r, query: t, via: 'direct' }; } catch { /* 继续 */ }
  }
  // 检索兜底：用维基搜索找最相关的条目（但必须与地名相关，否则宁可返回找不到）
  try {
    const r = await search(`${raw} 历史 地理`, { provider: 'wikipedia', noCache: false });
    const core = stripped || raw;
    for (const hit of (r.results || [])) {
      const title = String(hit.title || '');
      const snip = String(hit.snippet || '');
      // 相关性把关（从严）：标题或摘要里必须真的出现这个地名，
      // 否则会把「鲁阳」错配成《华阳国志》（只因共用一个「阳」字）
      if (!title.includes(core) && !snip.includes(core)) continue;
      if (/之战|之戰|战役|起義|起义|事件|条约|條約|之乱|之亂/.test(title)) continue;
      const ex = await wikiExtract(title);
      if (ex) return { ...ex, query: raw, via: 'search' };
    }
  } catch { /* 继续 */ }
  // 回退：上级地名（去掉最末一级）
  const parts = raw.split(/[\s·、]/).filter(Boolean);
  if (parts.length > 1) {
    try { const r = await wikiExtract(parts[parts.length - 2]); if (r) return { ...r, query: parts[parts.length - 2], via: 'parent' }; } catch { /* 继续 */ }
  }
  return null;
}

/* 今名 → 历代古名（用户要求：地理要用当时的古地名，不能拿现代区划当古代）。
   键为今名关键字，值为 [{re:适用的年号/朝代特征, name:古名}]，取第一个匹配；无匹配用第一项。 */
const ANCIENT_NAME = [
  { key: '西安', list: [{ re: /秦|汉|晋|隋|唐|周/, name: '长安' }, { re: /明|清/, name: '西安' }] },
  { key: '北京', list: [{ re: /秦|汉/, name: '蓟' }, { re: /隋|唐|五代/, name: '幽州' }, { re: /辽|金/, name: '燕京' }, { re: /元/, name: '大都' }, { re: /明|清/, name: '北京' }] },
  { key: '南京', list: [{ re: /三国|晋|南北朝|隋|唐/, name: '建康' }, { re: /宋/, name: '江宁' }, { re: /明/, name: '南京' }, { re: /清/, name: '江宁' }] },
  { key: '开封', list: [{ re: /战国|魏/, name: '大梁' }, { re: /汉|晋|隋|唐/, name: '汴州' }, { re: /五代|宋|金|元|明|清/, name: '汴梁' }] },
  { key: '洛阳', list: [{ re: /.*/, name: '洛阳' }] },
  { key: '扬州', list: [{ re: /秦|汉/, name: '广陵' }, { re: /三国|晋|南北朝/, name: '广陵' }, { re: /隋|唐|五代/, name: '江都' }, { re: /宋|元|明|清/, name: '扬州' }] },
  { key: '杭州', list: [{ re: /秦|汉|晋|隋|唐/, name: '钱唐' }, { re: /宋/, name: '临安' }, { re: /元|明|清/, name: '杭州' }] },
  { key: '成都', list: [{ re: /.*/, name: '成都' }] },
  { key: '太原', list: [{ re: /汉|晋|南北朝|隋|唐/, name: '晋阳' }, { re: /宋|元|明|清/, name: '太原' }] },
  { key: '广州', list: [{ re: /汉|晋|南北朝|隋|唐|宋/, name: '番禺' }, { re: /明|清/, name: '广州' }] },
  { key: '绍兴', list: [{ re: /.*/, name: '会稽' }] },
  { key: '武汉', list: [{ re: /三国|晋|南北朝/, name: '夏口' }, { re: /隋|唐|宋/, name: '鄂州' }] },
  { key: '荆州', list: [{ re: /.*/, name: '江陵' }] },
  { key: '南阳', list: [{ re: /.*/, name: '宛' }] },
  { key: '安阳', list: [{ re: /商/, name: '殷' }, { re: /汉|晋|南北朝|隋|唐|宋/, name: '邺' }] },
  { key: '许昌', list: [{ re: /汉|三国/, name: '许' }, { re: /.*/, name: '许州' }] },
  { key: '平顶山', list: [{ re: /.*/, name: '鲁阳' }] },
];
/* 古名（或地名别名）→ 维基上确实存在的条目名，按序试。
   用处：玩家填的是古名（鲁阳/建康/汴梁），维基常只有「鲁山县」「建康」这类条目，
   直接查古名会查空 —— 有了这张表就能查到真实记载。 */
const RESOLVE_ALIAS = {
  鲁阳: ['鲁山县', '鲁阳'], 江都: ['江都', '扬州'], 广陵: ['扬州'], 长安: ['长安', '西安市'],
  建康: ['建康', '南京市'], 金陵: ['建康', '南京市'], 汴梁: ['汴梁', '开封市'], 大梁: ['开封市'],
  北京: ['北京城', '北京市'], 北平: ['北京城', '北京市'], 顺天府: ['顺天府', '北京城'],
  大都: ['大都', '北京城'], 蓟: ['蓟', '北京城'], 幽州: ['幽州', '北京城'],
  临安: ['临安', '杭州市'], 钱唐: ['杭州市'], 会稽: ['绍兴市'], 晋阳: ['晋阳', '太原市'],
  番禺: ['番禺', '广州市'], 洛阳: ['洛阳市'], 许: ['许昌市'], 邺: ['邺', '安阳市'],
  宛: ['南阳市'], 江陵: ['荆州市'], 夏口: ['武汉市'], 鄂州: ['武汉市'],
  咸阳: ['咸阳市'], 成都: ['成都市'], 太原: ['太原市'], 襄阳: ['襄阳市'],
};

/** 把现代地名换成当时适用的古地名（无法判断就原样返回） */
function eraNameOf(place, eraLabel, polity) {
  const s = `${eraLabel || ''} ${polity || ''}`;
  const p = String(place || '');
  for (const e of ANCIENT_NAME) {
    if (!p.includes(e.key)) continue;
    const hit = e.list.find(x => x.re.test(s)) || e.list[0];
    return p.replace(e.key, hit.name);
  }
  return p;
}

/* 现代行政区划 / 统计口径 / 现代设施的句子：地理描述里必须剔除
   （否则会写出"位于江苏省中部""京沪高速穿境""海拔5米"这种现代话） */
const MODERN_ADMIN = new RegExp([
  '中华人民共和国', '下辖', '市政府', '人民政府', '地级市', '县级市', '副中心', '城市群', '都市圈', '建成区',
  '总面积', '平方[公千]米', '平方公里', '常住人口', '户籍人口', '国内生产总值', 'GDP', '邮政编码', '电话区号', '车牌',
  '行政区划代码', '市境', '省[中东]?[南北]?部', '街道办', '社区', '村民委员会', '国家历史文化名城',
  // 现代交通/设施
  '铁路', '高铁', '地铁', '高速', '国道', '省道', '公路', '通车', '机场', '港口', '码头', '车站',
  '开发区', '工业园', '高新区', '风景区', '旅游区', '保护区', '博物馆', '体育中心', '会展中心',
  // 现代度量/统计表述
  '海拔', '坡度', '千米', '公里', '平方米', '万人', '亿吨', '千瓦', '兆瓦',
  '截至\\s*\\d{4}\\s*年', '\\d{4}\\s*年\\s*[，,]\\s*(?:全市|全区|全县|人口|GDP)',
].join('|'));

/** 过掉含现代行政区划/统计口径的句子 */
function stripModernAdmin(text) {
  const kept = String(text || '')
    .split(/(?<=[。；;\n])/)
    .map(s => s.trim())
    .filter(s => s && !MODERN_ADMIN.test(s));
  return kept.join('');
}

/** 从真实正文里截取与地理相关的段落，喂给 LLM 做结构化 */
function geoRelevantText(extract, max = 1800) {
  const t = String(extract || '');
  const keys = ['地形', '地势', '水系', '河流', '河', '湖', '山', '气候', '物产', '出产', '位置', '地理', '境内', '东与', '西邻', '南接', '北靠', '据', '扼', '通'];
  const paras = t.split(/\n+/).filter(p => p.trim());
  const picked = [];
  for (const p of paras) { if (keys.some(k => p.includes(k))) picked.push(p.trim()); if (picked.join('').length > max) break; }
  const out = (picked.length ? picked.join('\n') : t).slice(0, max);
  return stripModernAdmin(out).slice(0, max);
}

/**
 * 真实地理：先取真实正文，再交给 LLM 只做「抽取」，绝不让它编。
 * 抽不到的字段一律写「不详」。返回 { fields, source, note }。
 */
async function placeGeography(placeName, { adapter, config, eraLabel, polity } = {}) {
  // 先用当时适用的古地名去查（如 唐·扬州→江都、明·南京→南京、汉·北京→蓟），
  // 查不到再退回玩家给的写法，避免拿现代区划当古代。
  const eraName = eraNameOf(placeName, eraLabel, polity);
  let art = await resolvePlace(eraName);
  if (!art && eraName !== placeName) art = await resolvePlace(placeName);
  if (!art) {
    return { fields: {}, eraName, source: '', note: `检索不到「${placeName}」的真实地理记载，相关路程/地形一律按「不详」处理，不编造。`, resolved: false };
  }
  const text = geoRelevantText(art.extract);
  if (!adapter) return { fields: {}, eraName, source: `zh.wikipedia.org/${art.title}`, note: '（未接 LLM，仅取到原文，未结构化）', raw: text, resolved: true };

  const ask = `下面是从维基百科「${art.title}」条目摘出的**真实原文**。请只依据它，抽成本地地理条目。
时代：${[eraLabel, polity].filter(Boolean).join(' ') || '不详'}。地点：${eraName}。

硬性要求：
1. 一律使用**当时的古地名**（如长安、江都、汴梁、建康），不得改用现代市名、区名；
2. 只取与「山川形势、交通水陆、物产、风雨灾异」有关的真实描述；
3. **严禁**写入现代行政区划与统计口径（如「位于××省中部」「下辖××区」「总面积××平方公里」「常住人口」「市政府驻」）——这些一律不要；
4. 原文没写的字段，值写「不详」；**严禁**用你的常识补充。不要解释，只输出 JSON。

原文：
${text}

输出 JSON（字段固定）：
{"地形":"","水系":"","道路驿站":"","物产":"","常发灾异":""}`;

  try {
    const r = await adapter.call({ system: '你是史料摘录助手，只做抽取，不补充、不推测、不编造，一律用当时的古地名。只输出 JSON。', prompt: ask }, config || {});
    let s = String(r.text || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) s = fence[1];
    const i = s.indexOf('{'), k = s.lastIndexOf('}');
    if (i < 0 || k < 0) throw new Error('返回里没有 JSON');
    const raw = JSON.parse(s.slice(i, k + 1));
    // 再过一道：即便模型漏进来现代区划句，也在落盘前剔掉
    const fields = {};
    for (const [k2, v] of Object.entries(raw)) fields[k2] = stripModernAdmin(String(v || ''));
    return { fields, source: `zh.wikipedia.org/${art.title}（条目真实正文）`, resolved: true, via: art.via, eraName };
  } catch (e) {
    return { fields: {}, source: `zh.wikipedia.org/${art.title}`, note: '结构化失败（' + String(e.message || e).slice(0, 60) + '），附原文供参考：' + text.slice(0, 260), resolved: true };
  }
}

/* ------------------------------------------------------------------ */
/* 历史地图：按「最近时期」来找                                          */
/* ------------------------------------------------------------------ */

/* 谭其骧《中国历史地图集》八册（自原始社会至清末，共 304 幅）。 */
const ATLAS_VOLUMES = [
  { vol: '第一册', period: '原始社会·夏·商·西周·春秋·战国', from: -2070, to: -221 },
  { vol: '第二册', period: '秦·西汉·东汉', from: -221, to: 220 },
  { vol: '第三册', period: '三国·西晋', from: 220, to: 316 },
  { vol: '第四册', period: '东晋十六国·南北朝', from: 317, to: 589 },
  { vol: '第五册', period: '隋·唐·五代十国', from: 581, to: 979 },
  { vol: '第六册', period: '宋·辽·金', from: 960, to: 1279 },
  { vol: '第七册', period: '元·明', from: 1271, to: 1644 },
  { vol: '第八册', period: '清', from: 1644, to: 1911 },
];

/* 常见年号 → 公元范围（用于解析「万历年间的明朝」这类标题，判断它贴近哪一年） */
const ERA_RANGES = [
  { re: /万历/, from: 1573, to: 1620, name: '万历' },
  { re: /嘉靖/, from: 1522, to: 1566, name: '嘉靖' },
  { re: /正德/, from: 1506, to: 1521, name: '正德' },
  { re: /弘治/, from: 1488, to: 1505, name: '弘治' },
  { re: /成化/, from: 1465, to: 1487, name: '成化' },
  { re: /永乐/, from: 1403, to: 1424, name: '永乐' },
  { re: /洪武/, from: 1368, to: 1398, name: '洪武' },
  { re: /崇祯/, from: 1628, to: 1644, name: '崇祯' },
  { re: /天启/, from: 1621, to: 1627, name: '天启' },
  { re: /康熙/, from: 1662, to: 1722, name: '康熙' },
  { re: /乾隆/, from: 1736, to: 1795, name: '乾隆' },
  { re: /道光/, from: 1821, to: 1850, name: '道光' },
  { re: /开元/, from: 713, to: 741, name: '开元' },
  { re: /天宝/, from: 742, to: 756, name: '天宝' },
  { re: /贞观/, from: 627, to: 649, name: '贞观' },
  { re: /熙宁/, from: 1068, to: 1077, name: '熙宁' },
  { re: /建炎|绍兴/, from: 1127, to: 1162, name: '南宋初' },
  { re: /建安/, from: 196, to: 220, name: '建安' },
  { re: /建兴/, from: 313, to: 317, name: '建兴' },
  { re: /太元/, from: 376, to: 396, name: '太元' },
  { re: /大业/, from: 605, to: 618, name: '大业' },
  { re: /至正/, from: 1341, to: 1368, name: '至正' },
  { re: /始皇帝|始皇/, from: -246, to: -210, name: '秦' },
  { re: /元狩/, from: -122, to: -117, name: '汉武帝' },
];

function atlasOf(year) {
  const y = Number(year) || 0;
  const v = ATLAS_VOLUMES.find(x => y >= x.from && y <= x.to);
  return v ? { volume: v.vol, period: v.period } : { volume: '', period: '' };
}

/** 从标题里尽量parse出一个「代表年份」，用于判断这张图贴不贴近本局年代。 */
function yearOfTitle(title) {
  const t = String(title || '');
  // 直接的 3~4 位年份（排除明显不是年份的）
  const ys = [...t.matchAll(/(?<![0-9])(1[0-9]{3}|[2-9][0-9]{2})(?![0-9])/g)].map(m => Number(m[1]));
  if (ys.length) return { year: ys[0], how: 'explicit' };
  // 年号 → 取该年号区间中点
  for (const e of ERA_RANGES) if (e.re.test(t)) return { year: Math.round((e.from + e.to) / 2), how: 'era:' + e.name };
  // 朝代名 → 取该册中点
  for (const v of ATLAS_VOLUMES) {
    const head = v.period.split(/[·、]/).find(Boolean) || '';
    if (head && t.includes(head)) return { year: Math.round((v.from + v.to) / 2), how: 'dynasty:' + head };
  }
  return { year: null, how: 'unknown' };
}

/** 可检索的几个真实历史地图站点（供玩家自行查证；不保证全部可直接抓图） */
function mapSources(eraLabel, polity, year) {
  const q = `${polity || ''} ${eraLabel || ''} ${year || ''}`.trim();
  const A = atlasOf(year);
  return [
    { name: '维基共享资源（本页贴图即取自此）', url: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(q + ' 历史地图')}&title=Special:MediaSearch&type=image` },
    { name: `中国历史地图（谭其骧《中国历史地图集》WebGIS${A.volume ? '·' + A.volume + ' ' + A.period : ''}）`, url: 'https://history-map.osgeo.cn/' },
    { name: '中华舆图（国家测绘局·历代古地图）', url: 'http://tweb.tianditu.com/guditu/' },
    { name: '历史地图网（按朝代分类）', url: 'http://www.txlzp.com/lishi/' },
    { name: '史图馆（B 站历史地图，无公开接口，仅供查找）', url: `https://search.bilibili.com/all?keyword=${encodeURIComponent((polity || '') + ' 疆域变化')}` },
  ];
}

/**
 * 真实历史地图：从维基共享资源里按「最近时期」检索。
 * 做法：多组检索词 → 标题里解析代表年份 → **按与本局年代的贴近度排序**，最贴近的排最前。
 */
async function historicalMaps(query, limit = 4, keywords = [], targetYear = null) {
  const gsr = encodeURIComponent(query);
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search'
    + `&gsrsearch=${gsr}&gsrnamespace=6&gsrlimit=${Math.min(limit * 6, 30)}`
    + '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1000&format=json';
  try {
    const j = await getJson(u);
    const pages = (j && j.query && j.query.pages) || {};
    const out = [];
    for (const k of Object.keys(pages)) {
      const p = pages[k];
      const ii = (p.imageinfo || [])[0] || {};
      const url = ii.thumburl || ii.url;
      const title = String(p.title || '').replace(/^File:/, '').replace(/\.[a-z]+$/i, '');
      if (!url) continue;
      if (!/\.(png|jpe?g|gif|svg)/i.test(p.title || '')) continue;
      if (keywords.length && !keywords.some(w => title.includes(w))) continue;
      const { year: ty, how } = yearOfTitle(title);
      const dist = (targetYear && ty != null) ? Math.abs(ty - targetYear) : null;
      const em = ii.extmetadata || {};
      out.push({
        title, url,
        year: ty, yearHow: how, yearDist: dist,
        page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title || '')}`,
        author: em.Artist ? String(em.Artist.value).replace(/<[^>]+>/g, '').slice(0, 60) : '',
        license: em.LicenseShortName ? String(em.LicenseShortName.value).slice(0, 30) : '',
      });
    }
    // 质量闸一：像「地图」的标题才留（排除陵墓、棺椁、铜镜这类搜索噪声）；若全被滤掉则回退
    const MAPLIKE = /地图|地圖|疆域|舆图|輿圖|全图|輿地|map|atlas|territor|province|realm|gebiet|karte|reich/i;
    const mapLike = out.filter(x => MAPLIKE.test(x.title));
    let pool = mapLike.length ? mapLike : out;
    // 「最近时期」排序：能定年份的按年代贴近度排前，定不出年份的排后
    pool.sort((a, b) => {
      const da = a.yearDist == null ? Number.MAX_SAFE_INTEGER : a.yearDist;
      const db = b.yearDist == null ? Number.MAX_SAFE_INTEGER : b.yearDist;
      return da - db;
    });
    // 质量闸二：若已有贴近年代的结果，就把明显不是同一时期的误匹配剔掉
    // （例：找「晋」会混进女真「金朝 1115」，字不同但英文都叫 Jin）
    const best = pool.find(x => x.yearDist != null);
    const cut = best && best.yearDist <= 150 ? 300 : null;
    const filtered = cut == null ? pool : pool.filter(x => x.yearDist == null || x.yearDist <= cut);
    return filtered.slice(0, limit);
  } catch { return []; }
}

module.exports = { resolvePlace, placeGeography, historicalMaps, wikiExtract, geoRelevantText, atlasOf, yearOfTitle, mapSources, eraNameOf, stripModernAdmin, ATLAS_VOLUMES, ERA_RANGES, ANCIENT_NAME };
