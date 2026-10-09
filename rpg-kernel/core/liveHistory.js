'use strict';
/**
 * 持续推进的真实历史：游戏内「年份」每向前走，就取该公元年的真实大事，注入 GM 提示词。
 *
 * 旧版的问题（故障 2）：直接抓中文维基「XXX年」词条，那是**世界年表**——拜占庭、突厥、百济混在一起，
 * 553 年（萧纪兵败被杀、西魏取蜀）抓回来的全是突厥可汗和君士坦丁堡公会议，梁事一条没有；
 * 而且整年原文一股脑塞进提示词，548 年 3 月就能看到 8 月侯景起兵。
 *
 * 现在：
 *   ① 本地年表（core/timeline.js）优先——有出处、有月份，最可靠；
 *   ② 联网只作补充：检索词带政权/人物限定，返回文本逐行做政权相关性过滤，剔除域外条目；
 *   ③ 都没有就明确标「未核定」，**宁可留白，不用无关内容填**；
 *   ④ 渲染时按当前月份截断：本年尚未到的月份一律不给 GM 看。
 */
const { search } = require('../adapters/search');

/* 各政权的相关性关键词（命中任一即算相关）。没登记的政权退回到「政权名本身」。 */
const POLITY_KEYS = {
  梁: ['梁', '萧', '侯景', '建康', '台城', '江陵', '成都', '蜀', '益州', '荆州', '湘东', '武陵', '西魏', '东魏', '北齐',
    '宇文', '高洋', '高澄', '陈霸先', '王僧辩', '尉迟迥', '襄阳', '寿阳', '巴陵', '郢州', '湘州'],
};
/* 明确的域外条目：命中即剔除（除非同一行也明确写到本政权要人） */
const FOREIGN = /拜占庭|東羅馬|东罗马|君士坦丁|突厥|柔然|百濟|百济|新羅|新罗|高句[丽麗]|倭|日本|波斯|薩珊|萨珊|羅馬|罗马|法蘭克|法兰克|哥特|哥德|教宗|教皇|查士丁尼|納爾西斯|纳尔西斯|阿瓦尔|吐谷浑可汗|印度|笈多|阿拉伯|西哥特|東哥特|东哥特|汪达尔|汪達爾|不列颠|公會議|公会议/;

function keysOf(polity, name) {
  const base = POLITY_KEYS[polity] || (polity ? [polity] : []);
  return name ? base.concat([name]) : base;
}
/* 从一行里抽月份（「八月——」「8月」「冬十月」）；抽不到返回 null */
const CN_NUM = { 正: 1, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 腊: 12, 臘: 12 };
function monthOf(line) {
  const m1 = /(?:^|[^\d])(\d{1,2})月/.exec(line);
  if (m1) { const n = Number(m1[1]); if (n >= 1 && n <= 12) return n; }
  const m2 = /(十[一二]|[正一二三四五六七八九十腊臘])月/.exec(line);
  if (m2 && CN_NUM[m2[1]]) return CN_NUM[m2[1]];
  return null;
}
/** 逐行过滤：只留与本政权相关、且不是域外大事的条目 */
function filterLines(text, polity, name) {
  const keys = keysOf(polity, name);
  const out = [];
  for (const raw of String(text || '').split(/\n+/)) {
    const line = raw.replace(/^[=\s·•\-]+|[=\s]+$/g, '').trim();
    if (line.length < 6) continue;
    if (/^(大事记|大事記|出生|逝世|中国|中國|其他|紀年|纪年)$/.test(line)) continue;
    const hit = keys.some(k => line.includes(k));
    if (!hit) continue;
    if (FOREIGN.test(line) && !(name && line.includes(name))) continue;
    out.push({ m: monthOf(line), text: line.slice(0, 160), source: 'online' });
  }
  return out;
}

async function fetchWikiYear(year) {
  const title = encodeURIComponent(year + '年');
  const url = `https://zh.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${title}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'PivotEngine/0.1 (history-rpg)' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const json = await res.json();
      const pages = json && json.query && json.query.pages;
      if (pages) for (const k of Object.keys(pages)) {
        const ext = pages[k] && pages[k].extract;
        if (ext && ext.length > 30) {
          // 只取「大事记」段，截到「出生」之前：出生/逝世名单不是「本年发生了什么」
          let txt = ext;
          const a = txt.indexOf('大事');
          if (a >= 0) txt = txt.slice(a);
          const b = txt.search(/\n=+\s*(出生|逝世)/);
          if (b > 0) txt = txt.slice(0, b);
          return txt;
        }
      }
    } catch (_) { /* 网络失败重试 */ }
    await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
  }
  return '';
}

/**
 * 取某年的真实大事。opts: { polity, name, place, online(默认 true) }
 * 返回 { year, lines:[{m,text,source,src?}], text, source, status }，status 为 'ok' 或 '未核定'。
 */
async function fetchYearEvents(year, opts = {}) {
  const polity = opts.polity || '';
  const name = opts.name || '';
  const lines = [];

  // ① 本地年表（有出处、有月份）
  try {
    const tl = require('./timeline');
    for (const e of tl.EVENTS.filter(x => x.y === year && (!polity || x.polity === polity))) {
      lines.push({ m: e.m || null, text: e.text, source: 'timeline', src: e.src, conf: e.conf, id: e.id });
    }
  } catch (_) { /* 无年表 */ }

  // ② 联网补充：按政权过滤；本地已有的同事不重复
  const sources = lines.length ? ['本地年表'] : [];
  if (opts.online !== false) {
    let online = filterLines(await fetchWikiYear(year), polity, name);
    if (!online.length) {
      try {
        const q = [`${year}年`, polity ? (polity === '梁' ? '南朝梁' : polity) : '中国', name].filter(Boolean).join(' ');
        // 走设置里选定的检索后端（如博查），失败才由 search() 自动兜底到维基
        const r = await search(q, { noCache: false });
        const txt = ((r && r.results) || []).map(x => `${x.title}：${x.snippet}`).join('\n');
        online = filterLines(txt, polity, name);
        if (online.length) sources.push(`${(r && r.provider) || '检索'}${r && r.fallbackFrom ? '（兜底）' : ''}（已按政权过滤）`);
      } catch (_) { /* 忽略 */ }
    } else sources.push('zh.wikipedia.org（已按政权过滤）');
    const seen = lines.map(l => l.text.slice(0, 6));
    for (const l of online) if (!seen.some(s => l.text.includes(s))) lines.push(l);
  }

  if (!lines.length) return { year, lines: [], text: '', source: '', status: '未核定' };
  return { year, lines, text: lines.map(l => `${l.m ? l.m + '月 ' : ''}${l.text}`).join('\n'), source: sources.join('、'), status: 'ok' };
}

/**
 * 给 GM 提示词用的「真实史实·本年」段落。
 * 按当前月份截断：本年尚未到的月份不给看；月份不明的联网条目标「未必已发生」。
 */
function renderLiveHistory(s) {
  const gy = s.clock && s.clock.gregorianYear;
  const h = gy && s.liveHistory && s.liveHistory[gy];
  if (!h) return '';
  if (h.status === '未核定' || (!h.text && !(h.lines || []).length)) {
    return `=== 真实史实 · 公元 ${gy} 年 ===\n本年与本政权相关的大事未核定。不得拿别处、别国的事充数，也不得自行编造全局大事；只写主角眼前的日常。`;
  }
  const mon = Number(s.clock.month) || 12;
  // 旧缓存（无 lines）：整段原文没法按月切，宁可不给
  if (!(h.lines || []).length) return '';
  const shown = [];
  for (const l of h.lines) {
    if (l.m && l.m > mon) continue;                         // 本年还没到的月份
    if (!l.m && l.source !== 'timeline') shown.push(`· （月份不明，未必已发生，不得写成既成事实）${l.text}`);
    else shown.push(`· ${l.m ? l.m + '月 ' : ''}${l.text}${l.src ? `〔${l.src}〕` : ''}`);
  }
  if (!shown.length) return '';
  return [
    `=== 真实史实 · 公元 ${gy} 年（截至本月；来源：${h.source}） ===`,
    '这些是天下已经发生的事，但**远方的事要经驿传/商旅才会传到主角所在地**：主角是否已知，以「外部消息 / 天下大势」块为准，不得让主角提前知道。',
    shown.join('\n'),
  ].join('\n');
}

module.exports = { fetchYearEvents, renderLiveHistory, filterLines, monthOf };
