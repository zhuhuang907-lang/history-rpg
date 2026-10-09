'use strict';
/**
 * 数字区间表：正文里出现的户口 / 兵数 / 钱粮 / 里程等数字，与该时代该地的合理量级比对。
 *
 * 为什么需要：用户反复批评「数字要么太大要么太小」。历史上的量级是有硬边界的
 * （后赵 319 年立国才 29 万户，一个郡不可能十六万户、五万兵），
 * 这类错误机械可查 —— 先算再写，超出区间就标红。
 *
 * 区间来源：以各代正史地理志 / 会要的常见量级为准，取**保守的宽区间**，
 * 宁可宽一点也别误报（误报多了用户就不看了）。查不到的时代用通用区间。
 */

/* 通用量级：按行政级别给「合理上限」，超过即可疑 */
const TIERS = [
  { key: 'empire', name: '全国', unit: '户', min: 100000, max: 24000000 },   // 汉至清全国户数
  { key: 'province', name: '州/路/省', unit: '户', min: 8000, max: 2000000 },
  { key: 'commandery', name: '郡/府', unit: '户', min: 1000, max: 500000 },  // 一郡
  { key: 'county', name: '县', unit: '户', min: 100, max: 60000 },           // 一县
];

/* 兵数：按级别给上限 */
const TROOPS = [
  { key: 'empire', name: '全国兵马', min: 10000, max: 1000000 },
  { key: 'province', name: '一州/一路', min: 1000, max: 200000 },
  { key: 'commandery', name: '一郡', min: 300, max: 40000 },
  { key: 'county', name: '一县', min: 20, max: 6000 },
  { key: 'fort', name: '坞堡/一城', min: 10, max: 8000 },
];

/* 粮：以"斛/石"计，一次提到的存量上限 */
const GRAIN = { max: 5000000, note: '单个仓廪一次提到百万石以上极罕见' };

/* 里程：两地距离的合理范围（里） */
const DISTANCE = { max: 8000, note: '单次行程超过八千里已属极远（如长安至西域）' };

/* 时代修正：把不同朝代的量级差异收一收（早期人口远少于明清） */
const ERA_SCALE = [
  { re: /秦|汉|三国|晋|南北|隋|唐|五代/, scale: 0.55 },   // 汉唐峰值约五六千万口，户数远少于宋明
  { re: /宋|辽|金|元/, scale: 0.85 },
  { re: /明|清/, scale: 1.0 },
];

const num = s => Number(String(s).replace(/[，,]/g, ''));

/** 中文数字 → 阿拉伯。支持：一~九十九、X万/X千/X百/X亿（如「十六万」「八十万」「三千」）。 */
function cn2num(s) {
  const D = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0 };
  const MUL = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
  const t = String(s).trim();
  if (!t || !/^[一二两三四五六七八九十百千万亿零]+$/.test(t)) return null;

  // 小于百的部分（一~九十九）
  const under100 = x => {
    if (!x) return 0;
    if (/^[一二两三四五六七八九]$/.test(x)) return D[x];
    let m = x.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
    if (m) return (m[1] ? D[m[1]] : 1) * 10 + (m[2] ? D[m[2]] : 0);
    m = x.match(/^([一二两三四五六七八九])([百千])$/);
    if (m) return D[m[1]] * MUL[m[2]];
    return null;
  };

  // 整体：<倍数><万|亿> 或 直接小于百
  let m = t.match(/^(.+?)([万亿])(.*)$/);
  if (m) {
    const big = MUL[m[2]];
    const head = under100(m[1]);
    if (head == null) return null;
    let rest = 0;
    if (m[3]) { const r = under100(m[3].replace(/^零+/, '')); if (r == null) return null; rest = r; }
    return head * big + rest;
  }
  return under100(t);
}

function eraScale(state) {
  const s = `${(state.clock && state.clock.yearLabel) || ''} ${(state.clock && state.clock.gregorianYear) || ''}`;
  for (const e of ERA_SCALE) if (e.re.test(s)) return e.scale;
  return 0.7;
}

/**
 * 扫描正文里的数字，与量级区间比对。
 * 返回 [{ text, value, kind, level, why }]
 */
function checkNumbers(scene, state) {
  const t = String(scene || '');
  if (!t) return [];
  const scale = eraScale(state);
  const hits = [];

  // 数字 + 单位 的配对扫描
  const re = /([0-9][0-9，,]*|[一二两三四五六七八九十百千万亿]{1,6})\s*(余|多|来)?\s*(户|户人家|斛|石|万石|骑|人马|人|兵|军|丁|口|里|贯|两|钱|匹|顷|亩|座|处)/g;
  let m;
  while ((m = re.exec(t))) {
    const raw = m[1];
    const unit = m[3];
    let v = /^[0-9]/.test(raw) ? num(raw) : cn2num(raw);
    if (v == null || !isFinite(v)) continue;
    // "万石"这类单位自带倍率
    if (unit === '万石' && v < 10000) v *= 10000;

    const ctx = t.slice(Math.max(0, m.index - 14), m.index + m[0].length + 6);

    // —— 户 ——
    if (unit.startsWith('户')) {
      const who = /国|天下|四海|举国/.test(ctx) ? 'empire'
        : /郡|府|州|路|省/.test(ctx) ? 'commandery'
          : /县/.test(ctx) ? 'county' : 'county';
      const tier = TIERS.find(x => x.key === who);
      const cap = tier.max * scale, floor = tier.min * scale * 0.5;
      if (v > cap) hits.push({ text: m[0].trim(), value: v, kind: '户数', level: tier.name, why: `一${tier.name.replace(/[全国]/g, '')}户数 ${v} 超过合理上限约 ${Math.round(cap)}（按本局时代已折算）` });
      else if (v < floor && v > 0) hits.push({ text: m[0].trim(), value: v, kind: '户数', level: tier.name, why: `${v} 户偏少得离谱（一${tier.name.replace(/[全国]/g, '')}通常不止此数），请核对是否漏了量级` });
    }
    // —— 兵 ——
    else if (/骑|兵|军|丁|人马|人$/.test(unit)) {
      const who = /天下|举国|全国|倾国/.test(ctx) ? 'empire'
        : /州|路|省|郡|府/.test(ctx) ? 'commandery'
          : /坞|堡|城|寨|关/.test(ctx) ? 'fort' : 'county';
      const tier = TROOPS.find(x => x.key === who);
      const cap = tier.max * scale;
      if (v > cap) hits.push({ text: m[0].trim(), value: v, kind: '兵数', level: tier.name, why: `${tier.name}兵力 ${v} 超过合理上限约 ${Math.round(cap)}（按本局时代已折算）` });
    }
    // —— 粮 ——
    else if (/斛|石/.test(unit)) {
      if (v > GRAIN.max * scale) hits.push({ text: m[0].trim(), value: v, kind: '粮储', level: '仓廪', why: `单处粮储 ${v} 石超过常规上限（${GRAIN.note}）` });
    }
    // —— 里程 ——
    else if (unit === '里') {
      if (v > DISTANCE.max) hits.push({ text: m[0].trim(), value: v, kind: '里程', level: '行程', why: `${v} 里已远超常理（${DISTANCE.note}）` });
    }
    // —— 钱 ——
    else if (/贯|两/.test(unit)) {
      if (v > 5000000) hits.push({ text: m[0].trim(), value: v, kind: '钱', level: '款项', why: `${v} ${unit} 的数额极大，请核对是否与实际财政量级相符` });
    }
  }
  return hits;
}

/** 给 GM 的「先算再写」提醒（含本局时代的折算后区间） */
function renderNumericGuide(state) {
  const scale = eraScale(state);
  const f = n => Math.round(n * scale).toLocaleString('en-US');
  return [
    '=== 数字量级（动笔前先算，超出即算错） ===',
    `本局时代的参考上限（已按时代折算，x${scale}）：一县户数 ≤ ${f(60000)}；一郡户数 ≤ ${f(500000)}；全国户数 ≤ ${f(24000000)}；`,
    `一县兵 ≤ ${f(6000)}；一郡兵 ≤ ${f(40000)}；一州兵 ≤ ${f(200000)}；一坞堡 ≤ ${f(8000)}；单处粮储 ≤ ${f(5000000)} 石。`,
    '写具体数目之前，先想清楚：这是哪一级（县/郡/州/国）？该级通常多少？再落笔。数字一旦被玩家订正，**旧数字全部作废，此后不得再用**。',
  ].join('\n');
}

module.exports = { checkNumbers, renderNumericGuide, eraScale, TIERS, TROOPS };
