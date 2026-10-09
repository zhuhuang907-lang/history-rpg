'use strict';
/**
 * NPC 独立行动队列
 *
 * 对应规范第十六至十八、三十二、四十五、五十一、五十二、五十三、五十四、六十九、七十章。
 *
 * 核心立场：
 *   NPC 不是等玩家触发的木偶。他们有目标、有恐惧、有底线、有行动能力，
 *   会自己排队做事；玩家不来找他们，他们也在动。
 *   玩家提出要求时，他们**可以拒绝**——决定由「利益+风险+信息+关系+资源+性格」算出，
 *   而不是「剧情需要，所以他同意」。
 */
const { extractDialogue } = require('./passes');

/* 面对玩家请求时的十种反应（规范 17.1） */
const REACTIONS = [
  { id: 'execute', label: '直接执行', why: '此事与他利害一致，且代价在他承受范围内' },
  { id: 'conditions', label: '提出政治条件', why: '他愿意做，但要换一样东西' },
  { id: 'bargain', label: '讨价还价', why: '价码不够，但他不想把话说死' },
  { id: 'delay', label: '拖延', why: '做了有风险，他先拖着看风向' },
  { id: 'report', label: '上报 / 请示', why: '这件事超出他的权限，或他想把责任推给上头' },
  { id: 'pretend', label: '表面答应', why: '当面不能驳你，但他另有盘算' },
  { id: 'resist', label: '暗中抵制', why: '此事损及他的根本，他不打算真做' },
  { id: 'alternative', label: '寻找替代方案', why: '原办法行不通，他另有路子' },
  { id: 'guarantee', label: '要求担保', why: '风险太大，他要有人替他担' },
  { id: 'refuse', label: '拒绝', why: '此事触到他的底线，或代价远超收益' },
];

/* NPC 自己会排队做的事（玩家不触发也在跑） */
const INDEPENDENT = [
  { id: 'collect', label: '催收旧欠', who: ['商贾', '豪强', '粮吏'], note: '上门讨账，顺带打听消息' },
  { id: 'marriage', label: '议亲嫁娶', who: ['豪强', '士人', '宗族'], note: '与某家商量婚事，牵动两家关系' },
  { id: 'hoard', label: '囤积居奇', who: ['商贾', '豪强'], note: '米价看涨，他把货压着不卖' },
  { id: 'petition', label: '上告 / 递状', who: ['士人', '百姓', '豪强'], note: '为田产或旧怨递了一纸状子' },
  { id: 'ally', label: '私下结交', who: ['将领', '官吏', '豪强'], note: '与某人往来，结成一股' },
  { id: 'conceal', label: '串供遮掩', who: ['粮吏', '细作', '官吏'], note: '与人把说法对齐，抹去痕迹' },
  { id: 'flee', label: '打点退路', who: ['细作', '粮吏', '商贾'], note: '风声不对，他在安排后路' },
  { id: 'recruit', label: '招兵买马', who: ['将领', '豪强'], note: '暗地招人、备械' },
  { id: 'gossip', label: '散播风声', who: ['商贾', '细作', '百姓'], note: '把某件事有意说出去' },
];

function seeded(a, b) {
  let h = 2166136261 ^ (a || 0);
  const s = String(b || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* 从已有档案字段推出 NPC 的内在（不凭空捏造，尽量沿用已登记的内容） */
function ensureAgency(state) {
  (state.npcs || []).forEach((n, i) => {
    // 旧档修复：「个人所图史无明载」占位目标改为按职掌推定的立场；远方未交往者清空
    if (/史无明载/.test(String(n.goal || '') + String((n.agency && n.agency.短期目标) || ''))) {
      const far = n.source === 'historical' && !n.contact;
      n.goal = far ? '' : require('./worldgen').roleWants(n.role);
      n.risk = far ? '' : '在府主面前失信、担上误事之责';
      n.defectionCondition = '';
      n.agency = null;
    }
    if (n.agency) { n.agency.queue = n.agency.queue || []; return; }
    const rnd = seeded(i * 31 + 7, `${state.meta && state.meta.id}|${n.name}|agency`);
    const tie = String(n.tie || '');
    const goal = String(n.goal || '') || (/(上官|属僚|下属|部属)/.test(tie) ? '保住差事、磨勘顺利' : '自保并谋一分利');
    const risk = String(n.risk || '') || '被牵连、被当成替罪羊';
    n.agency = {
      短期目标: goal,
      长期目标: String(n.longGoal || ''),
      恐惧: risk,
      底线: String(n.defectionCondition || '') || '危及身家性命',
      风险承受: 0.3 + Math.round(rnd() * 4) / 10,   // 0.3–0.7
      行动能力: 0.3 + Math.round(rnd() * 5) / 10,   // 0.3–0.8
      亲疏: /亲信|心腹|旧部|家人/.test(tie) ? 0.7 : /(上官|属僚|管辖)/.test(tie) ? 0.4 : 0.2,
      queue: [],
      waitingFor: '',
    };
  });
  return state;
}

/* —— 玩家提出要求时，NPC 怎么回应（第十七章：目标函数）—— */
function decide(state, npcName, request = {}) {
  const n = (state.npcs || []).find(x => x.name === npcName);
  if (!n) return null;
  const a = n.agency || (ensureAgency(state), n.agency);
  const rnd = seeded((n.name || '').length * 17 + (request.cost || 0), `${state.meta && state.meta.id}|${state.turn}|${n.name}|decide`);

  const gain = num01(request.gain, 0.5);        // 这事对他有多大好处
  const cost = num01(request.cost, 0.5);        // 他要付多大代价
  const risk = num01(request.risk, 0.5);        // 有多大风险
  const score = gain * 0.9 + a.亲疏 * 0.5 + a.行动能力 * 0.2 - cost * 0.8 - risk * (1.2 - a.风险承受) * 1.4;
  const jitter = (rnd() - 0.5) * 0.18;

  let pick;
  const s = score + jitter;
  if (risk > 0.85 && s < -0.2) pick = 'refuse';
  else if (s > 0.55) pick = 'execute';
  else if (s > 0.35) pick = gain > 0.6 ? 'conditions' : 'bargain';
  else if (s > 0.15) pick = rnd() < 0.5 ? 'guarantee' : 'alternative';
  else if (s > -0.05) pick = rnd() < 0.5 ? 'delay' : 'report';
  else if (s > -0.35) pick = rnd() < 0.5 ? 'pretend' : 'resist';
  else pick = 'refuse';

  const r = REACTIONS.find(x => x.id === pick) || REACTIONS[9];
  return {
    npc: n.name, reaction: r.id, label: r.label,
    理由: r.why,
    依据: { 好处: gain, 代价: cost, 风险: risk, 亲疏: a.亲疏, 风险承受: a.风险承受, 行动能力: a.行动能力, 得分: Number(s.toFixed(2)) },
    提示: pick === 'refuse' ? '他不会白答应。要么加价，要么换人，要么先解决他怕的那件事。'
      : pick === 'pretend' || pick === 'resist' ? '他当面应了，但你要防他不做。'
        : '',
  };
}

function num01(v, d) { const x = Number(v); return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : d; }

/* —— 世界自行推进时，NPC 自己排队做的事（第五十一章）—— */
function tickNpcs(state, days) {
  ensureAgency(state);
  const log = [];
  const d = Math.max(0, Number(days) || 0);
  for (const n of (state.npcs || [])) {
    const a = n.agency || {};
    const rnd = seeded((state.turn || 0) * 13 + (n.name || '').length, `${state.meta && state.meta.id}|${state.turn}|${n.name}|tick`);
    // 每过若干日，有一定概率自己动一下；行动能力越高越可能
    if (rnd() > 0.25 + (a.行动能力 || 0.4) * 0.35 * Math.min(3, d + 1)) continue;
    const pool = INDEPENDENT.filter(x => !x.who.length || x.who.some(w => String(n.role || '').includes(w) || String(n.tie || '').includes(w)));
    const pickAct = (pool.length ? pool : INDEPENDENT)[Math.floor(rnd() * (pool.length || INDEPENDENT.length)) % (pool.length || INDEPENDENT.length)];
    a.queue = a.queue || [];
    a.queue.push({ turn: state.turn, 事: pickAct.label, 说明: pickAct.note, done: false });
    if (a.queue.length > 8) a.queue = a.queue.slice(-8);
    log.push(`${n.name}：${pickAct.label}（${pickAct.note}）`);
  }
  state.npcTickLog = log;
  return log;
}

/* —— P13：NPC 自主性审计 ——
   问一句：这个行动是不是**只为玩家服务**？如果是，它的自身利益在哪？ */
const COMPLY = /(遵命|答应|应下|愿意|从命|立刻去办|马上办|这就去办|全凭|任凭|悉听|自当效力|不敢不从|愿效犬马)/;
function auditAutonomy(scene, state) {
  const out = [];
  const npcs = (state.npcs || []).filter(n => n.name);
  const dlg = extractDialogue(String(scene || ''));
  const player = (state.protagonist && state.protagonist.name) || '你';

  for (const d of dlg) {
    const sp = d.speaker;
    if (!sp || sp === player || sp === '你' || sp === '（未标明）') continue;
    const n = npcs.find(x => x.name === sp);
    if (!n) continue;
    if (!COMPLY.test(d.body)) continue;
    const a = n.agency || {};
    // 无条件答应：台词里既没有条件、也没有代价、档案里也看不出他图什么
    const hasCondition = /(若|倘若|只要|条件是|但|不过|须得|请|求|换)/.test(d.body);
    const hasSelfInterest = [a.短期目标, a.恐惧, a.底线].filter(Boolean).join('');
    if (!hasCondition) {
      out.push({
        code: 'NPC-02', sev: 'S1', title: 'NPC 无动机地配合玩家',
        detail: `「${sp}」说了「${d.body.slice(0, 24)}」—— 既没提条件也没提要价。他的自身利益是「${hasSelfInterest || '（档案未登记）'}」，对不上。`,
        at: `${sp}：${d.body.slice(0, 40)}`,
        fix: '改成有条件地答应（要价、要担保、要时限），或改成拖延/拒绝。',
      });
    }
  }

  // NPC 档案缺「目标/恐惧/底线」三件 → 它只能当木偶
  const hollow = npcs.filter(n => !n.agency || (!n.agency.短期目标 && !n.agency.恐惧));
  for (const n of hollow.slice(0, 4)) {
    out.push({
      code: 'NPC-03', sev: 'S3', title: 'NPC 没有登记自身利害',
      detail: `「${n.name}」没有目标与恐惧，写他时只能靠临场编，容易变成剧情工具人。`,
      at: n.name, fix: '在人物表里补上：他要什么、怕什么、什么时候会反。',
    });
  }
  const seen = new Set();
  return out.filter(o => { const k = o.code + o.at; if (seen.has(k)) return false; seen.add(k); return true; });
}

/* —— 提示词用：本轮有哪些 NPC 在自己动 —— */
function renderAgency(state) {
  const rows = [];
  for (const n of (state.npcs || [])) {
    const a = n.agency;
    if (!a) continue;
    // 远方、尚未交往的人不列：写不到他，列出来只会让 GM 硬把他拉进场
    if (n.source === 'historical' && !n.contact && !(n.firstSeenTurn > 0)) continue;
    if (/史无明载/.test(String(a.短期目标 || ''))) continue;
    const q = (a.queue || []).filter(x => !x.done).slice(-1)[0];
    const line = `- ${n.name}（${n.role || ''}）：他要「${a.短期目标 || '未登记'}」，怕「${a.恐惧 || '未登记'}」，底线是「${a.底线 || '未登记'}」。`
      + (q ? `本轮他自己在做：${q.事}（${q.说明}）。` : '');
    rows.push(line);
  }
  if (!rows.length) return '';
  return '=== 人物各自在做什么（他们不等玩家也在动；写他们时须按这些利害来） ===\n' + rows.join('\n');
}

module.exports = { ensureAgency, decide, tickNpcs, auditAutonomy, renderAgency, REACTIONS, INDEPENDENT };
