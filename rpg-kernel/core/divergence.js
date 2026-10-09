'use strict';
/**
 * 历史分歧传播系统
 *
 * 对应规范第三十九（历史锚点）、四十（影响半径）、四十一（事件规模守恒）、
 *       四十二（因果链登记）、四十三（反事实检验）、四十四（分歧传播路径）章。
 *
 * 核心立场：
 *   1. 真实历史里**已确定的事**（锚点）不能改。玩家可以让历史偏，但不能让"隋炀帝在大业十一年已经死了"。
 *   2. 玩家做一件事，后果的**半径**和**规模**受这件事本身的半径与规模约束。
 *      一个粮吏亏空，惊动不了朝廷；除非有中间链条一级一级递上去。
 *   3. 每个重大变化都要登记"因 → 果"，并写明**延迟**。没有登记的因果 = 无因之果。
 *   4. 偏离不是瞬间扩散的。它先在本地传，再一级一级往外走。
 */

/* ============================ 影响半径（规范第四十章） ============================ */
const RADIUS = [
  { id: 'person', label: '一人', note: '只影响当事人自己', reach: 1 },
  { id: 'household', label: '一家 / 一户', note: '影响一个家族或一户人家', reach: 2 },
  { id: 'ward', label: '一坊 / 一里', note: '影响街坊邻里', reach: 3 },
  { id: 'town', label: '一城 / 一县', note: '影响本城本县', reach: 4 },
  { id: 'prefecture', label: '一州 / 一郡', note: '影响本州本郡', reach: 5 },
  { id: 'region', label: '一道 / 数州', note: '影响相邻数州', reach: 6 },
  { id: 'court', label: '朝廷 / 天下', note: '惊动朝廷，天下皆知', reach: 7 },
];
const SCALE = [
  { id: 'trivial', label: '琐碎', n: 1 },
  { id: 'small', label: '小事', n: 2 },
  { id: 'noticeable', label: '引人注意', n: 3 },
  { id: 'serious', label: '要紧', n: 4 },
  { id: 'major', label: '大事', n: 5 },
  { id: 'catastrophic', label: '倾覆', n: 6 },
];

function radiusOf(id) { return RADIUS.find(x => x.id === id) || RADIUS[0]; }
function scaleOf(id) { return SCALE.find(x => x.id === id) || SCALE[1]; }

/* ============================ 后世词 / 时代错置（HT-03） ============================
   词 → 最早可出现的公元年。正文里若出现早于该年的词，即为错置。 */
const ANACHRONISM = [
  { w: '内阁', from: 1402, note: '内阁之名起于明' },
  { w: '票拟', from: 1435, note: '票拟起于明宣德以后' },
  { w: '军机处', from: 1729, note: '军机处设于雍正七年' },
  { w: '总督', from: 1450, note: '总督之设起于明' },
  { w: '巡抚', from: 1400, note: '巡抚起于明' },
  { w: '布政使', from: 1376, note: '布政使司设于明洪武九年' },
  { w: '知府', from: 1370, note: '知府之名定于明' },
  { w: '知县', from: 1000, note: '知县之名起于宋' },
  { w: '科举', from: 605, note: '科举创于隋大业年间' },
  { w: '进士科', from: 605, note: '进士科创于隋' },
  { w: '纸币', from: 1024, note: '交子行于宋天圣' },
  { w: '交子', from: 1024, note: '交子行于宋天圣' },
  { w: '白银', from: 1436, note: '白银成为主币大约在明正统以后' },
  { w: '玉米', from: 1500, note: '玉米传入在明中期以后' },
  { w: '番薯', from: 1560, note: '番薯传入在明后期' },
  { w: '烟草', from: 1570, note: '烟草传入在明后期' },
  { w: '棉花', from: 900, note: '棉花广植在宋元以后' },
  { w: '火铳', from: 1259, note: '突火枪见于南宋开庆' },
  { w: '佛郎机', from: 1520, note: '佛郎机传入在明正德末' },
  { w: '红夷炮', from: 1620, note: '红夷炮在明末' },
  { w: '轮船', from: 1800, note: '轮船在清后期' },
  { w: '电报', from: 1870, note: '电报在清后期' },
  { w: '铁路', from: 1876, note: '铁路在清后期' },
  { w: '报纸', from: 1800, note: '近代报纸在清后期' },
  { w: '警察', from: 1900, note: '警察之名起于清末' },
  { w: '共和', from: 1900, note: '共和作为政体在清末民初' },
  { w: '总统', from: 1912, note: '总统在民国' },
];

/* ============================ 状态初始化 ============================ */
function ensureDiv(state) {
  if (!state.divergence) {
    state.divergence = { anchors: [], chain: [], ripples: [], level: 0, counterfactuals: [] };
  }
  const d = state.divergence;
  d.anchors = Array.isArray(d.anchors) ? d.anchors : [];
  d.chain = Array.isArray(d.chain) ? d.chain : [];
  d.ripples = Array.isArray(d.ripples) ? d.ripples : [];
  d.counterfactuals = Array.isArray(d.counterfactuals) ? d.counterfactuals : [];
  d.level = Number(d.level) || 0;
  return d;
}

/* ============================ 历史锚点（规范第三十九章） ============================
   hard=true 表示"真实历史已确定、不可改动"。玩家的一切行动都必须绕开它。 */
function addAnchor(state, { year, text, must = [], mustNot = [], source = '', hard = true }) {
  const d = ensureDiv(state);
  const a = {
    id: `A${d.anchors.length + 1}`, year: Number(year) || 0, text: String(text || ''),
    must, mustNot, source, hard: !!hard,
  };
  d.anchors.push(a);
  return a;
}

/* ============================ 因果链登记（规范第四十二章） ============================
   任何"重大变化"落地之前，必须先有一笔因果登记：
     因（谁做的/规模/半径） → 果（变了什么/规模/半径） + 延迟几日 + 中间经过谁
   没有登记的因果，审计时按"无因之果"报警。 */
function registerCausal(state, opt = {}) {
  const d = ensureDiv(state);
  const c = {
    id: `C${d.chain.length + 1}`,
    turn: state.turn || 0,
    cause: String(opt.cause || ''),
    causeScale: opt.causeScale || 'small',
    causeRadius: opt.causeRadius || 'town',
    effect: String(opt.effect || ''),
    effectScale: opt.effectScale || 'small',
    effectRadius: opt.effectRadius || 'town',
    lagDays: opt.lagDays == null ? 0 : Number(opt.lagDays),
    via: Array.isArray(opt.via) ? opt.via : (opt.via ? [opt.via] : []),   // 中间经过的人/机构
    evidence: opt.evidence || '',
  };
  d.chain.push(c);
  if (d.chain.length > 200) d.chain = d.chain.slice(-200);
  return c;
}

/* ============================ 分歧登记与传播（规范第四十四章） ============================
   玩家做了一件偏离史实的事 → 记一笔 ripple。它不会立刻天下皆知，
   而是按 radius 一级一级往外走；每走一级需要若干日。 */
function addRipple(state, { what, atRadius = 'town', scale = 'small', from = '', turn }) {
  const d = ensureDiv(state);
  const r = {
    id: `R${d.ripples.length + 1}`,
    what: String(what || ''),
    radius: atRadius,
    scale,
    from: String(from || ''),
    bornTurn: turn == null ? (state.turn || 0) : turn,
    bornYear: (state.clock && state.clock.gregorianYear) || 0,
    reach: radiusOf(atRadius).reach,
    current: radiusOf(atRadius).reach,   // 已经扩散到哪一级
    known: ['当事人'],
  };
  d.ripples.push(r);
  d.level = Math.min(100, d.level + scaleOf(scale).n * 2);
  return r;
}

/* 世界推进时：分歧一级一级往外走 */
function propagate(state, days) {
  const d = ensureDiv(state);
  const out = [];
  const dd = Math.max(0, Number(days) || 0);
  for (const r of d.ripples) {
    if (r.current >= 7) continue;
    // 每级需要的时间随级别递增：本地几天就传开，惊动朝廷要按月算
    const need = Math.max(3, 3 + (r.current - 3) * 5);
    r.waited = (r.waited || 0) + dd;
    if (r.waited >= need && r.current < 7) {
      r.waited = 0;
      r.current += 1;
      const nr = RADIUS.find(x => x.reach === r.current);
      if (nr) {
        r.known.push(nr.label);
        out.push(`「${r.what}」的风声已传到：${nr.label}`);
      }
    }
  }
  state.divergenceChanges = out;
  return out;
}

/* ============================ 反事实检验（规范第四十三章） ============================
   两个测试：
     删除测试 —— 把这件事拿掉，后面的结果还成立吗？不成立 → 说明它确实是因。
     替换测试 —— 换成另一件事，结果还一样吗？一样 → 说明它不是真正的因。 */
function counterfactual(state, { removeChainId, replaceWith = '' } = {}) {
  const d = ensureDiv(state);
  const target = d.chain.find(c => c.id === removeChainId);
  if (!target) return { ok: false, why: '找不到这笔因果' };
  const downstream = d.chain.filter(c => c.turn >= target.turn && c.id !== target.id
    && (c.cause.includes(target.effect.slice(0, 6)) || target.effect && c.cause.includes(target.effect)));
  const res = {
    id: target.id, cause: target.cause, effect: target.effect,
    删除测试: downstream.length
      ? `删掉「${target.cause}」后，后面 ${downstream.length} 件事（${downstream.map(x => x.effect).slice(0, 3).join('、')}）失去依据 —— 它确实是因。`
      : `删掉「${target.cause}」后，后面没有任何事依赖它 —— 那它在剧情里其实没起作用，不该占篇幅。`,
    替换测试: replaceWith
      ? `若把「${target.cause}」换成「${replaceWith}」，结果「${target.effect}」依然成立吗？若仍成立，说明这个结果不是由它引起的，因果链断了。`
      : '（未做替换测试）',
  };
  d.counterfactuals.push({ ...res, at: `${state.clock && state.clock.yearLabel} 第${state.turn}轮` });
  if (d.counterfactuals.length > 30) d.counterfactuals = d.counterfactuals.slice(-30);
  return res;
}

/* ============================ P10：历史真实性审计 ============================ */
function auditHistory(scene, state) {
  const out = [];
  const d = ensureDiv(state);
  const s = String(scene || '');
  if (!s) return out;
  const gy = (state.clock && state.clock.gregorianYear) || 0;

  // HT-01：硬锚点被推翻
  // 命中方式：① 正文出现了锚点原话的任一段（三字以上）  ② 直接出现了锚点明令禁止的说法
  // 例外：若那句话是"传闻/谣传/听说"，不算推翻史实——那是有人在造谣，不是 GM 改了史。
  const RUMOR = /(传闻|谣传|流言|听说|有人说|都说是|未必|难道|莫非|怕是|只怕)/;
  const grams = (t) => {
    const g = [];
    for (let i = 0; i + 3 <= t.length; i++) g.push(t.slice(i, i + 3));
    return g.length ? g : [t];
  };
  for (const a of d.anchors) {
    if (!a.hard) continue;
    const textHit = String(a.text || '').length >= 3 && grams(String(a.text)).some(g => s.includes(g));
    for (const neg of (a.mustNot || [])) {
      if (!s.includes(neg)) continue;
      if (!textHit && RUMOR.test(s.slice(Math.max(0, s.indexOf(neg) - 8), s.indexOf(neg)))) continue;
      out.push({
        code: 'HT-01', sev: 'S0', pass: 'P10', title: '推翻了不可改动的历史锚点',
        detail: `锚点「${a.text}」（${a.year} 年${a.source ? '，据' + a.source : ''}）不允许出现「${neg}」，正文却写了。`,
        at: neg, fix: `改成与史实一致：${(a.must || []).join('、') || a.text}。要偏，也只能偏在未锚定的地方。`,
      });
    }
  }

  // HT-02：真实人物做了史无记载的大事
  const BIG = /(称帝|即皇帝位|举兵|起兵|谋反|弑|篡|诛杀|自立为|僭号|改元)/;
  for (const n of (state.npcs || [])) {
    if (!n.real || !n.name || !s.includes(n.name)) continue;
    const m = s.match(new RegExp(`${n.name}[^。！？\\n]{0,20}${BIG.source}`));
    if (!m) continue;
    const anchored = d.anchors.some(a => a.text.includes(n.name));
    if (anchored) continue;
    out.push({
      code: 'HT-02', sev: 'S1', pass: 'P10', title: '真实人物做了史无记载的大事',
      detail: `「${n.name}」是真实人物，正文写他「${m[0].slice(n.name.length).trim()}」。若无史料支持，这就是篡改。`,
      at: m[0].slice(0, 30),
      fix: '先检索确认；查不到就别这么写，或改由一个虚构人物来做。',
    });
  }

  // HT-03：时代错置
  if (gy) {
    for (const x of ANACHRONISM) {
      if (gy < x.from && s.includes(x.w)) {
        out.push({
          code: 'HT-03', sev: 'S1', pass: 'P10', title: '时代错置：用了后世才有的事物',
          detail: `本年为 ${gy} 年，正文出现「${x.w}」——${x.note}。`,
          at: x.w, fix: '换成当时就有的说法，或删掉。',
        });
      }
    }
  }
  return out;
}

/* ============================ P14：因果传播审计 ============================ */
const COURT_WORD = /(朝廷|天子|皇帝|圣上|天下|诸道|诏|敕|中书|门下|尚书省)/;

function auditCausal(scene, state) {
  const out = [];
  const d = ensureDiv(state);
  const s = String(scene || '');
  const thisTurn = state.turn || 0;

  // CA-01：本轮有重大变化，却没有登记因果
  const bigChange = /(易主|失守|攻克|陷落|身亡|被杀|斩|抄家|举兵|哗变|暴涨|暴跌)/;
  if (bigChange.test(s)) {
    const has = d.chain.some(c => c.turn === thisTurn);
    if (!has) {
      out.push({
        code: 'CA-01', sev: 'S1', pass: 'P14', title: '无因之果：本轮有重大变化却没登记因果',
        detail: '正文出现了易主/死人/哗变/价格暴涨这类大事，但因果链里没有本轮的记录。',
        at: (s.match(bigChange) || [''])[0],
        fix: '补一笔：因是什么、果是什么、中间经过谁、延迟几日。写不出来就说明这件事不该直接发生。',
      });
    }
  }

  for (const c of d.chain) {
    // CA-02：影响半径超限 —— 小事惊动朝廷，中间却没人递
    const cr = radiusOf(c.causeRadius), er = radiusOf(c.effectRadius);
    if (er.reach - cr.reach > 1 && !(c.via || []).length) {
      out.push({
        code: 'CA-02', sev: 'S1', pass: 'P14', title: '影响半径超限：小因直接结出大果',
        detail: `因「${c.cause}」的半径是「${cr.label}」，果「${c.effect}」却到了「${er.label}」，中间没有经过任何人或机构。`,
        at: c.id,
        fix: '补上中间环节（谁去报的、文书走了几日、经过哪一级），或把结果的半径压回本级。',
      });
    }
    // CA-03：规模不守恒
    const cs = scaleOf(c.causeScale), es = scaleOf(c.effectScale);
    if (es.n - cs.n >= 3) {
      out.push({
        code: 'CA-03', sev: 'S2', pass: 'P14', title: '事件规模不守恒',
        detail: `因只是「${cs.label}」，果却到了「${es.label}」，跳了 ${es.n - cs.n} 级。`,
        at: c.id, fix: '把结果降级，或在中间补几级渐进的小变化。',
      });
    }
    // CA-04：果提到了朝廷，因果链却没经过官文书
    if (COURT_WORD.test(c.effect) && !(c.via || []).length) {
      out.push({
        code: 'CA-04', sev: 'S2', pass: 'P14', title: '朝廷级后果没有传递路径',
        detail: `果「${c.effect}」涉及朝廷，但没有写清消息是怎么递上去的（谁上奏、走哪道文书、几日到）。`,
        at: c.id, fix: '写明传递路径与时日：乡→县→州→道→朝廷，每一级都要时间。',
      });
    }
    // CA-05：重大后果零延迟
    if (es.n >= 4 && (!c.lagDays || c.lagDays <= 0)) {
      out.push({
        code: 'CA-05', sev: 'S2', pass: 'P14', title: '重大后果零延迟',
        detail: `「${c.effect}」是「${es.label}」级的大事，却在同一刻就发生了（延迟 ${c.lagDays} 日）。`,
        at: c.id, fix: '给它一个合乎传递距离的延迟：本地数日，跨州数十日，惊动朝廷数月。',
      });
    }
  }
  return out;
}

/* ============================ 提示词用 ============================ */
function renderDivergence(state) {
  const d = ensureDiv(state);
  const lines = [];
  if (d.anchors.length) {
    lines.push('· 不可改动的史实锚点：' + d.anchors.filter(a => a.hard).slice(-4)
      .map(a => `${a.year ? a.year + '年' : ''}${a.text}${a.mustNot && a.mustNot.length ? `（不得写：${a.mustNot.join('、')}）` : ''}`).join('；'));
  }
  if (d.level) lines.push(`· 本局对史实的偏离度：${d.level}/100`);
  const live = d.ripples.filter(r => r.current < 7).slice(-3);
  if (live.length) {
    lines.push('· 已偏离史实、正在外传的事：' + live
      .map(r => `「${r.what}」已传到${RADIUS.find(x => x.reach === r.current)?.label || '本地'}`).join('；'));
  }
  const recent = d.chain.slice(-3);
  if (recent.length) {
    lines.push('· 最近的因果登记：' + recent.map(c => `${c.cause} →（${c.lagDays}日）→ ${c.effect}`).join('；'));
  }
  if (!lines.length) return '';
  return '=== 史实锚点与分歧（不得推翻锚点；因果须登记；后果半径不得越级） ===\n' + lines.join('\n');
}

module.exports = {
  ensureDiv, addAnchor, registerCausal, addRipple, propagate, counterfactual,
  auditHistory, auditCausal, renderDivergence, RADIUS, SCALE, radiusOf, scaleOf, ANACHRONISM,
};
