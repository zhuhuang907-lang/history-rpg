'use strict';
/**
 * 能力闸门全库体检：把「孩童理政 / 无职衔而掌权 / 地点与史实治所不符」扫一遍全部存档。
 * 用户报的马希声不是孤例——这里把同类问题一次性点名，逐档给出结论。
 */
const path = require('path');
process.env.RPG_DATA_DIR = path.join(__dirname, 'data');
const fs = require('fs');
const engine = require('./core/engine');
const capability = require('./core/capability');

/** 正文里不该出现（对未成年人而言）的动词：批阅/下令/率军/支度/任免…… */
const GOVERN_VERBS = /批阅|批答|下[令达]|传令|率[军兵]|领[军兵]|点兵|支度|支拨|征收|征发|任免|黜陟|决断|断狱|批红|签署|挂帅|统兵|调度兵马|开仓|拨粮|发兵|谕令|檄/;

(async () => {
  const files = fs.readdirSync('data/saves').filter(f => f.endsWith('.json'));
  let bad = 0, warned = 0, clean = 0;
  const rows = [];
  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync('data/saves/' + f, 'utf8')); } catch { continue; }
    const p = s.protagonist || {};
    if (!p.name) continue;
    const c = capability.capabilityOf(s);
    const issues = [];

    // ① 未成年而带实职
    if (c.isMinor && c.hasOffice) issues.push(`未成年(${c.age}岁)却带实职「${c.role}」`);
    // ② 未成年而正文里写他理政
    if (c.isMinor) {
      const corpus = [String(s.opening || ''), ...(s.log || []).filter(l => l.speaker === 'GM').map(l => String(l.text || ''))].join('\n');
      const hit = corpus.match(new RegExp(`(?:${p.name}|你)[^。\\n]{0,12}(${GOVERN_VERBS.source})`));
      if (hit) issues.push(`正文写其理政：「${hit[0].slice(0, 24)}…」`);
    }
    // ③ 地点与史实治所不符
    if (c.seat && !c.locationAttested) issues.push(`地点不符：现「${String((s.location || {}).full || '')}」，治所应为「${c.seat.place}」`);

    const tag = issues.length ? (issues.some(i => /未成年|理政/.test(i)) ? '严重' : '待修') : '正常';
    if (tag === '严重') bad++; else if (tag === '待修') warned++; else clean++;
    rows.push({ f: f.slice(0, 34), who: `${p.name}(${c.age ?? '?'}岁)`, tag, role: p.role || '', place: String((s.location || {}).full || ''), issues });
  }

  console.log(`扫描 ${files.length} 份存档 → 严重 ${bad} / 待修 ${warned} / 正常 ${clean}\n`);
  for (const r of rows.sort((a, b) => ['严重', '待修', '正常'].indexOf(a.tag) - ['严重', '待修', '正常'].indexOf(b.tag))) {
    console.log(`[${r.tag}] ${r.who} @ ${r.place}${r.role ? ' · ' + r.role : ''}　(${r.f})`);
    for (const i of r.issues) console.log('        - ' + i);
  }
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('体检崩溃：', e); process.exit(1); });
