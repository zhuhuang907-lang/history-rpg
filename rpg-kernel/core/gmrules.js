'use strict';
/**
 * 用户 GM 规范（history-rpg-gm v5.0）第七章「错误百科」中**能由程序判定**的部分。
 * 由 plot.checkText 调用；编号接在已有检查之后：
 *   11（续）越权写法：你答道 / 你冷笑 / 你点了点头 / 你心中一动 / 你意识到 …（§7.1 #1–3）
 *   5（续）  擅自快进：转眼 / 数日后 / 几个月后 / 此后一切 …（§7.2 #9）
 *   19 选项菜单与引导问句（§1 第6条、§7.1 #8、§7.10 #77）
 *   20 占位人名（§7.3 #17）
 *   21 现代词汇、翻译腔、网络腔（§7.5 #40–41）
 *   22 摘要腔、冲突自动化解（§7.9 #62、#64）
 * 判不准的（如人物性格是否崩坏、数字是否合锚点）不在这里硬判，交给提示词与人工。
 */

/* 主角的越权动作/心理：只有玩家本回合自己写了同样的动作才允许 */
const OVERREACH = [
  { re: /你(?:冷笑|冷哼|笑道|答道|回道|说道|开口道|沉声道|淡淡道)/, why: '替玩家说话' },
  { re: /你(?:点了点头|点头|摇了摇头|摇头|起身|拔刀|拱手|上前|接过|拍案)/, why: '替玩家做动作' },
  { re: /你(?:心中一动|心头一|心想|暗想|意识到|明白过来|心下了然|暗自|决意|决定)/, why: '替玩家产生心理或决定' },
];
const TIME_SKIP = /转眼|转瞬之间|数日后|数日之后|几日后|几个月后|数月之后|一晃|光阴荏苒|此后一切|从此以后/;
const MENU = /你可以选择|你可以(?:先|考虑)|有以下(?:几种|几条)|选项[一二三ABC]|(?:^|\n)\s*[A-D][\.、．:：]\s|请问你接下来|你接下来(?:打算|准备|要)怎么|你打算如何|该如何是好呢？/;
const PLACEHOLDER = /(?:一位|一名|一个|某位|某个|那个|那位)(?:官员|将领|将军|债主|老佃户|佃户|商人|小吏|书吏|老者|老农|士兵|军士|使者|僧人)(?![一-龥]{0,1}[叫名唤姓])/;
// 现代词：去掉在古汉语里本就成词、易误伤的（交通、组织、经济、领导、问题之外的「问」等）
const MODERN_WORDS = ['报告', '会议', '调查', '方案', '效率', '团队', '管理', '干部', '群众', '同志', '资源', '信息', '计划', '目标', '成本', '压力', '心态', '效果', '系统', '机制', '模式', '战略', '互动', '沟通', '反馈', '搞定', 'OK', '绝了', '没问题', '这很好', '我没事'];
const SUMMARY = /经过一番(?:商议|谈判|周折|交涉)|一番(?:商议|谈判|交涉)之后|相谈甚欢|颇为赏识|被你的(?:诚意|真诚|气度|才干)(?:所)?打动|达成(?:了)?协议|一切(?:进展|都)顺利/;

/* 词表热加载（《实现包》§5：词表放 wordlists/，人工维护，运行时热加载）。
   文件改了就重读；文件缺失或读失败时退回上面写在代码里的默认表。 */
const fs = require('fs');
const path = require('path');
const WL_DIR = path.join(__dirname, '..', 'wordlists');
const _wl = {};
function wordlist(name, fallback) {
  const f = path.join(WL_DIR, name + '.txt');
  try {
    const st = fs.statSync(f);
    if (!_wl[name] || _wl[name].mtime !== st.mtimeMs) {
      const words = fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
      _wl[name] = { mtime: st.mtimeMs, words };
    }
    return _wl[name].words.length ? _wl[name].words : fallback;
  } catch (_) { return fallback; }
}

/* 中文数字 → 数（年龄用，到百位够了） */
function cnNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  const D = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let n = 0, cur = 0;
  for (const ch of String(s)) {
    if (ch in D) cur = D[ch];
    else if (ch === '十') { n += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { n += (cur || 1) * 100; cur = 0; }
  }
  return n + cur;
}

/* 其他存档里的虚构人物名（R12 串档）。只收虚构/生成的人——真实历史人物在哪局出现都正常。
   扫一遍存档目录，结果缓存 60 秒。 */
let _others = { at: 0, byId: {} };
function otherSaveNames(state) {
  const dir = path.join(process.env.RPG_DATA_DIR || path.join(__dirname, '..', 'data'), 'saves');
  if (Date.now() - _others.at > 60000) {
    const byId = {};
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          byId[(s.meta && s.meta.id) || f] = (s.npcs || []).filter(n => n && n.name && n.name.length >= 2 && n.source !== 'historical').map(n => n.name);
        } catch (_) { /* 坏档跳过 */ }
      }
    } catch (_) { /* 无目录 */ }
    _others = { at: Date.now(), byId };
  }
  const me = state.meta && state.meta.id;
  const out = new Set();
  for (const [id, names] of Object.entries(_others.byId)) if (id !== me) names.forEach(n => out.add(n));
  return out;
}

function checkGM(state, text, input) {
  const T = String(text || '');
  const out = [];
  const inp = String(input || '');
  // R4：正文不得有列表符号/小标题/英文（允许人名地名里不会出现的情形下，连续 3 个以上拉丁字母才算）
  const listMark = T.match(/(?:^|\n)\s*(?:[-*•·]|\d+[\.、）)]|[（(]?[一二三四五六七八九十]+[）)、])\s*\S/);
  if (listMark) out.push({ no: 23, name: '格式检查', why: `正文出现列表或编号：「${listMark[0].trim().slice(0, 12)}」——正文须是纯散文`, arc: null });
  const latin = T.match(/[A-Za-z]{3,}/);
  if (latin) out.push({ no: 23, name: '格式检查', why: `正文出现英文「${latin[0]}」`, arc: null });
  // R9：已了结/已关闭的线索不得在正文里复活（玩家输入里明确提起则豁免）
  for (const th of (state.threads || [])) {
    if (!/closed|resolved|了结|关闭|done/.test(String(th.status || ''))) continue;
    const key = String(th.label || th.title || '').replace(/^传闻：/, '').split(/[，；。]/)[0].slice(0, 8);
    if (key.length >= 4 && T.includes(key) && !inp.includes(key)) {
      out.push({ no: 24, name: '已关闭线索检查', why: `已了结的线索「${key}」在正文里又被提起；玩家没要求重开就不再提`, arc: null });
    }
  }
  // 越权：只有知道玩家写了什么时才判（input === null 表示不知道，不判，免得误伤玩家自己写的动作）
  if (input != null) {
    // 用主角名字写的台词也算（实测：玩家只写「问他商旅所言可有实据」，正文替萧纪编了两段话，还让他「重复了一遍」）。
    // 玩家本轮有「问/说/告诉/令」之类的发话意图时，允许把这一问落成一句；超出一句即越权。
    const nm = String((state.protagonist && state.protagonist.name) || '').trim();
    if (nm) {
      const re = new RegExp(`${nm}(?:又|再|便|才|也|于是|随即)?(?:问道?|说道?|道|答道?|重复|笑道|冷笑|沉声|开口|接口|追问|喝道|叹道)`, 'g');
      const n = (T.match(re) || []).length;
      const allowed = /问|说|告诉|令|吩咐|传话|答|喝/.test(inp) ? 1 : 0;
      if (n > allowed) out.push({ no: 11, name: '玩家自主性检查', why: `替主角说话：正文里「${nm}」开口 ${n} 次，玩家本轮只交代了${allowed ? '一句话的意图' : '行动，没让他说话'}；主角的台词只能用玩家原话`, arc: null });
    }
    for (const o of OVERREACH) {
      const m = T.match(o.re);
      // 玩家自己写过同一动作就不算越权：「你点了点头」对上输入里的「点头」——按去掉「你/了」后的任一二字片段比对
      const core = m ? m[0].replace(/^你/, '').replace(/了/g, '') : '';
      const bigrams = [...core].slice(0, -1).map((ch, i) => core.slice(i, i + 2));
      if (m && !bigrams.some(b => inp.includes(b))) {
        out.push({ no: 11, name: '玩家自主性检查', why: `${o.why}：「${m[0]}」——玩家本回合没写这一句`, arc: null });
        break;
      }
    }
  }
  const ff = wordlist('fastforward', null);
  const ts = ff ? (ff.find(w => T.includes(w)) || null) : (T.match(TIME_SKIP) || [null])[0];
  if (ts && !/快进/.test(inp)) out.push({ no: 5, name: '时间检查', why: `擅自快进：「${ts}」`, arc: null });
  const mn = T.match(MENU);
  if (mn) out.push({ no: 19, name: '选项菜单检查', why: `给了选项或引导问句：「${mn[0].trim()}」——只摆局面，不给选项与建议`, arc: null });
  const ph = T.match(PLACEHOLDER);
  const phw = wordlist('placeholders', []).find(w => T.includes(w));
  if (ph || phw) out.push({ no: 20, name: '占位人名检查', why: `「${ph ? ph[0] : phw}」是占位称呼；凡被单独描写的人都要有全名`, arc: null });
  const mw = wordlist('modern_words', MODERN_WORDS).filter(w => T.includes(w));
  if (mw.length) out.push({ no: 21, name: '现代词汇检查', why: `出现现代词或翻译腔：${mw.slice(0, 6).map(w => `「${w}」`).join('')}`, arc: null });
  const sm = T.match(SUMMARY);
  if (sm) out.push({ no: 22, name: '摘要腔检查', why: `「${sm[0]}」是摘要或冲突自动化解；要写出对话与讨价还价`, arc: null });
  // R6 年龄：正文里「某人……X 岁」与名册（按生年由代码算出）比对，差两岁以上即报
  const people = [state.protagonist, ...(state.npcs || [])].filter(n => n && n.name && n.age != null && /^\d+$/.test(String(n.age)));
  for (const n of people) {
    // 两种说法：「年方二十」（年龄词在前，可不带「岁」）与「三十四岁」
    const N = '[一二两三四五六七八九十百\\d]{1,4}';
    const re = new RegExp(`${n.name}[^。！？\\n]{0,12}?(?:(?:年方|年已|年近|年届|今年|刚满)(${N})岁?|(${N})岁)`);
    const m = T.match(re);
    if (m) {
      const said = cnNum(m[1] || m[2]);
      if (said && Math.abs(said - Number(n.age)) >= 2) out.push({ no: 26, name: '年龄检查', why: `「${m[0].slice(-14)}」与名册不符：${n.name}此时${n.age}岁`, arc: null });
    }
  }
  // R10 订正不回退：玩家订正过的「错 → 对」，正文又写回了「错」
  for (const c of ((state.ledger && state.ledger.corrections) || [])) {
    if (c.wrong && T.includes(c.wrong) && !(c.right && T.includes(c.right) && T.indexOf(c.right) <= T.indexOf(c.wrong))) {
      out.push({ no: 27, name: '订正回退检查', why: `第${c.turn}轮玩家已订正「${c.wrong}」应为「${c.right}」，正文又写成了「${c.wrong}」`, arc: null });
    }
  }
  // R12 串档：别的存档里的虚构人物出现在本档
  const here = new Set([...(state.npcs || []).map(n => n.name), (state.protagonist || {}).name]);
  for (const nm of otherSaveNames(state)) {
    if (!here.has(nm) && T.includes(nm)) { out.push({ no: 28, name: '串档检查', why: `「${nm}」是别的存档里的虚构人物，不属于本局`, arc: null }); break; }
  }
  // AI 腔：软提示（《设计书》§6.6），一轮命中 3 处以上才报，且只作提示、不进返修
  const ai = wordlist('ai_cliches', []).filter(w => T.includes(w));
  if (ai.length >= 3) out.push({ no: 25, name: 'AI腔提示', why: `套话偏多：${ai.slice(0, 5).map(w => `「${w}」`).join('')}——换成具体的动作、物件、声音`, arc: null, soft: true });
  return out;
}

module.exports = { checkGM, MODERN_WORDS };
