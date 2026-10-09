'use strict';
/**
 * 人口 / 农业 / 财政 / 市场 / 资源守恒
 *
 * 对应规范第八、十、十一、十二、二十五、六十二、六十三、八十八章。
 *
 * 核心立场（规范第八十六、八十七章）：
 *   数字不是装饰。每一次资源变动都必须记进账本，并且**必须写明来源**；
 *   账对不上就报警；量级离谱就报警；没有依据的精确数字不许伪装成史实。
 */

/* 定居点规模基准（按当时常见户数估，量级用，不冒充精确史料） */

/**
 * 米价基准：绝不是写死一个「300」。
 * 用户明确指出「米价等数字是可以搜到的」——说明引擎不该拿一个常数糊弄。
 * 这里按朝代给一个**量级区间的推算中值**，并明确标注「estimate / 未据史核定」。
 * 真正的定值应在启用检索后由引擎查史料覆盖（applyHistoricalFigures / factcheck 的同一口径）。
 *
 * 量级依据（均为常年平均，灾年另按 1.6 倍上浮）：
 *   汉      约 100 文/石（《九章算术》注、居延汉简粟价）
 *   三国两晋南北朝  约 150~300 文/石，战乱年暴涨（如梁太清之乱「米一升七八万钱」）
 *   隋      约 80~120 文/石
 *   唐(开元) 约 20~50 文/石（史称「米斗三钱」乃极盛之语，取常价 30 上下）
 *   宋      约 60~120 文/石（北宋常价，熙宁变法前后波动）
 *   元      约 数贯/石（钞贱，量级）
 *   明      约 300~600 文/石（折银前）
 *   清      约 1000~3000 文/石（白银计价，石米约 1~2 两）
 * 没有把握的朝代一律回落到「南北朝量级」并标 estimate，绝不冒充精确。
 */
function grainBaselineByEra(year) {
  const y = Number(year) || 0;
  let value = 250, label = '南北朝量级';
  if (y >= 202 && y < 220) { value = 100; label = '汉'; }
  else if (y >= 220 && y < 280) { value = 200; label = '三国'; }
  else if (y >= 280 && y < 420) { value = 180; label = '两晋'; }
  else if (y >= 420 && y < 589) { value = 250; label = '南北朝'; }
  else if (y >= 581 && y < 618) { value = 100; label = '隋'; }
  else if (y >= 618 && y < 907) { value = 35; label = '唐'; }
  else if (y >= 907 && y < 960) { value = 300; label = '五代'; }
  else if (y >= 960 && y < 1279) { value = 90; label = '宋'; }
  else if (y >= 1271 && y < 1368) { value = 1500; label = '元'; }
  else if (y >= 1368 && y < 1644) { value = 400; label = '明'; }
  else if (y >= 1644 && y < 1912) { value = 1800; label = '清'; }
  return { value, label };
}

/** 给市场一块挂上「米价为推算」的免责与来源标注（此前完全无来源） */
function tagMarketEstimate(e, src) {
  e.market = e.market || {};
  if (!e.market.grainSource) e.market.grainSource = 'estimate';
  if (!e.market.grainNote) {
    e.market.grainNote = '米价为引擎按朝代量级推算的中值，非史实定值；启用检索后可据史核定覆盖。';
  }
}
const SCALE_BY_TYPE = [
  // 注意：不能只写「都」——「江都」「成都」这类地名里的都会误判成都城
  [/京师|京城|京都|上都|东京|西京|南京|北京|洛陽|洛阳|长安/, { label: '都城', households: 60000, pop: 300000, farm: 0.25 }],
  [/府|州|郡|路/, { label: '州府城', households: 12000, pop: 60000, farm: 0.45 }],
  [/县|城|邑/, { label: '县城', households: 3000, pop: 15000, farm: 0.62 }],
  [/镇|市|集/, { label: '镇市', households: 800, pop: 4000, farm: 0.70 }],
  [/乡|亭|里/, { label: '乡里', households: 300, pop: 1500, farm: 0.85 }],
  [/村|寨|坞|堡/, { label: '村落', households: 80, pop: 400, farm: 0.92 }],
];

function scaleOf(locationText) {
  const t = String(locationText || '');
  for (const [re, v] of SCALE_BY_TYPE) if (re.test(t)) return v;
  return { label: '县城', households: 3000, pop: 15000, farm: 0.62 };
}

/* 年龄结构（古代户均约 5 口）与职业结构 */
const AGE_SHARE = { 丁男: 0.27, 丁女: 0.26, 儿童: 0.32, 老者: 0.15 };
const CLASS_SHARE = {
  农户: 0.68, 工匠: 0.06, 商贾: 0.04, 士人: 0.02,
  吏役: 0.015, 军户: 0.03, 僧道: 0.015, 奴婢依附: 0.05, 流民: 0.02, 外来: 0.07,
};

/* ------------------------------------------------------------------
 * 户口估算的时代量级：**按公元区间判定**，不用朝代关键字（避免「刘宋/赵宋」混淆）。
 * 同样是「州」，汉之某州与清之某州户口相差数倍。这只是引擎给的估算基线。
 * ------------------------------------------------------------------ */
const ERA_POP = [
  { to: -221, label: '先秦', scale: 0.5 },
  { to: 220, label: '秦汉', scale: 0.6 },
  { to: 581, label: '魏晋南北朝', scale: 0.5 },
  { to: 907, label: '隋唐', scale: 0.85 },
  { to: 1279, label: '宋辽金', scale: 1.2 },
  { to: 1368, label: '元', scale: 0.95 },
  { to: 1644, label: '明', scale: 1.3 },
  { to: 1912, label: '清', scale: 1.6 },
];
/* 地域富庶度：江南、两浙、京畿户口远密于边鄙 */
const REGION_POP = [
  { re: /两浙|兩浙|江南|三吴|苏|常|杭|扬|湖|秀|润|明州/, label: '江南富庶之地', scale: 1.35 },
  { re: /京师|京畿|开封|汴|长安|洛阳|成都|建康|临安/, label: '京畿要会', scale: 1.2 },
  { re: /朔方|陇右|河西|西域|岭南|交趾|琼|宁远/, label: '边鄙荒远', scale: 0.7 },
];

/* ------------------------------------------------------------------
 * 身份决定你掌多大的盘子 —— 不是地点字串说了算。
 * 过去 initEconomy 只按 location 匹配城市等级，于是**皇帝被塞进一个州的财政里**。
 * 天子掌天下，藩镇贵族掌封域，职官掌所治之境，黔首只有一身一家。
 * ------------------------------------------------------------------ */
const EMPIRE_HOUSEHOLDS = [
  { to: 220, households: 12233062, source: 'recorded', confidence: 'medium', note: '《汉书·地理志》元始二年民户一千二百二十三万三千六十二，正史所载' },
  { to: 580, households: 5000000, source: 'estimate', confidence: 'low', note: '魏晋南北朝丧乱，户籍远逊两汉，此为量级估计' },
  { to: 907, households: 8914709, source: 'recorded', confidence: 'medium', note: '《通典》天宝十四载户八百九十一万四千七百九，政书所载' },
  { to: 1279, households: 15000000, source: 'estimate', confidence: 'low', note: '宋代诸书记载户数不一，此为数量级估计' },
  { to: 1368, households: 13000000, source: 'estimate', confidence: 'low', note: '元代户数估计量级' },
  { to: 1644, households: 10000000, source: 'estimate', confidence: 'low', note: '明代黄册户数估计量级' },
  { to: 1912, households: 25000000, source: 'estimate', confidence: 'low', note: '清代中后期户数量级估计' },
];

function scopeOf(state) {
  const idm = String(state.identityModule || 'official');
  const role = String((state.protagonist && state.protagonist.role) || '');
  const loc = String((state.location && state.location.full) || '');
  const y = Number(state.clock && state.clock.gregorianYear) || 0;

  if (idm === 'emperor') {
    const e = EMPIRE_HOUSEHOLDS.find(x => y <= x.to) || EMPIRE_HOUSEHOLDS[EMPIRE_HOUSEHOLDS.length - 1];
    return { level: 'empire', label: '天下（在籍编户）', households: e.households,
      source: e.source, confidence: e.confidence, note: e.note };
  }
  if (idm === 'warlord') {
    const n = Math.max(1, (state.territory || []).length);
    return { level: 'domain', label: `割据所据 ${n} 处`, households: 12000 * n,
      source: 'generated', confidence: 'low', note: '按已登记地盘折州等量级估计' };
  }
  // 宗王出镇、带都督/刺史实职的（如萧纪「都督益梁等十三州诸军事、益州刺史」），按所督州镇算，
  // 不能当成一块食邑——旧版据此给萧纪估出 1200 兵，与「器甲殷积，有马八千匹」差了一个量级。
  if ((idm === 'noble' || idm === 'official') && /都督.{0,12}诸军事/.test(role)) {
    const m = role.match(/(十?)([一二三四五六七八九]?)州/);
    const digit = m ? '一二三四五六七八九'.indexOf(m[2]) + 1 : 0;
    const zhou = m && (m[1] || digit) ? (m[1] ? 10 : 0) + digit : 3;
    return { level: 'region', label: `都督 ${zhou} 州（以所治之州为本）`, households: Math.min(400000, 30000 * zhou),
      source: 'estimate', confidence: 'low', note: '南北朝州郡户口多无确数，按所督州数估其量级；正文不得把这些估数当史实引用' };
  }
  if (idm === 'noble') {
    return { level: 'domain', label: '封国 · 食邑（约比大郡）', households: 100000,
      source: 'estimate', confidence: 'low', note: '封君食邑多为郡县量级，此为估计' };
  }
  if (idm === 'official') {
    const fromRole = scaleOf(role);
    // 职衔里带地名（通判常州军州事 / 知某县）者，以其所治之城为准；否则用所在之城
    const use = (role && /[\u4e00-\u9fa5]/.test(role) && fromRole.label !== scaleOf(loc).label) ? fromRole : scaleOf(loc);
    return { level: 'jurisdiction', label: `所治：${use.label}`, households: use.households,
      source: 'generated', confidence: 'low', note: '按职衔所示治所推其辖境' };
  }
  // 黔首：他掌的只有自家门户（约 5 口、30 亩），不是一座城。
  // 显示整州户口会让他看起来像个州官 —— 那是不对的。
  const sc0 = scaleOf(loc);
  return { level: 'household', label: `一身一家（所在 ${sc0.label}，非其所有）`, households: 1,
    source: 'generated', confidence: 'low', note: '黔首只掌自家门户：五口之户、田约三十亩；所在聚落仅供参照' };
}

function eraMeta(state) {
  const y = Number(state && state.clock && state.clock.gregorianYear) || null;
  let era = { label: '（年代不详）', scale: 1 };
  if (y != null) for (const e of ERA_POP) if (y <= e.to) { era = e; break; }
  const g = String((state && state.location && state.location.full) || '');
  let region = { label: '常地', scale: 1 };
  for (const r of REGION_POP) if (r.re.test(g)) { region = r; break; }
  return { era, region, mul: era.scale * region.scale };
}

const ECON_VERSION = 2;   // v2：官仓只收税赋（旧版把百姓收成倒进官仓，是致命错误）

function initEconomy(state, opts = {}) {
  // 幂等：已经建过就不再重置。但算过版的旧算法会直接重建，免得错误数字一直用下去。
  if (!opts.force && state.economy && state.economy.population && state.economy.ledgers
      && state.economy.version === ECON_VERSION) {
    // 早退也要补史料覆盖：老档是在加这条规则之前建的，马匹之类可能还是公式值。
    // 覆盖是幂等的（有出处才覆盖、并记录 before/after），重复调用无副作用。
    applyHistoricalFigures(state, state.economy);
    return state.economy;
  }
  const loc = String((state.location && state.location.full) || '');
  const sc = scaleOf(loc);
  const em = eraMeta(state);
  const year = Number(state.clock && state.clock.gregorianYear) || 0;
  const scope = scopeOf(state);
  // 盘子由身份定；天下一级的户口已内含时代差异，不再乘地域系数
  const households = opts.households
    || (scope.level === 'empire' ? scope.households : Math.round(scope.households * em.mul));
  const pop = opts.population || Math.round(households * 5);
  const age = {};
  for (const [k, v] of Object.entries(AGE_SHARE)) age[k] = Math.round(pop * v);
  const byClass = {};
  let acc = 0;
  const clsEntries = Object.entries(CLASS_SHARE);
  clsEntries.forEach(([k, v], i) => {
    const n = i === clsEntries.length - 1 ? pop - acc : Math.round(pop * v);
    byClass[k] = n; acc += n;
  });
  // 亩产：北方旱作约 1 石/亩，南方稻作约 2–3 石/亩（按量级取 2）
  // 天下尺度用南北通算的亩产（约 1.5 石），不再按一地水利稻作计
  const grainPerMu = opts.grainPerMu
    || (scope.level === 'empire' ? 1.5 : (/(江|淮|湖|两浙|江南|蜀|益|广)/.test(loc) ? 2.0 : 1.2));
  const farmlandMu = Math.round(households * 30);
  // 全境产出：这是**百姓田里的总收成**，不是官府能拿到的钱粮
  const annual = Math.round(farmlandMu * grainPerMu);
  const taxRate = opts.taxRate ?? 0.1;
  // 官府岁入：只有税赋这一条来源（此前把百姓收成的一半倒进官仓，是致命错误）
  const annualTaxShi = Math.round(annual * taxRate);

  // 兵数随盘子走：黔首家里没有兵（旧版 Math.max(50,…) 硬塞五十人，也属失实）
  // 出镇都督（南北朝军镇）养兵远比州县多：按口数 3% 估（萧纪东下时史称「众数万」，世子萧圆照一路即三万）
  const troops = opts.troops ?? (scope.level === 'household' ? 0
    : Math.max(50, Math.round(pop * (scope.level === 'region' ? 0.03 : 0.004))));
  // 赋税不是全留在本地：大头「上供」起运朝廷/转运司，本州仓只留存留部分。
  // 少了这一环，州仓就会单调上涨，几年堆出几十年赋入——那不是守恒，那是漏算了去处。
  const retainedRatio = opts.retained ?? 0.4;
  const annualUpkeepShi = Math.round(troops * 24 + households * 0.5);
  const cashGuan = opts.cashGuan ?? Math.round(households * 0.6);
  const grainShi = Math.round(annualTaxShi * retainedRatio * 1.5);

  state.economy = {
    version: ECON_VERSION,
    scale: scope.label,
    // 盘子来源标注：皇帝取正史/政书所载户数十 Mid 可信；其余为引擎估算
    scope: { level: scope.level, source: scope.source, confidence: scope.confidence, note: scope.note },
    estimate: {
      source: scope.source, confidence: scope.confidence,
      basis: scope.level === 'empire'
        ? scope.note
        : `${scope.label}基准 ${scope.households} 户 × ${em.era.label}量级 ${em.era.scale} × ${em.region.label} ${em.region.scale}`,
      note: '户口/田亩/产出除正史所载者外，均为引擎估算量级；如需真实数目请自行核改。',
    },
    population: { households, total: pop, ...age, byClass, farmlandMu, grainPerMu, annualGrainShi: annual },
    revenue: { annualTaxShi, annualUpkeepShi, taxRate, retainedRatio, retainedShi: Math.round(annualTaxShi * retainedRatio), upwardShi: annualTaxShi - Math.round(annualTaxShi * retainedRatio) },
    agriculture: { phase: '冬藏', busy: false, grainStoredShi: Math.round(annual * 0.35), lossRate: 0.08, disaster: '无' },
    treasury: { cashGuan, grainShi, taxRate, debtGuan: 0 },
    military: { total: troops, combat: 0, aux: 0, wounded: 0, sick: 0, desertion: 0, morale: 0.6, horses: 0, weapons: 0, arrows: 0 },
    market: { grainWenPerShi: grainBaselineByEra(year).value, grainBaseline: grainBaselineByEra(year).value, horseGuan: 30, oxGuan: 8, clothWenPerBolt: 500, laborWenPerDay: 30, grainSource: 'estimate', grainNote: '米价为引擎按朝代量级推算的中值，非史实定值；启用检索后可据史核定覆盖。' },
    ledgers: { personnel: [], finance: [], military: [], relation: [] },
    // 基准值：真正的守恒只对「有账可查的变动」负责 —— 期末 = 基准 + Σ账目增减
    baseline: { grainShi, cashGuan, troops, pop },
    alarms: [],
  };
  const m = state.economy.military;
  m.combat = Math.round(m.total * 0.7);
  m.aux = m.total - m.combat;
  m.horses = Math.round(m.total * 0.06);
  state.economy.baseline.troops = m.total;
  // 史料压过公式：人物档案里若有**带出处**的数字，一律以它为准。
  // 否则会出现「《资治通鉴》说萧纪有马八千匹，账本却写 72 匹」这种差上百倍的笑话。
  applyHistoricalFigures(state, state.economy);
  return state.economy;
}

/**
 * 以人物档案里的史料数字覆盖估算值。
 * 只认**带出处**的条目（resources.note / situation.text），且只覆盖能明确解析的字段；
 * 解析不出就保留估算，绝不猜。覆盖结果写进 economy.historicalOverrides，供审计追溯。
 */
function applyHistoricalFigures(state, e) {
  const name = (state.protagonist && state.protagonist.name) || '';
  const year = Number(state.clock && state.clock.gregorianYear) || 0;
  if (!name || !year) return e;
  let d = null;
  try { d = require('./figure-data').dossierAt(name, year); } catch { return e; }
  if (!d) return e;

  const text = [String((d.resources && d.resources.note) || ''), String((d.situation && d.situation.text) || '')].join('；');
  if (!text) return e;
  const src = (d.resources && d.resources.src) || (d.situation && d.situation.src) || '人物档案';
  const conf = (d.resources && d.resources.conf) || (d.situation && d.situation.conf) || 'medium';

  // 幂等：同一字段只留一条记录，重复调用不堆积（eco() 每回合都会走这里）
  e.historicalOverrides = (e.historicalOverrides || []).filter(o => o.field !== "__none__");
  const put = (field, value, note) => {
    if (!Number.isFinite(value) || value <= 0) return;
    const before = field === 'horses' ? e.military.horses : e.military.total;
    if (field === 'horses') e.military.horses = value;
    const rec = { field, value, before, src, conf, quote: note };
    const idx = (e.historicalOverrides || []).findIndex(o => o.field === field);
    // 已有记录时保留**首次**的 before——那是被公式盖掉的原值，正是要追溯的东西
    if (idx >= 0) e.historicalOverrides[idx] = { ...rec, before: e.historicalOverrides[idx].before };
    else e.historicalOverrides.push(rec);
    // 战马也要有对应的乘骑/甲具，按常理给一个不致失真的配比，但仍标为估算
    if (field === 'horses' && e.military.total > 0) {
      e.military.cavalry = Math.min(e.military.total, Math.round(value * 0.7));
    }
  };

  // 「有马八千匹」/「马八千匹」→ horses
  const h = text.match(/(?:有)?马\s*([0-9一二三四五六七八九十千百千万]+)\s*匹/);
  if (h) put('horses', cnNum(h[1]), h[0]);

  // 其他常见史料数字：户 / 口 / 粮，按需扩展（解析不出就不覆盖，绝不猜）
  return e;
}

/** 中文数字转阿拉伯数字（支持 千百十 与 「万」） */
function cnNum(s) {
  const map = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const t = String(s || '').trim();
  if (/^[0-9]+$/.test(t)) return Number(t);
  // 八千 → 8000； 三万 → 30000； 一万二千 → 12000
  let n = 0, cur = 0, lastUnit = 0, total = 0;
  for (const ch of t) {
    if (map[ch] != null) { cur = map[ch]; }
    else if (ch === '十') { n += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { n += (cur || 1) * 100; cur = 0; }
    else if (ch === '千') { n += (cur || 1) * 1000; cur = 0; }
    else if (ch === '万') { total += (n + cur) * 10000; n = 0; cur = 0; }
  }
  return total + n + cur;
}

/** 唯一的库存变动入口：先入账再改数，账面被截断（不够减）的部分也单独记账，保证 期末=基准+Σ增减 恒成立。 */
function move(state, field, item, unit, delta, reason, book = 'finance') {
  const e = eco(state);
  const before = e.treasury[field];
  let after = before + delta;
  let shortfall = 0;
  if (after < 0) { shortfall = after; after = 0; }        // 账面不足，实为欠发
  e.treasury[field] = after;
  if (after !== before) post(state, book, { item, delta: after - before, unit, reason, by: '' });
  if (shortfall) post(state, book, { item: item + '（欠发）', delta: shortfall, unit, reason: `${reason}；账面不足 ${-shortfall}${unit}，实为欠发`, by: '' });
  return { before, after, shortfall };
}

function eco(state) {
  // 旧档已有 economy（旧结构、无 revenue 字段）时也必须重建，
  // 否则 tickEconomy 会读到 undefined 直接崩。版本不符一律按新算法重建。
  if (!state.economy || state.economy.version !== ECON_VERSION) initEconomy(state, { force: true });
  // 旧档：出镇都督被按「封国·食邑」估了盘子（萧纪只剩 1200 兵），且尚未开始推进的，按新口径重建一次
  else if (/^封国/.test(String(state.economy.scale || '')) && (state.turn || 0) === 0
    && /都督.{0,12}诸军事/.test(String((state.protagonist && state.protagonist.role) || ''))) initEconomy(state, { force: true });
  // 史料覆盖每次都要走：老档是在这条规则之前建的，马匹之类可能仍是公式值。
  // 这一句是真正的入口（initEconomy 里的调用只在重建时才会跑到），缺了它覆盖就形同虚设。
  applyHistoricalFigures(state, state.economy);
  return state.economy;
}

/* ============================ 记账 ============================
   四本账（规范第九章）：人员账 / 财政账 / 军事账 / 关系账。
   规矩：**没有 reason（来源）的条目不许入账**，只能挂到待查里报警。 */
const BOOK_LABEL = { personnel: '人员账', finance: '财政账', military: '军事账', relation: '关系账' };

function post(state, book, entry) {
  const e = eco(state);
  if (!e.ledgers[book]) return { ok: false, why: `没有这本账：${book}` };
  const rec = {
    id: `${book}${e.ledgers[book].length + 1}`,
    turn: state.turn || 0,
    // yearLabel 本身已带「年」（如「太清二年」），去掉尾缀避免写成「太清二年年」
    at: `${String((state.clock && state.clock.yearLabel) || '?').replace(/年+$/, '')}年${(state.clock && state.clock.month) || '?'}月`,
    item: entry.item || '',
    delta: Number(entry.delta) || 0,
    unit: entry.unit || '',
    reason: String(entry.reason || '').trim(),
    by: entry.by || '',
  };
  if (!rec.reason) {
    e.alarms.push({ code: 'NU-02', turn: state.turn || 0, text: `${BOOK_LABEL[book]}：${rec.item} ${rec.delta > 0 ? '+' : ''}${rec.delta}${rec.unit} 没有写明来源` });
    rec.suspect = true;
  }
  e.ledgers[book].push(rec);
  return { ok: true, entry: rec };
}

/* ============================ 守恒校验 ============================
   两层：①逐笔要有来源（NU-02）②**账实相符**（NU-05）——期末必须等于
   「基准值 + Σ账目增减」，否则就是有地方绕过记账直接改了库存。
   过去这里只查有没有写 reason，所以永远显示「守恒」——那是假的。 */
function sumBy(list, item, unit) {
  let s = 0;
  for (const r of list || []) if (r.item === item && r.unit === unit) s += (Number(r.delta) || 0);
  return s;
}

function conservation(state) {
  const e = eco(state);
  const out = [];

  // 老档兼容：原先没有基准值，先据现存数与已记账目对一次，此后的变动即严格可查
  if (!e.baseline) {
    e.baseline = {
      grainShi: e.treasury.grainShi - sumBy(e.ledgers.finance, '存粮', '石'),
      cashGuan: e.treasury.cashGuan - sumBy(e.ledgers.finance, '现钱', '贯'),
      troops: e.military.total, pop: e.population.total,
    };
  }

  for (const [book, list] of Object.entries(e.ledgers)) {
    const byItem = new Map();
    for (const r of list) {
      const key = r.item + '|' + r.unit;
      const cur = byItem.get(key) || { item: r.item, unit: r.unit, net: 0, noSource: 0, entries: 0 };
      cur.net += r.delta; cur.entries++;
      if (!r.reason || r.suspect) cur.noSource++;
      byItem.set(key, cur);
    }
    for (const v of byItem.values()) {
      if (v.noSource > 0) {
        out.push({ code: 'NU-02', book: BOOK_LABEL[book], item: v.item, net: v.net, unit: v.unit, why: `${v.noSource}/${v.entries} 笔没有来源` });
      }
    }
  }

  // —— 账实相符（真正的守恒）——
  const expGrain = (e.baseline.grainShi || 0) + sumBy(e.ledgers.finance, '存粮', '石');
  if (Math.abs(expGrain - e.treasury.grainShi) > 1) {
    out.push({ code: 'NU-05', book: '财政账', item: '存粮', net: e.treasury.grainShi, unit: '石',
      why: `账实不符：按账应为 ${Math.round(expGrain)} 石，实际 ${Math.round(e.treasury.grainShi)} 石（差 ${Math.round(e.treasury.grainShi - expGrain)}），有地方绕过记账改了库存` });
  }
  const expCash = (e.baseline.cashGuan || 0) + sumBy(e.ledgers.finance, '现钱', '贯');
  if (Math.abs(expCash - e.treasury.cashGuan) > 1) {
    out.push({ code: 'NU-05', book: '财政账', item: '现钱', net: e.treasury.cashGuan, unit: '贯',
      why: `账实不符：按账应为 ${Math.round(expCash)} 贯，实际 ${Math.round(e.treasury.cashGuan)} 贯（差 ${Math.round(e.treasury.cashGuan - expCash)}）` });
  }

  // —— 负值与兵力结构 ——
  if (e.treasury.grainShi < 0) out.push({ code: 'NU-04', book: '财政账', item: '存粮', net: e.treasury.grainShi, unit: '石', why: '存粮为负，账不平' });
  if (e.treasury.cashGuan < 0) out.push({ code: 'NU-04', book: '财政账', item: '现钱', net: e.treasury.cashGuan, unit: '贯', why: '现钱为负，账不平' });
  if (e.military.total < 0) out.push({ code: 'NU-03', book: '军事账', item: '兵力', net: e.military.total, unit: '人', why: '兵力为负' });
  if (e.military.combat + e.military.aux > e.military.total + 1) out.push({ code: 'NU-03', book: '军事账', item: '战兵+辅兵', net: e.military.combat + e.military.aux, unit: '人', why: '超过总兵力' });

  // —— 量级是否合乎常情（过去完全没查，所以一边胡乱涨一边报「守恒」）——
  const p = e.population, rev = e.revenue || {};
  const adult = p.丁男 || 0;
  if (e.military.total > Math.round(adult * 0.25) + 1) {
    out.push({ code: 'NU-03', book: '军事账', item: '兵额', net: e.military.total, unit: '人',
      why: `兵 ${e.military.total} 超出本地丁男（约 ${adult}）可征发的常理上限约 ${Math.round(adult * 0.25)} 人` });
  }
  if (p.total) {
    const perCapita = p.annualGrainShi / p.total;
    if (perCapita < 2) out.push({ code: 'NU-01', book: '经济账', item: '人均产粮', net: Math.round(perCapita * 10) / 10, unit: '石/口',
      why: `人均仅 ${perCapita.toFixed(1)} 石，养不活本境人口——产出或户口必有一处失真` });
    if (perCapita > 25) out.push({ code: 'NU-01', book: '经济账', item: '人均产粮', net: Math.round(perCapita * 10) / 10, unit: '石/口',
      why: `人均 ${perCapita.toFixed(1)} 石远超常理，产出虚夸` });
  }
  const localInflow = rev.retainedShi || rev.annualTaxShi || 0;
  if (localInflow) {
    const years = e.treasury.grainShi / localInflow;   // 以「本州实收留存」为基准，非全额赋额
    if (years > 3) out.push({ code: 'NU-01', book: '财政账', item: '官仓储积', net: e.treasury.grainShi, unit: '石',
      why: `存粮折合 ${years.toFixed(1)} 年本州留存（${Math.round(localInflow)} 石/年）——官仓通常只存一年上下，多则三年，再高就是凭空涨出来的` });
    if (p.annualGrainShi && rev.annualTaxShi > p.annualGrainShi * 0.3) {
      out.push({ code: 'NU-01', book: '财政账', item: '赋入占产出', net: Math.round(rev.annualTaxShi / p.annualGrainShi * 100), unit: '%',
        why: '赋入占全境产出逾三成，过重失真' });
    }
  }
  return out;
}

/* ============================ 量级 / 规模校验 ============================
   规范第八十八章：一个小村突然提供 5000 兵 —— 必须报警。 */
function checkScale(state, claim = {}) {
  const e = eco(state);
  const p = e.population;
  const out = [];
  const adult = p.丁男 || 0;
  if (claim.troops != null) {
    const cap = Math.round(adult * 0.25);          // 丁男四抽一已是极限
    if (claim.troops > cap) out.push({ code: 'NU-03', text: `宣称 ${claim.troops} 兵，此地男丁约 ${adult}，常规上限约 ${cap} 人`, why: '超出可征发男丁' });
  }
  if (claim.labor != null) {
    const cap = Math.round(adult * 0.15);
    if (claim.labor > cap) out.push({ code: 'NU-01', text: `征发 ${claim.labor} 民夫，超出本地可征劳力约 ${cap} 人`, why: '超出劳力上限' });
  }
  if (claim.grainShi != null) {
    const cap = p.annualGrainShi || 0;
    if (claim.grainShi > cap) out.push({ code: 'NU-01', text: `宣称粮 ${claim.grainShi} 石，本地岁入约 ${cap} 石`, why: '超出年产量' });
  }
  if (claim.cashGuan != null) {
    const cap = Math.round((p.households || 0) * 2);
    if (claim.cashGuan > cap) out.push({ code: 'NU-04', text: `宣称钱 ${claim.cashGuan} 贯，本地约 ${cap} 户，量级不符`, why: '超出地方财力' });
  }
  if (claim.people != null && claim.people > p.total) out.push({ code: 'NU-01', text: `宣称 ${claim.people} 人，本地总人口约 ${p.total}`, why: '超出总人口' });
  return out;
}

/* ============================ 农业季节 ============================
   规范第十一、六十章：农忙时征发民夫必须产生农业损失，不得免费获得劳力。 */
const FARM_PHASE = [
  [1, '冬闲', false], [2, '备耕', false], [3, '播种', true], [4, '生长', false],
  [5, '除草', true], [6, '除草', true], [7, '田间', false], [8, '收获准备', true],
  [9, '收获', true], [10, '储藏', true], [11, '冬藏', false], [12, '冬闲', false],
];
function farmPhase(month) {
  const m = ((Number(month) || 1) - 1) % 12;
  return { 月: m + 1, phase: FARM_PHASE[m][1], busy: FARM_PHASE[m][2] };
}

function levyLabor(state, n, month) {
  const e = eco(state);
  const ph = farmPhase(month);
  const labor = Math.max(0, Number(n) || 0);
  // 农忙强征：每亩受影响产量 → 折粮损失；并推高民怨
  const muAffected = labor * 12;                     // 一个劳力约管 12 亩
  const lossPerMu = e.population.grainPerMu * (ph.busy ? 0.45 : 0.12);
  const lossShi = Math.round(muAffected * lossPerMu);
  post(state, 'personnel', { item: '征发民夫', delta: labor, unit: '人', reason: '官府征发', by: '' });
  const r = move(state, 'grainShi', '存粮', '石', -lossShi, `农忙征发 ${labor} 人造成的农业损失${ph.busy ? '（正值农忙）' : ''}`);
  return { labor, phase: ph.phase, busy: ph.busy, farmLossShi: lossShi, shortfallShi: -r.shortfall, note: ph.busy ? '正在农忙，强征劳力会直接减产并招怨' : '非农忙，损失较小' };
}

/* ============================ 按日推进（经济侧） ============================ */
function tickEconomy(state, days) {
  const e = eco(state);
  const c = state.clock || {};
  const changes = [];
  const pop = e.population;
  // 人口微增（年增约 0.5%）
  const grow = Math.round(pop.total * 0.005 * (days / 360));
  if (grow) { pop.total += grow; changes.push(`人口 +${grow}`); }
  // 农事推进
  const ph = farmPhase(c.month);
  e.agriculture.phase = ph.phase;
  e.agriculture.busy = ph.busy;
  const disasterNow = e.agriculture.disaster && e.agriculture.disaster !== '无';

  // 收获：那是**百姓田里的收成**，归属农家，不进官仓。
  // （旧实现在这里给了官仓 0.5×全州总产，等于官府凭空拿走半数民食 —— 已废。）
  if (ph.phase === '收获') {
    changes.push(disasterNow ? `百姓秋收，因${e.agriculture.disaster}减产` : '百姓秋收，官不定额之外的收成归民');
  }

  // 官仓日常支出：按实际兵数与廪给折算（一兵月食约 2 石，全年约 24 石）
  if (pop.total) {
    const upkeep = Math.max(0, Math.round((e.revenue.annualUpkeepShi || 0) * (days / 360)));
    if (upkeep) {
      const r = move(state, 'grainShi', '存粮', '石', -upkeep, `兵粮与官吏廪给、赈济杂支（${days} 日）`);
      const spent = r.before - r.after;
      changes.push(`官仓支用 -${spent} 石${r.shortfall ? `（账面不足，欠发 ${-r.shortfall} 石）` : ''}`);
    }
  }
  // 粮价随季节（收获低、青黄不接高）。基准按朝代量级取，不再是写死的 300 常数
  const base = (e.market && e.market.grainBaseline) || grainBaselineByEra(state.clock && state.clock.gregorianYear).value;
  const seasonal = [1.08, 1.12, 1.18, 1.22, 1.25, 1.2, 1.1, 1.0, 0.88, 0.85, 0.9, 1.0][((c.month || 1) - 1) % 12];
  const old = e.market.grainWenPerShi;
  e.market.grainWenPerShi = Math.round(base * seasonal * (e.agriculture.disaster !== '无' ? 1.6 : 1));
  if (Math.abs(old - e.market.grainWenPerShi) >= 10) changes.push(`粮价 ${old} → ${e.market.grainWenPerShi} 文/石`);
  // 秋税：官仓岁入的**唯一正项来源**，一年只入一次；有灾按成数减征
  if (ph.phase === '储藏' && String(e.__taxedYear || '') !== String(c.gregorianYear)) {
    const full = Math.round(pop.annualGrainShi * (e.revenue && e.revenue.taxRate != null ? e.revenue.taxRate : (e.treasury.taxRate || 0.1)));
    const relief = disasterNow ? 0.5 : 1;
    const tax = Math.round(full * relief);
    const kept = Math.round(tax * (e.revenue && e.revenue.retainedRatio != null ? e.revenue.retainedRatio : 0.4));
    const upward = tax - kept;
    move(state, 'grainShi', '存粮', '石', kept, relief < 1 ? `秋税岁入·本州留存（因${e.agriculture.disaster}减征）` : '秋税岁入·本州留存');
    if (upward) post(state, 'finance', { item: '上供起运', delta: upward, unit: '石', reason: '起运朝廷/转运司，不入本州仓廪', by: '' });
    e.__taxedYear = String(c.gregorianYear);
    changes.push(`秋税 ${tax} 石：留存 ${kept} 石入仓，上供起运 ${upward} 石`);
  }
  return changes;
}

/* ============================ 提示词用的经济摘要 ============================ */
function renderEconomy(state) {
  const e = eco(state);
  const p = e.population;
  const m = e.military;
  const cls = Object.entries(p.byClass).filter(([, v]) => v > 0).map(([k, v]) => `${k}${v}`).join('，');
  const rev = e.revenue || {};
  const lines = [
    `规模：${e.scale}｜户 ${p.households}，口 ${p.total}（丁男 ${p.丁男}／丁女 ${p.丁女}／儿童 ${p.儿童}／老者 ${p.老者}）`,
    // 关键区分：全境产出是百姓的，官府只能拿到税赋那一份
    `全境民田：${p.farmlandMu} 亩，亩产约 ${p.grainPerMu} 石，年产约 ${p.annualGrainShi} 石（属编户百姓，非官府所有）`,
    `官府赋额：${rev.annualTaxShi || 0} 石/年，其中上供起运 ${rev.upwardShi || 0} 石，本州实收留存 ${rev.retainedShi || 0} 石`,
    `岁出：兵粮廪给约 ${rev.annualUpkeepShi || 0} 石/年；年结余约 ${(rev.retainedShi || 0) - (rev.annualUpkeepShi || 0)} 石`,
    `生计构成：${cls}`,
    `官仓：粮 ${e.treasury.grainShi} 石，钱 ${e.treasury.cashGuan} 贯，税率 ${Math.round((rev.taxRate ?? e.treasury.taxRate ?? 0.1) * 100)}%`,
    `兵：总 ${m.total}（战兵 ${m.combat}／辅兵 ${m.aux}），马 ${m.horses}，士气 ${(m.morale * 100).toFixed(0)}%`,
    `农事：${e.agriculture.phase}${e.agriculture.busy ? '（农忙）' : ''}｜粮价 ${e.market.grainWenPerShi} 文/石｜灾情 ${e.agriculture.disaster}`,
    `可征发丁男上限约 ${Math.round(p.丁男 * 0.25)} 兵 / ${Math.round(p.丁男 * 0.15)} 夫（超出即不合理）`,
  ];
  if (e.estimate) lines.push(`【估算说明】${e.estimate.basis}。${e.estimate.note}`);
  const al = (e.alarms || []).slice(-3);
  if (al.length) lines.push('账目报警：' + al.map(a => `${a.code} ${a.text}`).join('；'));
  return lines.join('\n');
}

module.exports = { initEconomy, eco, post, move, conservation, checkScale, farmPhase, levyLabor, tickEconomy, renderEconomy, BOOK_LABEL, scaleOf, ECON_VERSION };
