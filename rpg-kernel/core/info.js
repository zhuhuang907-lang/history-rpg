'use strict';
/**
 * 信息传播网络
 *
 * 对应规范第四章（事实分层 F1–F5）、第十九章（NPC 信息矩阵）、第二十章（传播路径）、
 * 第二十一章（谣言）、第二十二章（情报可靠性）、第五十六章（视听限制）。
 *
 * 一句话立场：**「发生了什么」和「谁知道发生了什么」必须彻底分开。**
 * 一个 NPC 说出他不可能知道的事 —— 这是硬错，不是文风问题。
 */
const { extractDialogue } = require('./passes');

const LEVEL = {
  F1: '已确认（史料明载或玩家亲见）',
  F2: '高概率（史料支持较强，细节不确定）',
  F3: '推测（由史料/地理/社会结构推导）',
  F4: '虚构（本局虚构人物与基层事件，不得与史实冲突）',
  F5: '未知（无证据，禁止填充成事实）',
};

function ensureFacts(state) {
  if (!state.facts) state.facts = [];
  return state.facts;
}

/* ---------------- 登记一条事实 ---------------- */
function addFact(state, opt = {}) {
  const list = ensureFacts(state);
  const f = {
    id: 'f' + (list.length + 1),
    content: String(opt.content || '').trim(),
    source: String(opt.source || '').trim() || '未注明来源',
    // yearLabel 自带「年」字（如「太清二年」），去掉尾缀避免「太清二年年10月」
    at: opt.at || `${String((state.clock && state.clock.yearLabel) || '?').replace(/年+$/, '')}年${(state.clock && state.clock.month) || '?'}月`,
    place: opt.place || ((state.location && state.location.full) || ''),
    level: LEVEL[opt.level] ? opt.level : 'F4',
    truth: opt.truth || '未知',            // 真 / 假 / 未知 / 有争议
    knowers: [],                            // [{who, how, at}]
    public: opt.public !== false,
    disputed: !!opt.disputed,
    reliability: opt.reliability || '',     // 亲眼 / 耳闻 / 转述 / 密报 / 文书
  };
  for (const w of (opt.knowers || [])) f.knowers.push({ who: w, how: opt.how || '亲历', at: f.at });
  list.push(f);
  return f;
}

function tell(state, factId, who, how = '被告知') {
  const f = ensureFacts(state).find(x => x.id === factId);
  if (!f) return null;
  if (!f.knowers.some(k => k.who === who)) f.knowers.push({ who, how, at: `${String((state.clock && state.clock.yearLabel) || '?').replace(/年+$/, '')}年${(state.clock && state.clock.month) || '?'}月` });
  return f;
}

/* ---------------- 关键短语：用于把正文和事实对上 ---------------- */
function keysOf(content) {
  const s = String(content || '').trim();
  const seg = s.split(/[，。、；：！？]/).map(x => x.trim()).filter(x => x.length >= 3);
  if (s.length <= 14) seg.push(s);
  return [...new Set(seg)];
}

/* ---------------- 谁知道了什么（矩阵） ---------------- */
function infoMatrix(state) {
  const facts = ensureFacts(state);
  const npcs = (state.npcs || []).slice(0, 5).map(n => n.name);
  const cols = ['玩家', ...npcs, '官府', '民众'];
  const rows = facts.slice(-12).map(f => {
    const r = { 信息: f.content.slice(0, 22), 等级: f.level };
    const has = w => f.knowers.some(k => k.who === w);
    r['玩家'] = has('玩家') ? '知道' : '不知道';
    npcs.forEach(n => { r[n] = has(n) ? '知道' : (f.disputed ? '怀疑' : '不知道'); });
    r['官府'] = has('官府') ? '知道' : (f.public ? '可能听闻' : '不知道');
    r['民众'] = has('民众') ? '知道' : (f.public ? '可能听闻' : '不知道');
    return r;
  });
  return { cols, rows };
}

/* ---------------- 传播：延迟 / 遗漏 / 误传 / 谣言 ----------------
   规范第二十、二十一章：每传一级都可能延迟、遗漏、误传、被故意修改。 */
function seeded(a, b) {
  let h = 2166136261 ^ (a || 0);
  const s = String(b || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const DISTORT = [
  ['人数', n => `约 ${Math.max(1, Math.round(n * (1.4 + Math.random() * 0.6)))}`],
];

function spread(state, days) {
  ensureFacts(state);
  const c = state.clock || {};
  const rnd = seeded((c.gregorianYear || 0) * 17 + (c.month || 1), `${state.meta && state.meta.id}|${state.turn}|spread`);
  const npcs = (state.npcs || []).map(n => n.name).filter(Boolean);
  const log = [];
  const d = Math.max(0, Number(days) || 0);
  for (const f of state.facts) {
    if (!f.public) continue;
    // 传播概率随天数上升；一级传播约需数日
    const p = Math.min(0.85, 0.12 * (d + 1));
    for (const n of npcs) {
      if (f.knowers.some(k => k.who === n)) continue;
      if (rnd() < p) {
        f.knowers.push({ who: n, how: rnd() < 0.5 ? '耳闻' : '转述', at: `${c.yearLabel || ''}${c.month || ''}月` });
        log.push(`${n} 听说了「${f.content.slice(0, 16)}」`);
      }
    }
    if (!f.knowers.some(k => k.who === '民众') && rnd() < p * 0.7) {
      f.knowers.push({ who: '民众', how: '街谈巷议', at: `${c.yearLabel || ''}${c.month || ''}月` });
      log.push(`民间开始传「${f.content.slice(0, 16)}」`);
    }
    // 误传：把事实变成一条「传闻」（真值不明），并登记为新事实
    if (rnd() < 0.12 && f.level !== 'F5') {
      const rumor = addFact(state, {
        content: `传闻：${f.content.slice(0, 18)}（说法已被夸大）`,
        source: '街谈巷议，未经核实',
        level: 'F3', truth: '未知', public: true,
        knowers: ['民众'], how: '误传', reliability: '耳闻',
      });
      rumor.fromFact = f.id;
      log.push(`生出传闻：${rumor.content}`);
    }
  }
  return log;
}

/* ---------------- 情报可靠性（规范第二十二章） ---------------- */
function reportIntel(state, { content, source, eyewitness = false, distance = '', motive = '' }) {
  let reliability = eyewitness ? '亲眼' : '耳闻';
  if (/报|札|帖|文书|牒/.test(String(source || ''))) reliability = '文书';
  const f = addFact(state, { content, source, level: eyewitness ? 'F1' : 'F2', truth: '未知', reliability, public: false, knowers: ['玩家'], how: '情报' });
  f.distance = distance; f.motive = motive;
  return f;
}

/* ---------------- P12：信息泄漏审计 ---------------- */
function leakAudit(scene, state) {
  const out = [];
  const facts = ensureFacts(state);
  const npcNames = (state.npcs || []).map(n => n.name).filter(Boolean);
  const dlg = extractDialogue(String(scene || ''));
  const player = (state.protagonist && state.protagonist.name) || '你';

  for (const f of facts) {
    if (f.level === 'F5') {
      // 未知的事实被写成确凿叙述 —— 规范第四章明令禁止
      for (const k of keysOf(f.content)) {
        if (String(scene).includes(k)) {
          out.push({
            code: 'IN-02', sev: 'S1', title: '把「未知」写成了事实',
            detail: `「${f.content}」在档案里标记为 F5 未知，正文却把它当成确有其事写出来。`,
            at: k, fix: '删掉，或写明「无人知道」「情形不明」。',
          });
          break;
        }
      }
      continue;
    }
    for (const k of keysOf(f.content)) {
      const idx = String(scene).indexOf(k);
      if (idx < 0) continue;
      // 谁在说这件事？
      const near = dlg.filter(d => Math.abs(d.index - idx) < 120);
      for (const d of near) {
        const sp = d.speaker;
        if (!sp || sp === player || sp === '你' || sp === '（未标明）') continue;
        const isNpc = npcNames.includes(sp) || sp === '官府' || sp === '民众';
        if (!isNpc) continue;
        const known = f.knowers.some(x => x.who === sp);
        if (!known) {
          out.push({
            code: 'IN-01', sev: 'S0', title: '信息泄漏：NPC 说了他不知道的事',
            detail: `「${sp}」提到了「${k}」，但这条信息（${f.id}）的知情人里没有他。`,
            at: `${sp}：${d.body.slice(0, 30)}`,
            fix: '改成他不知道、只听说、或先写他是怎么得知的（谁告诉他的、在哪听来的）。',
          });
        }
      }
    }
  }
  // 去重
  const seen = new Set();
  return out.filter(o => { const key = o.code + o.at; if (seen.has(key)) return false; seen.add(key); return true; });
}

/* ---------------- 提示词用的信息矩阵 ---------------- */
function renderInfo(state) {
  const m = infoMatrix(state);
  if (!m.rows.length) return '';
  const head = '| 信息 | ' + m.cols.join(' | ') + ' |';
  const sep = '| --- | ' + m.cols.map(() => '---').join(' | ') + ' |';
  const body = m.rows.map(r => `| ${r.信息}（${r.等级}） | ` + m.cols.map(c => r[c] || '不知道').join(' | ') + ' |').join('\n');
  return '=== 谁知道什么（信息矩阵：没登记为「知道」的人，不得说出这条信息） ===\n' + head + '\n' + sep + '\n' + body;
}

module.exports = { addFact, tell, spread, reportIntel, leakAudit, infoMatrix, renderInfo, keysOf, LEVEL, ensureFacts };
