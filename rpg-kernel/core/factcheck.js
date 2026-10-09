'use strict';
/**
 * 自动事实核查（引擎主动，不靠人、也不靠模型自觉）。
 *
 * 解决的问题：以前检索是**模型自己决定**要不要发 `SEARCH:` —— 它可能不发、也可能只查无关的东西，
 * 于是史实错误照样溜进正文，还得玩家自己去核对。
 *
 * 这个模块让**引擎**负起责任，两步走：
 *   ① 写前预检索 planPreSearch —— 从存档与玩家输入里自动抽出该查的词（在场真人、地名、年号、职官、事件），
 *      主动查好、作为「证据」注入提示词，让模型**照着证据写**，而不是凭记忆写。
 *   ② 写后校验 verifyClaims —— 从正文里抽出可核验的具体断言（人名、地名、年份、职官、数目），
 *      自动查证后交给模型逐条判定：确认 / 矛盾 / 无法核实；有矛盾就自动修一遍。
 *
 * 全部自动化：玩家不需要点任何按钮、也不需要自己核对。
 */

/* 只挑「值得查、查得到、错了要命」的词，控制调用量 */
const MAX_PRE = 5;
const MAX_POST = 4;

const has = (s, w) => s && s.indexOf(w) >= 0;

/** 从存档里挑出「本轮在场/相关的真实词条」——用于写前预检索。
    原则：只查**具体的人、大事、地名沿革**；不查泛词。 */
function planPreSearch(state, input) {
  const q = [];
  const push = (x) => { const v = String(x || '').trim(); if (v && v.length >= 2 && !q.includes(v)) q.push(v); };
  const gy = (state.clock && state.clock.gregorianYear) || 0;
  const era = (state.clock && state.clock.yearLabel) || '';
  const pol = (state.location && state.location.polity) || '';

  // 1) 在场真人（最该核，错了最要命）——带年份一起查，避免同名异代
  // 长局里轮流复查：每回合换两位，几回合下来名册上的真人都会被重新核一遍（人会升迁、贬谪、死去）
  const hist = (state.npcs || []).filter(n => n.source === 'historical' && n.name);
  const off = hist.length ? ((state.turn || 0) * 2) % hist.length : 0;
  for (const n of hist.slice(off, off + 2).concat(hist.slice(0, Math.max(0, off + 2 - hist.length)))) push(gy ? `${n.name} ${gy} 生平` : `${n.name} 生平`);

  // 2) 玩家输入里点名的真实对象（人物/大事/地名）
  const inp = String(input || '');
  const ev = inp.match(/[\u4e00-\u9fa5]{2,6}(?:之乱|之變|之变|之战|之戰|起义|起義|变法|變法|和议|和議|之盟|北伐)/);
  if (ev) {
    // 去掉前缀动词（"我想打听祖逖北伐" → "祖逖北伐"）
    // 前缀可能叠用（「我想打听」「去查查」），反复剥到剩下名词为止
    const cleaned = ev[0].replace(/^(?:我|想|要|去|查|问|打听|了解|找|关于|看看|听说)+/, '');
    if (cleaned.length >= 2) push(`${cleaned} ${era}`.trim());
  }
  const per = inp.match(/(?:查|问|打听|了解|找)\s*([\u4e00-\u9fa5]{2,4})(?:的|这|那|$)/);
  if (per && per[1] && !/一下|清楚|明白|打听/.test(per[1])) push(`${per[1]} ${gy || era}`.trim());

  // 3) 本局的时空基线（一次查清，防止把朝代/归属写错）
  const loc = (state.location && state.location.full) || '';
  if (loc && pol) push(`${loc} ${pol} ${era} 沿革`.trim());

  // 4) 本年天下大事：保证史事进程连贯（每年换一次查询词，命中缓存后几乎零成本）
  if (gy && pol) push(`${pol} ${gy}年 大事`);

  return q.slice(0, MAX_PRE);
}

/**
 * 从正文里抽出「可核验断言」。
 * 关键：区分 **值得单独去查的**（searchable）与**只需对照证据判定的**。
 *   泛词（"将军""刺史""元年"）不该单独搜 —— 搜了也是百科定义，浪费额度；
 *   真正的重点是**具体的人名、大事、地名+时代**。
 */
function extractClaims(scene, state) {
  const t = String(scene || '');
  if (!t) return [];
  const claims = [];
  const seen = new Set();
  const add = (kind, text, searchable) => { const k = kind + '|' + text; if (seen.has(k)) return; seen.add(k); claims.push({ kind, text, searchable: !!searchable }); };

  // 1) 真实人物（最该查、错了最要命）→ 可单独搜
  for (const n of (state.npcs || [])) {
    if (n.source === 'historical' && n.name && has(t, n.name)) add('真实人物', n.name, true);
  }
  // 2) 大事名（之乱/之战/之变/起义/变法/和议/之盟）→ 可单独搜
  const events = t.match(/[\u4e00-\u9fa5]{2,6}(?:之乱|之變|之变|之战|之戰|起义|起義|变法|變法|和议|和議|之盟)/g) || [];
  for (const e of [...new Set(events)].slice(0, 2)) add('大事', e, true);
  // 3) 具体公元年（如 313年）→ 可单独搜（配时代更准）
  const gy = (state.clock && state.clock.gregorianYear) || 0;
  const yrs = t.match(/(?<![0-9])([1-9][0-9]{2,3})年/g) || [];
  for (const y of [...new Set(yrs)].slice(0, 1)) add('公元年', y.replace(/年$/, '') + '年 中国 大事', true);
  // 4) 年号名（建兴元年 → 取「建兴」这种有辨识度的年号，而非泛词「元年」）→ 可单独搜
  const eraM = t.match(/([\u4e00-\u9fa5]{2})(?:元年|二年|三年|四年|五年|六年|七年|八年|九年|十年)/);
  if (eraM && !/^[元二三四五六七八九十]/.test(eraM[1])) add('年号', `${eraM[1]} 年间 中国`, true);

  // 5) 以下只做「对照判定」，不单独去搜（泛词搜了没意义）
  const offices = t.match(/(?:刺史|太守|县令|知县|知府|节度使|都督|将军|校尉|都尉|尚书|侍郎|御史|丞相|宰相|中书|门下|郡守|巡抚|总兵)/g) || [];
  for (const o of [...new Set(offices)].slice(0, 2)) add('官职', o, false);
  // 6) 古地名：只取「地名+行政后缀」，剔掉动词粘连与量词（"军领豫州"、"鲁阳一县"）
  const places = t.match(/[\u4e00-\u9fa5]{1,2}(?:县|州|府|郡|关|關)/g) || [];
  const goodPlaces = [...new Set(places)].filter(p => {
    const name = p.replace(/[县州府郡关關]$/, '');
    if (!name) return false;
    if (/^[一二两三四五六七八九十百千万]/.test(name)) return false;   // 不能说"一县/两县"
    if (/[一二两三四五六七八九十百千万]$/.test(name)) return false;   // "阳一县"这种
    if (/^[军领镇据屯驻守知刺的地于在至到大小此那这两个]/.test(name)) return false;
    return true;
  });
  for (const p of goodPlaces.slice(0, 2)) add('地名', p, false);

  return claims;
}

/** 把检索结果拼成证据块 */
function evidenceBlock(items) {
  const lines = [];
  for (const it of items) {
    if (!it) continue;
    const rs = (it.results || []).slice(0, 4);
    if (!rs.length) { lines.push(`· 查「${it.query}」：无结果（此项无法核实，须标注不确定）`); continue; }
    lines.push(`· 查「${it.query}」：`);
    lines.push(rs.map(x => `    - ${x.title}：${String(x.snippet || '').slice(0, 160)}`).join('\n'));
  }
  return lines.join('\n');
}

/**
 * 写后自动校验：把正文断言 + 检索证据交给模型逐条判定。
 * 返回 { rows, contradictions, uncertain }
 */
async function verifyClaims({ scene, state, adapter, config, evidence }) {
  const claims = extractClaims(scene, state);
  if (!claims.length || !adapter) return { rows: [], contradictions: [], uncertain: [], claims: [] };
  const ev = evidenceBlock(evidence || []);
  if (!ev) return { rows: [], contradictions: [], uncertain: [], claims };

  const ask = `下面是本轮正文中出现的**具体史实断言**，以及刚从联网检索得到的**证据**。
请只依据证据逐条判定，不要用你的记忆补充。每条给出三态之一：
- 确认（证据支持）
- 矛盾（证据与之冲突 —— 必须指出冲突在哪）
- 无法核实（证据不足，或检索无结果）

正文断言：
${claims.map((c, i) => `${i + 1}. 〔${c.kind}〕${c.text}`).join('\n')}

检索证据：
${ev}

只输出 JSON，不要解释：
{"items":[{"claim":"","kind":"","verdict":"确认|矛盾|无法核实","why":"","fix":""}]}
若判为「矛盾」，请在 fix 里给出**改成什么才对**（依据证据）。`;

  try {
    const r = await adapter.call({ system: '你是史料校对员。只依据给定证据判定，证据不足就写「无法核实」，绝不凭记忆下结论。只输出 JSON。', prompt: ask }, config || {});
    let s = String(r.text || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) s = fence[1];
    const i = s.indexOf('{'), k = s.lastIndexOf('}');
    if (i < 0 || k < 0) throw new Error('无 JSON');
    const data = JSON.parse(s.slice(i, k + 1));
    const items = (data.items || []).filter(x => x && x.claim);
    const contradictions = items.filter(x => /矛盾/.test(x.verdict));
    const uncertain = items.filter(x => /无法核实/.test(x.verdict));
    return { rows: items, contradictions, uncertain, claims, raw: r.text };
  } catch (e) {
    return { rows: [], contradictions: [], uncertain: [], claims, error: String(e.message || e) };
  }
}

/** 有矛盾时，让模型按证据自动改一处（只改矛盾点，不重写全篇） */
async function autoRepair({ scene, contradictions, adapter, config }) {
  if (!contradictions || !contradictions.length || !adapter) return null;
  const list = contradictions.map((c, i) => `${i + 1}. 原写：${c.claim}\n   问题：${c.why}\n   应改为：${c.fix || '（依证据订正）'}`).join('\n');
  const ask = `下面这段正文有几处与史料冲突。请**只改这几处**，其余一字不动，保持原有文风与长度。
改动处须严格按「应改为」执行；若要改的地方涉及人名/地名/官职，务必用给出的正确写法。

需修正：
${list}

原文：
${scene}

只输出修正后的正文（纯文本，不要 JSON，不要解释）：`;
  try {
    // 正文可达 2000 字，返修稿不能被默认 token 上限截断
    const r = await adapter.call({ system: '你是史料校对员，只做最小必要订正，不重写、不扩写。', prompt: ask, maxTokens: 6000 }, config || {});
    const fixed = String(r.text || '').trim();
    return fixed && fixed.length > 20 ? fixed : null;
  } catch { return null; }
}

module.exports = { planPreSearch, extractClaims, verifyClaims, autoRepair, evidenceBlock, MAX_PRE, MAX_POST };
