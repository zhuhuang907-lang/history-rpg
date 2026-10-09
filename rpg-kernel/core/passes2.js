'use strict';
/**
 * 纳米级审计 · 第二组：P10–P15
 *
 * P0–P9 管的是「这一轮的文字写得对不对」。
 * P10–P15 管的是「这个世界跑起来对不对」——
 *   P10 历史真实性 HT-*   真实历史能不能被这么改
 *   P11 资源守恒   NU-*   人力钱粮兵力对不对得上账
 *   P12 信息泄漏   IN-*   NPC 有没有说他不该知道的事
 *   P13 NPC 自主性 NPC-*  NPC 是不是只为玩家服务的木偶
 *   P14 因果传播   CA-*   结果有没有因、半径与规模守不守恒、有没有延迟
 *   P15 回归       RV-*   以前犯过的错有没有复发，世界状态有没有自相矛盾
 *
 * 严重度沿用 S0（整轮作废）/ S1（必须改）/ S2（建议改）/ S3（提示）。
 */

const economy = require('./economy');
const info = require('./info');
const agency = require('./npcAgency');
const div = require('./divergence');
const snap = require('./snapshot');
const world = require('./world');

const PASS2_META = [
  { id: 'P10', name: '历史真实性', codes: 'HT-01..HT-03', ask: '真实历史被这么改了吗？锚点推翻没有？用词是不是后世的？' },
  { id: 'P11', name: '资源守恒', codes: 'NU-01..NU-04', ask: '人、钱、粮、兵，每一笔有没有来源？量级对不对？' },
  { id: 'P12', name: '信息泄漏', codes: 'IN-01..IN-02', ask: 'NPC 有没有说出他不可能知道的事？未知有没有被写成事实？' },
  { id: 'P13', name: 'NPC 自主性', codes: 'NPC-02..NPC-03', ask: '他凭什么答应？他自己想要什么、怕什么？' },
  { id: 'P14', name: '因果传播', codes: 'CA-01..CA-05', ask: '这个结果有因吗？半径越级了吗？规模守恒吗？有延迟吗？' },
  { id: 'P15', name: '回归审计', codes: 'RV-01..RV-04', ask: '以前犯过的错复发了吗？世界状态自相矛盾吗？' },
];

const CODE_LABEL = {
  'HT-01': '推翻硬锚点', 'HT-02': '真人做了史无记载的大事', 'HT-03': '时代错置',
  'NU-01': '数量超出本地承载力', 'NU-02': '账目无来源', 'NU-03': '兵力对不上', 'NU-04': '钱粮账不平',
  'IN-01': 'NPC 说了他不知道的事', 'IN-02': '未知被写成事实',
  'NPC-02': 'NPC 无动机配合', 'NPC-03': 'NPC 未登记自身利害',
  'CA-01': '无因之果', 'CA-02': '影响半径超限', 'CA-03': '规模不守恒', 'CA-04': '朝廷级后果无路径', 'CA-05': '重大后果零延迟',
  'RV-01': '旧错复发', 'RV-02': '已纠正项又出现', 'RV-03': '世界状态自相矛盾', 'RV-04': '快照缺失无法回滚',
};

/* ============================ P11：资源守恒 ============================ */
function p11Numbers(state, scene) {
  const out = [];
  // 账本守恒：无来源的净增
  for (const v of economy.conservation(state)) {
    out.push({
      code: v.code, pass: 'P11', sev: v.code === 'NU-04' ? 'S1' : 'S2',
      title: CODE_LABEL[v.code] || '账目不平',
      detail: `${v.book}「${v.item}」：${v.why}（净变动 ${v.net} ${v.unit || ''}）`,
      at: `${v.book}·${v.item}`,
      fix: '补上来源：这笔从哪来、经谁的手、凭据是什么。',
    });
  }
  // 正文里冒出来的大数字：抓「N 兵 / N 石 / N 贯 / N 人 / N 万」当量级核对
  const s = String(scene || '');
  const NUMS = { 万: 10000, 千: 1000, 百: 100 };
  // 中间允许「名/民/个/员/余/多/约」等衬字，否则「三千民夫」匹配不到
  const re = /([0-9]{1,5}|[一二三四五六七八九十百]{1,4})(万|千|百)?\s*[名民个员余多约将近之]?\s*(兵|人|石|贯|匹|艘|丁|夫|户|口)/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(s))) {
    let v = 0;
    if (/^[0-9]+$/.test(m[1])) v = Number(m[1]);
    else v = cn2num(m[1]);
    if (!v) continue;
    if (m[2]) v *= NUMS[m[2]];
    const unit = m[3];
    const claim = {
      troops: unit === '兵' ? v : undefined,
      people: (unit === '人' || unit === '丁' || unit === '户') ? v : undefined,
      labor: unit === '夫' ? v : undefined,
      grainShi: unit === '石' ? v : undefined,
      cashGuan: unit === '贯' ? v : undefined,
    };
    const bad = economy.checkScale(state, claim);
    for (const b of bad) {
      const k = b.code + m[0];
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        code: b.code, pass: 'P11', sev: 'S1', title: CODE_LABEL[b.code] || '量级不符',
        detail: `正文写了「${m[0]}」——${b.text}。`,
        at: m[0], fix: '把数字压到本地能承受的量级，或说明这批人/粮/钱是从外面调来的。',
      });
    }
  }
  return out;
}

function cn2num(t) {
  const D = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const s = String(t || '');
  if (s === '十') return 10;
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch === '十') { cur = (cur || 1) * 10; total += cur; cur = 0; }
    else if (ch === '百') { cur = (cur || 1) * 100; total += cur; cur = 0; }
    else if (ch === '千') { cur = (cur || 1) * 1000; total += cur; cur = 0; }
    else if (D[ch] != null) cur = D[ch];
  }
  return total + cur;
}

/* ============================ P15：回归 ============================
   ① 以前犯过的错，本轮又犯 → RV-01（这正是用户说的"打勾毫无作用"要防的）
   ② 已纠正项又冒出来 → RV-02
   ③ 世界状态自相矛盾 → RV-03（死人复活、地盘既属隋又属杜伏威、身份与实际权力不符）
   ④ 一轮都没存快照 → RV-04（出了事没法回滚） */
function p15Regression(state, scene, prevHistory) {
  const out = [];
  const codes = new Set();
  for (const h of (prevHistory || [])) for (const c of (h.codes || [])) if (c) codes.add(c);
  const here = new Set((state.lastViolations || []));
  for (const c of here) {
    if (codes.has(c)) {
      out.push({
        code: 'RV-01', pass: 'P15', sev: 'S1', title: '旧错复发',
        detail: `「${c}」在最近几轮里已经犯过，本轮又犯了。`,
        at: c, fix: '回到最早那一次，把根子上的设定改掉——只改本轮这句没用。',
      });
    }
  }
  // 纠正记录里的条目，正文又出现
  const led = (state.corrections && state.corrections.ledger) || [];
  const s = String(scene || '');
  for (const c of led.slice(-12)) {
    const kw = String(c.text || '').slice(0, 6);
    if (kw.length >= 3 && s.includes(kw)) {
      out.push({
        code: 'RV-02', pass: 'P15', sev: 'S2', title: '已纠正的问题又出现',
        detail: `纠正记录里写着「${c.text}」，正文又出现了类似内容。`,
        at: kw, fix: '查一下是不是同一处设定没改干净；是的话回到最早那轮重设。',
      });
    }
  }
  // 死人复活 / 地盘矛盾
  for (const d of (state.dead || [])) {
    const nm = typeof d === 'string' ? d : d.name;
    if (!nm) continue;
    const alive = /([活着|尚在|没死|复生|生还])/.test(s) && s.includes(nm);
    if (alive && /尚在|没死|复生|生还/.test(s.slice(Math.max(0, s.indexOf(nm)), s.indexOf(nm) + 20))) {
      out.push({ code: 'RV-03', pass: 'P15', sev: 'S0', title: '已死之人复生', detail: `「${nm}」已登记为死亡，正文却说他还在。`, at: nm, fix: '删掉，或回滚到他死之前那一轮重跑。' });
    }
  }
  // 快照缺失
  if (!(state.snapshots || []).length && (state.turn || 0) >= 3) {
    out.push({ code: 'RV-04', pass: 'P15', sev: 'S3', title: '没有快照，出错无法回滚', detail: `已经第 ${state.turn} 轮，一份快照都没存。`, at: 'snapshots', fix: '每 5 轮存一份；重大事件后强制存一份。' });
  }
  return out;
}

/* ============================ 汇总 ============================ */
function runPasses2({ state, draft, input, prevHistory }) {
  const scene = String((draft && draft.scene) || '');
  const worldNote = String((draft && draft.worldNote) || '');
  const text = scene + '\n' + worldNote;
  const issues = [];

  issues.push(...div.auditHistory(text, state));            // P10
  issues.push(...p11Numbers(state, text));                  // P11
  issues.push(...info.leakAudit(text, state));              // P12
  issues.push(...agency.auditAutonomy(text, state));        // P13
  issues.push(...div.auditCausal(text, state));             // P14
  issues.push(...p15Regression(state, text, prevHistory));  // P15

  // 归组：有的子模块没写 pass 字段，按错误码前缀补上
  const PREFIX = { HT: 'P10', NU: 'P11', IN: 'P12', NPC: 'P13', CA: 'P14', RV: 'P15' };
  for (const i of issues) if (!i.pass) i.pass = PREFIX[String(i.code || '').split('-')[0]] || 'P10';

  // 去重
  const seen = new Set();
  const list = issues.filter(o => { const k = o.code + '|' + (o.at || ''); if (seen.has(k)) return false; seen.add(k); return true; });

  // 按 pass 归组
  const byPass = {};
  for (const p of PASS2_META) byPass[p.id] = { ...p, issues: [] };
  for (const i of list) (byPass[i.pass] || byPass.P10).issues.push(i);

  const blocking = list.filter(i => i.sev === 'S0');
  const codes = list.map(i => i.code);
  const cnt = (list, sev) => list.filter(x => x.sev === sev).length;
  const hit = Object.values(byPass).filter(p => p.issues.length).map(p => ({
    id: p.id, name: p.name, codes: p.codes, ask: p.ask, issues: p.issues, 命中: p.issues.length,
    counts: { S0: cnt(p.issues, 'S0'), S1: cnt(p.issues, 'S1'), S2: cnt(p.issues, 'S2'), S3: cnt(p.issues, 'S3') },
    state: p.issues.some(x => x.sev === 'S0') ? '致命' : p.issues.some(x => x.sev === 'S1') ? '须改' : p.issues.length ? '存疑' : '通过',
  }));

  return {
    passes: hit,
    all: list,
    issues: list,                     // 与 P0–P9 同名，前端可以一套代码渲染两组
    codes,
    summary: { S0: cnt(list, 'S0'), S1: cnt(list, 'S1'), S2: cnt(list, 'S2'), S3: cnt(list, 'S3') },
    counts: { S0: cnt(list, 'S0'), S1: cnt(list, 'S1'), S2: cnt(list, 'S2'), S3: cnt(list, 'S3') },
    blocking: blocking.length > 0,
    blockingIssues: blocking.map(i => ({ code: i.code, title: i.title, detail: i.detail, fix: i.fix, at: i.at })),
  };
}

/* 提示词用的「本轮须避开」提醒 */
function renderPasses2(state) {
  const plan = snap.repairPlan(state);
  const lines = [];
  if (plan.ok) {
    lines.push(`· 已知最早的错误：${plan.最早错误.code}（第 ${plan.最早错误.turn} 轮）${CODE_LABEL[plan.最早错误.code] ? '——' + CODE_LABEL[plan.最早错误.code] : ''}`);
    if (plan.建议回滚到) lines.push(`· 若要修根子，应回到 ${plan.建议回滚到.id}（第 ${plan.建议回滚到.turn} 轮）`);
  }
  const rep = (state.lastViolations || []).slice(0, 4);
  if (rep.length) lines.push('· 上轮刚犯过、本轮不得再犯：' + rep.join('、'));
  return lines.length ? '=== 回归提醒 ===\n' + lines.join('\n') : '';
}

module.exports = { runPasses2, PASS2_META, CODE_LABEL, renderPasses2, p11Numbers, p15Regression, cn2num };
