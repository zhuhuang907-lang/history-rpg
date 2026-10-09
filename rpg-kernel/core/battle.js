'use strict';
/**
 * 战阵系统：让玩家在本方作战前**自己布阵、自己定战术**，引擎给出可推演的胜负与伤亡，
 * 再由 GM 按此写成战况叙事。
 *
 * 三块：
 *  1) FORMATIONS —— 中国古代常见阵形（鱼鳞/鹤翼/雁行/方圆/偃月/锥行/箕形/长蛇/背水），各有克制与适用地形
 *  2) TACTICS    —— 战术（佯败诱敌/火攻/夜袭/断粮/伏兵/半渡而击/坚壁不出/声东击西/背城借一），各有前置与风险
 *  3) resolveBattle —— 结合兵力、士气、训练、地形、天候、阵形克制、战术相性，算出胜负与伤亡
 *
 * 诚实说明：这是一个**模型**，不是真实战史推演；结果供叙事用，引擎不宣称它「史实精确」。
 */

/* 阵形：每个都有 强项（克制哪些阵）、弱项（被哪些阵克）、地形偏好、士气/机动修正 */
const FORMATIONS = [
  { id: 'yulin', name: '鱼鳞阵', desc: '层层叠进、正面强攻，利于中央突破。',
    strong: ['fangyuan', 'yanyue'], weak: ['heyi', 'jixing'], terrain: ['平原'], atk: 1.15, def: 0.95, mob: -0.05 },
  { id: 'heyi', name: '鹤翼阵', desc: '两翼张开如鹤，利于包抄夹击。',
    strong: ['yulin', 'zhuixing'], weak: ['fangyuan', 'changshe'], terrain: ['平原'], atk: 1.05, def: 1.0, mob: 0.05 },
  { id: 'yanxing', name: '雁行阵', desc: '疏散如雁，利于弓弩齐射、避免密集伤亡。',
    strong: ['zhuixing'], weak: ['heyi'], terrain: ['平原', '丘陵'], atk: 1.0, def: 1.1, mob: 0.0, ranged: true },
  { id: 'fangyuan', name: '方圆阵', desc: '外围圆阵、中护辎重，最宜坚守待援。',
    strong: ['heyi', 'changshe'], weak: ['yulin'], terrain: ['平原', '丘陵', '山地'], atk: 0.8, def: 1.3, mob: -0.15 },
  { id: 'yanyue', name: '偃月阵', desc: '弯月包卷，利于侧击与合围。',
    strong: ['changshe'], weak: ['yulin'], terrain: ['平原'], atk: 1.1, def: 1.0, mob: 0.0 },
  { id: 'zhuixing', name: '锥行阵', desc: '尖锥直插，利于突破薄弱处。',
    strong: ['changshe'], weak: ['heyi', 'yanxing'], terrain: ['平原'], atk: 1.2, def: 0.85, mob: 0.1 },
  { id: 'jixing', name: '箕形阵', desc: '中凹两高，诱敌深入而后两翼合拢。',
    strong: ['yulin'], weak: ['fangyuan'], terrain: ['丘陵', '山地'], atk: 1.0, def: 1.15, mob: -0.05 },
  { id: 'changshe', name: '长蛇阵', desc: '一线展开，利于窄道行进与追袭。',
    strong: ['changshe'], weak: ['heyi', 'yanyue', 'zhuixing'], terrain: ['山地', '水乡'], atk: 0.95, def: 0.95, mob: 0.1 },
  { id: 'beishui', name: '背水阵', desc: '背水结阵、无路可退，士气死战。',
    strong: ['yulin', 'zhuixing'], weak: [], terrain: ['水乡'], atk: 1.1, def: 0.9, mob: -0.1, moraleBias: 0.25 },
];

/* 战术：cost=风险（越大越可能反噬）、need=前置条件描述 */
const TACTICS = [
  { id: 'hold', name: '坚壁不出', desc: '据险固守，待敌自疲。', atk: 0.7, def: 1.35, cost: 0.05, need: '有城寨或险要可依' },
  { id: 'feint', name: '佯败诱敌', desc: '诈败后退，诱其入伏。', atk: 1.1, def: 0.9, cost: 0.35, need: '有可设伏之地，且军纪能约束退而不乱' },
  { id: 'fire', name: '火攻', desc: '乘风纵火，焚其营寨。', atk: 1.4, def: 0.9, cost: 0.4, need: '顺风、干燥或敌营草木相连' },
  { id: 'night', name: '夜袭', desc: '乘夜劫营，乱其阵脚。', atk: 1.3, def: 0.95, cost: 0.4, need: '熟悉路径、口令严密，否则自乱' },
  { id: 'cutoff', name: '断其粮道', desc: '袭其辎重，绝其馈饷。', atk: 1.0, def: 1.05, cost: 0.25, need: '有可用的轻骑或熟悉地形的小队' },
  { id: 'ambush', name: '伏兵', desc: '预设伏击，半途而出。', atk: 1.35, def: 0.95, cost: 0.3, need: '地形可伏（山林、隘口、苇泽）' },
  { id: 'halfcross', name: '半渡而击', desc: '待其半渡，击之于水。', atk: 1.45, def: 0.9, cost: 0.3, need: '临河，且能判准渡口与时机' },
  { id: 'flank', name: '声东击西', desc: '佯攻一方，实击其虚。', atk: 1.25, def: 0.95, cost: 0.35, need: '有可分兵之众与可信的佯动' },
  { id: 'lastStand', name: '背城借一', desc: '置之死地而后生。', atk: 1.3, def: 1.0, cost: 0.5, need: '已无退路，且将士愿意死战' },
  { id: 'none', name: '正兵相接', desc: '不设奇计，以正兵决胜。', atk: 1.0, def: 1.0, cost: 0.1, need: '无' },
];

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296; }; }
const byId = (arr, id) => arr.find(x => x.id === id) || arr[arr.length - 1];

/** 水土与季节：北人夏季南征多疾疫（赤壁之役），南人冬季北上不耐严寒。
 *  需 ctx.month（农历月）、ctx.lat（战场纬度）与 side.origin（'north'|'south'）；缺则不计。 */
function climateFactor(side, ctx) {
  const m = Number(ctx.month), lat = Number(ctx.lat);
  if (!m || !lat || !side.origin) return 1;
  if ([5, 6, 7, 8].includes(m) && lat < 31.5 && side.origin === 'north') return 0.85;
  if ([11, 12, 1].includes(m) && lat > 35 && side.origin === 'south') return 0.85;
  return 1;
}

function terrainBonus(f, terrain) {
  if (!f.terrain || !terrain) return 1;
  return f.terrain.includes(terrain) ? 1.08 : 0.94;
}

/**
 * 推演一战。
 * sideA = { troops, morale(0-1), training(0-1), formationId, tacticId, name }
 */
function resolveBattle(sideA, sideB, ctx = {}) {
  const fA = byId(FORMATIONS, sideA.formationId), fB = byId(FORMATIONS, sideB.formationId);
  const tA = byId(TACTICS, sideA.tacticId), tB = byId(TACTICS, sideB.tacticId);
  const terrain = ctx.terrain || '平原';
  const weather = ctx.weather || '';
  const seed = ctx.seed || `${sideA.name}|${sideB.name}|${ctx.turn || 0}|${sideA.troops}|${sideB.troops}`;
  const r = rng(hash(seed));

  // 阵形克制
  const counter = (f, other) => (f.strong.includes(other.id) ? 1.3 : f.weak.includes(other.id) ? 0.78 : 1);
  // 战术反制：伏兵克诱敌、坚壁熬夜袭与火攻等（简化相性）
  const tacticMatrix = { ambush: ['feint', 'flank'], hold: ['night', 'fire', 'feint'], feint: ['hold'], halfcross: ['feint'], cutoff: ['hold'] };
  const tacticBonus = (t, other) => ((tacticMatrix[t.id] || []).includes(other.id) ? 1.15 : 1);

  const side = (me, my, myT, meF, otherF, otherT, meName) => {
    let p = (me.troops || 0) / 1000;
    p *= 1 + (me.training ?? 0.5) * 0.5;
    p *= 1 + (me.morale ?? 0.6) * 0.6;
    p *= (my.atk + my.def) / 2;
    p *= terrainBonus(meF, terrain);
    p *= counter(meF, otherF);
    p *= tacticBonus(myT, otherT);
    if (myT.need && myT.need !== '无') p *= 0.97;      // 需要条件却未必具备
    if (myT.cost > 0) p *= 1 - ((1 - (me.training ?? 0.5)) * myT.cost * 0.5); // 战术越险，训练越差越易反噬
    if (weather === '暴雨' && (meF.mob || 0) > 0) p *= 0.96;
    if (weather === '大风' && myT.id === 'fire') p *= 1.15;
    // —— 以下为客观因素：主将、粮草、水土季节、渡河渡江、城防（均可缺省，缺省不加减）——
    if (me.generalSkill != null) p *= 0.8 + Math.max(0, Math.min(100, me.generalSkill)) / 250;
    if (me.supply != null) p *= 0.6 + 0.4 * Math.max(0, Math.min(1, me.supply));   // 缺粮则战力大减
    p *= climateFactor(me, ctx);
    if (me === sideA && ctx.crossing === 'ford') p *= 0.85;                          // 半渡可击
    if (me === sideA && ctx.crossing === 'jiang') p *= 0.5 + 0.5 * Math.max(0, Math.min(1, me.navy ?? 0.2));
    if (me === sideB && ctx.walls) p *= [1, 1.5, 2.2, 3.0][Math.max(0, Math.min(3, ctx.walls))];
    p *= 0.97 + r() * 0.06;                            // 战场偶然性（小幅）
    return p;
  };

  const pA = side(sideA, fA, tA, fA, fB, tB, sideA.name);
  const pB = side(sideB, fB, tB, fB, fA, tA, sideB.name);
  const total = pA + pB;
  const shareA = total ? pA / total : 0.5;

  // 胜负：兰彻斯特平方律的变体，战力优势会被放大，但弱方仍有翻盘之机——不是「兵多必胜」
  const winProbA = pA > 0 || pB > 0 ? pA ** 1.6 / (pA ** 1.6 + pB ** 1.6) : 0.5;
  const x = r();
  let result, winner;
  if (Math.abs(x - winProbA) < 0.05 && Math.abs(winProbA - 0.5) < 0.2) { result = '两军相持，胜负未分'; winner = 'draw'; }
  else if (x < winProbA) { result = `${sideA.name || '我军'}${winProbA < 0.4 ? '以少胜多' : '占上风'}`; winner = 'A'; }
  else { result = `${sideB.name || '敌军'}${winProbA > 0.6 ? '以少胜多' : '占上风'}`; winner = 'B'; }

  // 伤亡：败方浴血，胜方亦有失；战术越险、相持越久，伤亡越大
  const losser = winner === 'A' ? sideB : sideA;
  const winr = winner === 'A' ? sideA : sideB;
  // 伤亡：古代会战多死于溃退。实力越悬殊，败方折损越重、胜方越轻
  const pW = winner === 'A' ? pA : pB, pL = winner === 'A' ? pB : pA;
  const ratio = pL / Math.max(1e-9, pW);
  const lossRate = w => {
    if (winner === 'draw') return 0.1 + r() * 0.08;
    const isLoser = (w === losser);
    const base = isLoser ? Math.min(0.65, Math.max(0.18, 0.15 + 0.12 / Math.max(0.15, ratio))) : Math.min(0.3, Math.max(0.03, 0.03 + 0.12 * ratio));
    return base * (0.9 + r() * 0.2);
  };
  const casA = Math.round((sideA.troops || 0) * lossRate(sideA));
  const casB = Math.round((sideB.troops || 0) * lossRate(sideB));

  const why = [];
  if (counter(fA, fB) > 1) why.push(`${fA.name}克制${fB.name}`);
  if (counter(fB, fA) > 1) why.push(`${fB.name}克制${fA.name}`);
  if (tA.id !== 'none') why.push(`我军用${tA.name}`);
  if (tB.id !== 'none') why.push(`敌军用${tB.name}`);
  if (terrain) why.push(`地形属${terrain}`);
  if (weather) why.push(`天候${weather}`);
  if (sideA.supply != null && sideA.supply < 0.8) why.push('我军粮草不继');
  if (sideB.supply != null && sideB.supply < 0.8) why.push('敌军粮草不继');
  if (climateFactor(sideA, ctx) < 1) why.push('我军不服水土');
  if (climateFactor(sideB, ctx) < 1) why.push('敌军不服水土');
  if (ctx.crossing === 'ford') why.push('我军须渡河而战');
  if (ctx.crossing === 'jiang') why.push('我军须渡江而战');
  if (ctx.walls) why.push(`敌据城而守（城防${ctx.walls}等）`);
  why.push(`兵力 ${sideA.troops || 0} 对 ${sideB.troops || 0}`);

  return {
    winner, result, shareA: Number(shareA.toFixed(3)), winProbA: Number(winProbA.toFixed(3)),
    casualties: { A: casA, B: casB },
    reasons: why,
    note: '此为引擎按阵形克制、战术相性、兵力士气地形天候所作的**模型推演**，非史实精确；具体战况由 GM 据此写成叙事，玩家仍可在采纳前改阵改策重推。',
  };
}

const listFormations = () => FORMATIONS.map(f => ({ id: f.id, name: f.name, desc: f.desc, terrain: f.terrain, strong: f.strong, weak: f.weak }));
const listTactics = () => TACTICS.map(t => ({ id: t.id, name: t.name, desc: t.desc, need: t.need, risk: t.cost }));

module.exports = { resolveBattle, listFormations, listTactics, FORMATIONS, TACTICS };
