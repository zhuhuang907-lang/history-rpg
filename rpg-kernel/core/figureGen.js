'use strict';
/**
 * 任意人物自动建档：玩家输入任何一个真实历史人物，引擎用**游戏里已配置的模型 API + 检索**，
 * 生成一份与 figure-data.js 里「萧纪」同构的核验档案：
 *   生卒（精确到月可考者）、逐年官职与驻地、身份轨迹、分月处境、处境所指的结构性矛盾、
 *   身边真实人物、派系框架、已否定设定、以及该政权在此人前后几年的年表事件。
 *
 * 为什么不直接让模型「自由发挥」：萧纪剧本崩掉的原因恰恰是剧情靠模型记忆，
 * 时间、地点、谁活着全靠猜。所以这里的流程是：
 *   ① 先检索：维基正文 + 检索后端 + Wikidata（dossier.identify），拿到**证据原文**；
 *   ② 再让模型**只依据证据**填结构化 JSON，每条必须带出处；
 *   ③ 最后由程序做确定性校验——生卒自洽、官职在生年之内、事件在证据里有对应字句、
 *      没出处的一律丢弃；模型生成的条目可信度最高只给 medium，并标 generated；
 *   ④ 校验通过才落盘（data/figures/<姓名>.json）并注册进人物档案与年表。
 * 模型不可用或证据不足时，**不建档**，开局退回原有的通用流程，并把原因告诉玩家。
 */
const fs = require('fs');
const path = require('path');

const GEN_DIR = path.join(process.env.RPG_DATA_DIR || path.join(__dirname, '..', 'data'), 'figures');

/* ---------------- ① 证据 ---------------- */
async function wikiExtract(title) {
  const url = `https://zh.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&variant=zh-cn&titles=${encodeURIComponent(title)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'PivotEngine/0.1 (history-rpg)' }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return '';
    const j = await res.json();
    const pages = (j && j.query && j.query.pages) || {};
    for (const k of Object.keys(pages)) if (pages[k] && pages[k].extract) return pages[k].extract;
  } catch (_) { /* 网络失败 */ }
  return '';
}

async function gatherEvidence(name, year, polity) {
  const parts = [];
  const sources = [];
  const page = await wikiExtract(name);
  if (page) { parts.push(`【维基百科·${name}】\n${page.slice(0, 7000)}`); sources.push(`zh.wikipedia.org/wiki/${name}`); }
  try {
    const { search } = require('../adapters/search');
    for (const q of [`${name} 传`, `${name} ${year}年 ${polity || ''}`.trim()]) {
      const r = await search(q, { noCache: false }).catch(() => null);
      const hits = ((r && r.results) || []).slice(0, 5);
      if (hits.length) {
        parts.push(`【检索：${q}】\n` + hits.map(h => `· ${h.title}：${String(h.snippet || '').slice(0, 300)}`).join('\n'));
        sources.push(`检索：${q}（${(r && r.provider) || '默认后端'}）`);
      }
    }
  } catch (_) { /* 检索不可用 */ }
  let ident = null;
  try { ident = await require('./dossier').identify(name, year, polity); } catch (_) { /* 忽略 */ }
  if (ident && ident.found) {
    parts.push(`【结构化核定】生 ${ident.born ?? '?'}，卒 ${ident.died ?? '?'}，身份 ${ident.role || '?'}，籍贯 ${ident.nativePlace || '?'}`);
  }
  return { text: parts.join('\n\n'), sources, ident };
}

/* ---------------- ② 模型按证据填表 ---------------- */
const SCHEMA_HINT = `{
  "name": "姓名", "aliases": ["繁体或别名"], "born": 公元生年数字, "died": 公元卒年数字, "diedM": 卒月数字或null,
  "polity": "所属政权（如 梁、唐、北宋）", "gender": "男/女",
  "father": "父（可空）", "traits": "才干性情（证据原话概括）",
  "posts": [{"from": 年, "to": 年, "title": "官职/爵位", "seat": "实际驻地（古地名）", "kind": "职 或 爵", "src": "出处"}],
  "timeline": [{"y": 年, "m": 月或null, "kind": "post/rank/event/death", "text": "这一年他身上发生的事", "seat": "驻地(可空)", "identity": "仅称帝时填 emperor"}],
  "resources": {"note": "他能调动的资财兵马（证据原话）", "src": "出处"},
  "situation": { "年份": [ {"from": 起始月, "text": "此时此地他的真实处境（只写他所在地已能知道的事）", "tension": "矛盾 id 或 null", "src": "出处", "basis": "recorded/inferred"} ] },
  "tensions": { "T-SIT-xxx": {"name": "四到八字的事名", "label": "一句话问题", "parties": ["一方","另一方"], "wants": {"一方":"所求","另一方":"所求"}, "whyNotResolved": "为何难解（具体）", "actions": ["可采取的实际行动", "至少三条"], "ifUnresolved": "拖下去会怎样", "src": "出处", "basis": "fact/recorded/inferred"} },
  "circle": [{"name": "真实人物", "relation": "与他的关系", "role": "当时职掌", "seat": "所在地", "born": 年或null, "died": 年或null, "far": 是否远方要人(true/false), "note": "史载要点", "src": "出处"}],
  "factions": [{"from": [年, 月], "title": "甲 对 乙", "sideA": "甲", "sideB": "乙", "stake": "争什么", "src": "出处"}],
  "denied": [{"text": "常见的错误说法（短语）", "why": "为什么错", "src": "出处"}],
  "events": [{"y": 年, "m": 月, "d": 日或null, "text": "该政权的大事", "place": "发生地（古地名）", "keys": ["几种常见说法"], "src": "出处"}]
}`;

const SYSTEM = [
  '你是严谨的中国史档案编纂官。你的任务是把【证据】整理成一份结构化人物档案，供历史模拟游戏使用。',
  '铁律：',
  '1. 只写证据里有、或正史常识里确定无疑的内容；查不到的字段留空或给 null，绝不补编。',
  '2. 每条官职、处境、矛盾、人物、事件都必须带 src（如《梁书·某某传》《资治通鉴·某纪》或「维基百科」）。',
  '3. 处境（situation）要按月份分段，并考虑消息传递的时间：远方的事传到他所在地之前，他不知道。',
  '4. 处境要有「日常」：没有大事压身的时段，就写他在任上实际在办的日常政务，tension 给 null。',
  '5. 矛盾（tensions）必须是他在那个时点真正要做的抉择，各方所求要具体，行动要是那个时代真实可行的。',
  '   处境与矛盾只写「那一刻」：不写后来的结果与胜负；actions 是摆在他面前的若干选择（含史实上他没选的），不是史实答案的复述。',
  '6. circle 只收史书有名、且在开局那一年**仍在世**、与他同地或有直接关系的人；每人必须给生卒年（都查不到的会被程序丢弃）；',
  '   role 写此人在开局那一年的身份（不是后来的身份）；远在他地、只有名义统属的要人标 far:true。',
  '7. events 只收他所属政权（及直接相关的邻国）在他开局前三年到身后五年间的大事，带月份。',
  '8. 人名、地名、官名一律照抄证据原文的写法（证据是繁体就写繁体），程序会拿它回证据里核对。',
  '9. 只输出一个 JSON 对象，不要任何解释文字。',
].join('\n');

function parseJson(text) {
  const t = String(text || '');
  const tryP = s => { try { return JSON.parse(s); } catch { return null; } };
  let j = tryP(t.trim());
  if (!j) { const m = t.match(/```(?:json)?\s*([\s\S]*?)```/) || t.match(/(\{[\s\S]*\})/); if (m) j = tryP(m[1].trim()); }
  return j && typeof j === 'object' ? j : null;
}

/* 被截断的 JSON：去掉最后一个不完整的元素，补齐括号（能救则救，救不了返回原文） */
function closeJson(text) {
  let s = String(text || '');
  const i = s.indexOf('{');
  if (i < 0) return s;
  s = s.slice(i).replace(/```[\s\S]*$/, '');
  const stack = [];
  let inStr = false, esc = false, lastSafe = 0;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') { stack.pop(); lastSafe = k + 1; }
    else if (ch === ',') lastSafe = k;
  }
  if (!stack.length) return s;
  // 回退到最后一个完整元素之后，再按当时的嵌套补齐
  const cut = s.slice(0, lastSafe);
  const st2 = [];
  let q = false, e2 = false;
  for (const ch of cut) {
    if (q) { if (e2) e2 = false; else if (ch === '\\') e2 = true; else if (ch === '"') q = false; continue; }
    if (ch === '"') q = true; else if (ch === '{' || ch === '[') st2.push(ch === '{' ? '}' : ']'); else if (ch === '}' || ch === ']') st2.pop();
  }
  return cut.replace(/,\s*$/, '') + st2.reverse().join('');
}
function dumpRaw(name, keys, text) {
  try { fs.mkdirSync(GEN_DIR, { recursive: true }); fs.writeFileSync(path.join(GEN_DIR, `_last_raw_${keys[0]}.txt`), `${name}\n${keys.join(',')}\n\n${text}`, 'utf8'); } catch (_) { /* 忽略 */ }
}

/* ---------------- ③ 确定性校验 ---------------- */
const num = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const capConf = c => (c === 'low' ? 'low' : 'medium');   // 模型生成的最高只给 medium
/* 证据覆盖率：一段文字里的汉字二元组，有多大比例出现在证据原文中（粗略防「编造」） */
function coverage(text, evidence) {
  const s = String(text || '').replace(/[^一-龥]/g, '');
  if (s.length < 4) return 1;
  let hit = 0, all = 0;
  for (let i = 0; i < s.length - 1; i++) { all++; if (evidence.includes(s.slice(i, i + 2))) hit++; }
  return all ? hit / all : 0;
}

function validate(raw, ctx) {
  const notes = [];
  const ev = ctx.evidence || '';
  if (!raw || typeof raw !== 'object') return { ok: false, why: '模型没有返回可解析的档案' };
  const born = num(raw.born), died = num(raw.died);
  const Y = Number(ctx.year) || 0;
  if (!born && !died) return { ok: false, why: '档案没有生卒年，无法判定此人是否活在该年' };
  if (born && died && died < born) return { ok: false, why: `生卒自相矛盾（${born}–${died}）` };
  if (born && Y && Y < born) return { ok: false, why: `${raw.name || ctx.name}生于 ${born} 年，${Y} 年尚未出生` };
  if (died && Y && Y > died) return { ok: false, why: `${raw.name || ctx.name}卒于 ${died} 年，${Y} 年已不在世` };
  // 结构化核定与模型给的生卒冲突时：只采信「能活在开局年份」的那一组。
  // 实测检索把「王守仁」匹配到一位 1932–2022 年的同名现代人——盲信检索会把明代的王守仁整份档案判废。
  const id = ctx.ident || {};
  const fits = (b, d) => (!b || !Y || Y >= b) && (!d || !Y || Y <= d);
  let fBorn = born, fDied = died;
  if (id.found && (id.born || id.died) && (id.born !== born || id.died !== died)) {
    if (fits(id.born, id.died) && Math.abs((id.born || born || 0) - (born || id.born || 0)) <= 5) {
      fBorn = id.born || born; fDied = id.died || died;
      notes.push(`生卒以检索核定为准：${fBorn}–${fDied}（模型给 ${born}–${died}）`);
    } else {
      notes.push(`检索核定的生卒（${id.born}–${id.died}）与开局年份或档案不符，疑为同名之人，未采用`);
    }
  }
  const life = y => (!fBorn || y >= fBorn) && (!fDied || y <= fDied);

  const fig = {
    name: ctx.name, aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(a => typeof a === 'string' && a !== ctx.name).slice(0, 4) : [],
    born: fBorn, died: fDied, diedM: num(raw.diedM) && num(raw.diedM) >= 1 && num(raw.diedM) <= 12 ? num(raw.diedM) : null,
    polity: String(raw.polity || ctx.polity || ''), gender: raw.gender === '女' ? '女' : '男',
    father: String(raw.father || ''), traits: String(raw.traits || '').slice(0, 160),
    generated: true, generatedAt: new Date().toISOString(), evidenceSources: ctx.sources || [],
  };
  // 官职：在生年之内、带出处
  fig.posts = (Array.isArray(raw.posts) ? raw.posts : []).map(p => ({
    from: num(p.from), to: num(p.to), title: String(p.title || ''), seat: String(p.seat || ''),
    kind: p.kind === '爵' ? '爵' : '职', src: String(p.src || ''), conf: 'medium', note: '',
  })).filter(p => {
    if (p.from && !p.to) p.to = fDied || p.from;   // 只知始任、不知去任：按至卒年计，不另编
    const okp = p.title && p.src && p.from && p.to && p.from <= p.to && life(p.from);
    if (!okp && p.title) notes.push(`丢弃官职「${p.title}」：年份不合或缺出处`);
    return okp;
  });
  // 身份轨迹
  fig.timeline = (Array.isArray(raw.timeline) ? raw.timeline : []).map(t => ({
    y: num(t.y), m: num(t.m), kind: ['post', 'rank', 'event', 'death'].includes(t.kind) ? t.kind : 'event',
    text: String(t.text || '').slice(0, 120), ...(t.seat ? { seat: String(t.seat) } : {}),
    ...(t.identity === 'emperor' ? { identity: 'emperor' } : {}),
  })).filter(t => t.y && t.text && life(t.y));
  if (raw.resources && raw.resources.note) fig.resources = { note: String(raw.resources.note).slice(0, 160), src: String(raw.resources.src || ''), conf: 'low' };

  // 矛盾：字段齐全才收
  fig.tensions = {};
  for (const [k, t] of Object.entries(raw.tensions || {})) {
    if (!t || !t.name || !t.whyNotResolved || !Array.isArray(t.parties) || t.parties.length < 2 || !Array.isArray(t.actions) || t.actions.length < 2) {
      notes.push(`丢弃矛盾「${(t && t.name) || k}」：字段不全`); continue;
    }
    const tid = /^T-/.test(k) ? k : `T-SIT-${k}`;
    fig.tensions[tid] = {
      name: String(t.name).slice(0, 10), label: String(t.label || t.name).slice(0, 30),
      parties: t.parties.map(String).slice(0, 4), wants: t.wants && typeof t.wants === 'object' ? t.wants : {},
      whyNotResolved: String(t.whyNotResolved).slice(0, 120), actions: t.actions.map(String).slice(0, 6),
      ifUnresolved: String(t.ifUnresolved || '').slice(0, 80), src: String(t.src || ''), conf: 'low',
      basis: ['fact', 'recorded'].includes(t.basis) ? 'recorded' : 'inferred',
    };
  }
  // 处境：按年分段，月份合法、带出处；指向的矛盾必须存在
  fig.situation = {};
  for (const [yk, segs] of Object.entries(raw.situation || {})) {
    const yy = num(yk);
    if (!yy || !life(yy) || !Array.isArray(segs)) continue;
    const list = segs.map(s => {
      let tid = s.tension ? String(s.tension) : null;
      if (tid && !fig.tensions[tid] && fig.tensions[`T-SIT-${tid}`]) tid = `T-SIT-${tid}`;
      return {
        from: Math.min(12, Math.max(1, num(s.from) || 1)), text: String(s.text || '').slice(0, 160),
        tension: tid && fig.tensions[tid] ? tid : null, src: String(s.src || ''),
        conf: coverage(s.text, ev) >= 0.35 ? 'medium' : 'low', basis: s.basis === 'recorded' ? 'recorded' : 'inferred',
      };
    }).filter(s => s.text && s.src).sort((a, b) => a.from - b.from);
    if (list.length) fig.situation[yy] = list;
  }
  // 身边人：有名有出处、同时代
  fig.circle = (Array.isArray(raw.circle) ? raw.circle : []).map(c => ({
    name: String(c.name || '').trim(), relation: String(c.relation || ''), role: String(c.role || ''),
    seat: String(c.seat || ''), born: num(c.born), died: num(c.died), far: !!c.far,
    note: String(c.note || '').slice(0, 80), src: String(c.src || ''), conf: 'low',
  })).filter(c => {
    if (!c.name || c.name === ctx.name || !c.src) return false;
    // 生卒全无：无法确认此时在世（实测模型把 1510 年已死的刘瑾列进了 1519 年的身边人），不收
    if (c.born == null && c.died == null) { notes.push(`丢弃人物「${c.name}」：生卒不详，无法确认 ${Y} 年在世`); return false; }
    if (c.died && Y && c.died < Y) { notes.push(`丢弃人物「${c.name}」：${c.died} 年已死`); return false; }
    if (c.born && Y && c.born > Y) { notes.push(`丢弃人物「${c.name}」：${Y} 年尚未出生`); return false; }
    if (!ev.includes(c.name)) { notes.push(`丢弃人物「${c.name}」：证据中查无此名`); return false; }
    return true;
  }).slice(0, 14);
  fig.factions = (Array.isArray(raw.factions) ? raw.factions : []).filter(f => f && f.title && f.sideA && f.sideB && f.src).map(f => ({
    from: Array.isArray(f.from) ? [num(f.from[0]) || Y, num(f.from[1]) || 1] : [Y, 1],
    title: String(f.title), sideA: String(f.sideA), sideB: String(f.sideB), stake: String(f.stake || ''), src: String(f.src), conf: 'low',
  })).slice(0, 4);
  fig.denied = (Array.isArray(raw.denied) ? raw.denied : []).filter(d => d && d.text && d.why)
    .map(d => ({ text: String(d.text).slice(0, 20), why: String(d.why).slice(0, 80), src: String(d.src || '') })).slice(0, 6);

  // 年表事件：月份合法、年份在窗口内、证据覆盖率够才收
  const lo = Y - 3, hi = (fDied || Y) + 5;
  const events = (Array.isArray(raw.events) ? raw.events : []).map((e, i) => ({
    id: `gen-${ctx.name}-${num(e.y)}-${num(e.m) || 0}-${i}`,
    polity: fig.polity || ctx.polity, y: num(e.y), m: num(e.m), d: num(e.d),
    text: String(e.text || '').slice(0, 80), place: String(e.place || ''),
    keys: Array.isArray(e.keys) ? e.keys.map(String).filter(k => k.length >= 3).slice(0, 6) : [],
    src: String(e.src || ''), conf: 'low', generated: true,
  })).filter(e => {
    if (!e.y || !e.text || !e.src || e.y < lo || e.y > hi) return false;
    if (e.m != null && (e.m < 1 || e.m > 12)) e.m = null;
    const cov = coverage(e.text, ev);
    if (cov < 0.3) { notes.push(`丢弃事件「${e.text.slice(0, 16)}」：证据里找不到对应字句（覆盖率 ${Math.round(cov * 100)}%）`); return false; }
    if (cov >= 0.55) e.conf = 'medium';
    return true;
  });

  // 年幼者不得理政（用户原话：「什么叫做9岁孩童管理国事」）。
  // 实测自动档案把 907 年 9 岁的马希声写成「任武安节度副使，协助父亲处理藩镇政务」。
  //   · 未满 15 岁（虚岁）时的「职」标为名义；
  //   · 该年处境若写他理政/决断，改写为「年幼随家人居住、实务由长辈主持」，并去掉其矛盾。
  const MINOR = 15;
  const ageAt = y => (fBorn ? y - fBorn + 1 : null);
  for (const p of fig.posts) {
    const a = ageAt(p.from);
    if (p.kind === '职' && a != null && a < MINOR) { p.title += '（年幼，名义）'; notes.push(`官职「${p.title}」始任时仅 ${a} 岁，标为名义`); }
  }
  for (const [yk, segs] of Object.entries(fig.situation)) {
    const a = ageAt(Number(yk));
    if (a == null || a >= MINOR) continue;
    for (const s of segs) {
      if (/处理|處理|理政|主持|决断|決斷|裁决|裁決|政务|政務|调兵|調兵|执掌|執掌|统领|統領/.test(s.text)) {
        notes.push(`${yk} 年处境写 ${a} 岁的他在理政，已改写为年幼随家人居住`);
        const seat = (fig.posts.find(p => p.seat && p.from <= Number(yk) && Number(yk) <= p.to) || {}).seat || '家中';
        s.text = `年方 ${a} 岁，随家人居于${seat}；名义上的职衔不等于实权，府中政务由长辈与幕府主持，他能接触的是师傅的功课、堂上旁听与身边人的言谈`;
        s.tension = null; s.basis = 'inferred';
      }
    }
  }

  // 处境去剧透：某段处境（yy 年 from 月起）里提到「晚于此时」的事件，含该事件的句子删掉。
  // 实测模型把 1519 年 7 月王守仁的处境写成整场战事的结局（宁王被擒、前后不到三十五天），
  // 玩家还没动手，结局先摆在 GM 面前了。
  const after = (e, y2, m2) => e.y > y2 || (e.y === y2 && (e.m || 12) > m2);
  for (const [yk, segs] of Object.entries(fig.situation)) {
    for (const s of segs) {
      const later = events.filter(e => after(e, Number(yk), s.from));
      const marks = later.flatMap(e => (e.keys && e.keys.length ? e.keys : [e.text.slice(0, 5)]));
      const outcome = /被擒|伏誅|伏诛|平息|大敗|大败|兵敗|兵败|身死|被殺|被杀|而亡|告終|告终|前後不到|前后不到/;
      const kept = s.text.split(/(?<=[。；])/).filter(seg => !marks.some(k => k && seg.includes(k)) && !outcome.test(seg));
      if (kept.join('') !== s.text) {
        notes.push(`${yk} 年 ${s.from} 月处境删去了写到后来结局的句子`);
        s.text = kept.join('') || '（此时处境史料未详，待据史补录）';
      }
    }
  }

  if (!fig.posts.length && !Object.keys(fig.situation).length) {
    return { ok: false, why: '证据不足：既没有可核的官职，也没有可核的处境，不建档（宁可留白不编）', notes };
  }
  return { ok: true, figure: fig, events, notes };
}

/* ---------------- ④ 落盘与注册 ---------------- */
function save(fig, events) {
  try { fs.mkdirSync(GEN_DIR, { recursive: true }); } catch (_) { /* 已存在 */ }
  const file = path.join(GEN_DIR, `${fig.name.replace(/[\\/:*?"<>|]/g, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify({ figure: fig, events }, null, 2), 'utf8');
  return file;
}
function register(fig, events) {
  require('./figure-data').registerFigure(fig);
  require('./timeline').registerEvents(events || []);
}
/** 启动时把已生成的档案全部注册（幂等） */
function loadAll() {
  let n = 0;
  if (process.env.RPG_NO_GENERATED_FIGURES === '1') return 0;   // 测试「无档案」分支时关闭
  try {
    for (const f of fs.readdirSync(GEN_DIR)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(GEN_DIR, f), 'utf8'));
        if (j && j.figure && j.figure.name) { register(j.figure, j.events); n++; }
      } catch (_) { /* 单个坏文件不影响其他 */ }
    }
  } catch (_) { /* 目录不存在 */ }
  return n;
}

/**
 * 主入口：为 name 在 (year, polity) 建档。
 * opts: { adapter, config, force }——adapter/config 用游戏里当前选中的模型。
 * 返回 { ok, figure?, events?, notes, why?, file? }
 */
async function generate(name, year, polity, opts = {}) {
  const nm = String(name || '').trim();
  const fd = require('./figure-data');
  if (!nm) return { ok: false, why: '没有姓名' };
  if (process.env.RPG_NO_GENERATED_FIGURES === '1') return { ok: false, why: '自动建档已关闭（RPG_NO_GENERATED_FIGURES=1）' };
  if (!opts.force && fd.dossierAt(nm, year)) return { ok: true, existed: true, notes: ['已有档案，未重新生成'] };
  if (!opts.adapter) return { ok: false, why: '未配置模型 API（在游戏设置里选好模型并填 Key 后再试）' };

  const evd = await gatherEvidence(nm, year, polity);
  if (!evd.text || evd.text.length < 200) return { ok: false, why: `检索不到「${nm}」的足够资料，不建档（宁可留白不编）` };

  // 分两次要：一次输出全部字段太长，实测 DeepSeek 会在 JSON 中途截断。
  //   第一次：生卒、官职、轨迹、资源、处境、矛盾、否定设定；第二次：身边人、派系、年表事件。
  const head = `人物：${nm}\n开局时点：公元 ${year} 年${polity ? `，政权：${polity}` : ''}\n处境（situation）只需覆盖开局年及其后至多 5 年。\n\n`;
  const ask = async (keys) => {
    const r = await opts.adapter.call({
      system: SYSTEM,
      prompt: `${head}只输出下面结构中的这些字段：${keys.join('、')}（其他字段不要输出）。结构：\n${SCHEMA_HINT}\n\n【证据】\n${evd.text}`,
      temperature: 0.1, maxTokens: 6000,
    }, opts.config || {});
    const text = (r && r.text) || '';
    const j = parseJson(text) || parseJson(closeJson(text));
    if (!j) dumpRaw(nm, keys, text);
    return j;
  };
  let raw = null;
  try {
    const [a, b] = await Promise.all([
      ask(['name', 'aliases', 'born', 'died', 'diedM', 'polity', 'gender', 'father', 'traits', 'posts', 'timeline', 'resources', 'situation', 'tensions', 'denied']),
      ask(['circle', 'factions', 'events']),
    ]);
    if (a) raw = { ...a, ...(b || {}) };
  } catch (e) {
    return { ok: false, why: `模型调用失败：${(e && e.message) || e}` };
  }
  const v = validate(raw, { name: nm, year, polity, evidence: evd.text, ident: evd.ident, sources: evd.sources });
  if (!v.ok) return { ok: false, why: v.why, notes: v.notes || [] };
  const file = save(v.figure, v.events);
  register(v.figure, v.events);
  return { ok: true, figure: v.figure, events: v.events, notes: v.notes, file, sources: evd.sources };
}

module.exports = { generate, validate, loadAll, register, coverage, gatherEvidence, closeJson, GEN_DIR };
