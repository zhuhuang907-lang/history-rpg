'use strict';
/**
 * 突发事件库：不是「写死十几条」，而是**组合式**生成——
 *   事件族 × 变体 × 程度 × 地点 × 后果，组合数以万计，几乎无限。
 *
 * 但**出现率低**：默认每回合约 8% 触发，且「同族冷却」，不会老是砸同一类灾。
 * 事件必须与该时代、季节、地形相符（夏天不下大雪、南方不闹雪灾）。
 *
 * 产出交给 GM 作为「天降之事」写进场景；引擎只负责「该不该发生、发生什么」。
 */

/* 程度：绝大多数是「轻」，重灾罕见（幂律），符合真实灾害分布 */
const SEVERITY = [
  { id: 'light', label: '轻', w: 62, note: '影响局部、可挽回' },
  { id: 'mid', label: '中', w: 28, note: '波及一县一军、需应对' },
  { id: 'heavy', label: '重', w: 10, note: '震动一方、留后患' },
];
/* 季节表：必须与 engine.js / world.js 用的那张一致（春夏秋冬各三个月）。
   旧版此处是另一套映射（1、2、12 月算冬，9~11 月算秋），于是 10 月被判成「秋」，
   而存档 clock.season 写的是「冬」——同一时刻两个季节，
   结果冬天掷出了只该发生在夏秋的蝗灾。现在统一为唯一口径。 */
const SEASON_TABLE = ['春', '春', '春', '夏', '夏', '夏', '秋', '秋', '秋', '冬', '冬', '冬'];
const SEASON_OF_MONTH = m => SEASON_TABLE[((Number(m) || 1) - 1) % 12];

/* 事件族。seasons 为空表示四季皆可；terrain 限定地形（平原/山地/水乡/海滨/边塞）。 */
const FAMILIES = [
  { id: 'rainstorm', name: '暴雨', seasons: ['春', '夏', '秋'], w: 10,
    tpl: ['连日暴雨，{place}沟浍皆盈', '{place}骤雨如注，昼夜不止', '雷雨大作，{place}道路为水所断'],
    eff: ['桥道冲毁，粮运迟滞', '军行泥淖，人马俱疲', '低田尽没，秋收可忧'] },
  { id: 'flood', name: '洪水', seasons: ['夏', '秋'], terrain: ['水乡', '平原'], w: 7,
    tpl: ['{place}大水，{river}决口', '霖雨不止，{place}四野成泽', '{river}汛涨溢岸，漂没庐舍'],
    eff: ['流民载道，仓储告急', '堤工屡兴，民力已疲', '漕运阻绝，京师米价腾踊'] },
  { id: 'drought', name: '大旱', seasons: ['春', '夏'], w: 8,
    tpl: ['{place}亢旱，井泉皆涸', '春来无雨，{place}赤地千里', '骄阳如炙，{place}田禾焦卷'],
    eff: ['秋赋难征，里正催科更急', '民多流亡，盗贼渐起', '官中祈雨，斋醮之费又增'] },
  { id: 'locust', name: '蝗灾', seasons: ['夏', '秋'], w: 6,
    tpl: ['蝗自东来，蔽日如云，{place}禾稼一空', '{place}飞蝗入境，食稼殆尽', '蝗蝻生发，{place}秋苗无可望'],
    eff: ['米价一日三涨', '富户闭粜，贫者夺门', '官发仓廪，然杯水车薪'] },
  { id: 'hail', name: '冰雹', seasons: ['春', '夏'], w: 4,
    tpl: ['{place}雨雹大如鸡子，击杀人畜', '雹下如石，{place}屋瓦尽碎', '{place}骤降冰雹，麦禾尽偃'],
    eff: ['秋成绝望，佃户逃亡', '牛马有毙者，耕具亦损'] },
  { id: 'snow', name: '大雪奇寒', seasons: ['冬'], w: 5,
    tpl: ['{place}大雪盈尺，人畜冻毙', '奇寒，{place}河冰合可行车马', '风雪旬日，{place}薪炭价贵数倍'],
    eff: ['戍卒僵仆，戍所有逃亡', '贫者无薪，冻死于途'] },
  { id: 'thunder', name: '雷火', seasons: ['春', '夏'], w: 3,
    tpl: ['雷击{place}，屋舍焚毁', '霹雳落于{place}，击死数人', '雷电引燃仓廪，{place}火起'],
    eff: ['仓谷焚毁，账目需重核', '火势延烧，市廛尽毁'] },
  { id: 'wildfire', name: '山火', seasons: ['秋', '冬', '春'], terrain: ['山地', '丘陵'], w: 4,
    tpl: ['{place}山火大作，连烧数日不熄', '樵者失火，{place}林木焚毁殆尽', '天干物燥，{place}野火蔓延'],
    eff: ['柴薪断绝，征税更艰', '野兽逃窜，伤及村落'] },
  { id: 'quake', name: '地震', seasons: [], w: 3,
    tpl: ['地震，{place}城堞颓圮', '地大震，{place}屋宇倾侧', '{place}地震有声如雷，人皆奔避'],
    eff: ['官廨倾颓，文书散失', '民舍多倒，赈恤之议起', '讹言纷起，民心惶惶'] },
  { id: 'landslide', name: '山崩', seasons: ['夏', '秋'], terrain: ['山地'], w: 2,
    tpl: ['{place}山崩，塞断驿道', '大雨之后，{place}崖石崩落', '山体滑坡，{place}道绝数日'],
    eff: ['驿传断绝，军报迟滞', '行旅阻隔，商货不至'] },
  { id: 'plague', name: '疫病', seasons: ['春', '夏', '秋'], w: 6,
    tpl: ['{place}疫起，死者相枕', '时疫流行，{place}十室九病', '{place}瘟疫大作，医者束手'],
    eff: ['城门昼闭，市集萧条', '军营染疫，减员可虑', '尸骸须掩埋，官府拮据'] },
  { id: 'livestock', name: '畜疫', seasons: [], w: 3,
    tpl: ['{place}牛马疫死，耕畜缺乏', '畜疫流行，{place}牛马十死三四'],
    eff: ['春耕无牛，田多荒芜', '军马损耗，骑兵大减'] },
  { id: 'comet', name: '彗星', seasons: [], w: 3,
    tpl: ['彗星出于{dir}，长数丈', '客星犯帝座，占者失色', '彗孛见天，士民惊惧'],
    eff: ['星变之说纷传，甚至有倡乱者', '朝廷恐惧，下诏求直言', '占星者受责，然人心已摇'] },
  { id: 'eclipse', name: '日食月食', seasons: [], w: 3,
    tpl: ['日有食之，昼晦如夜', '月食既，占者以为大凶', '日食于{dir}，百官救日'],
    eff: ['天人感应之说大行，朝议纷然', '民间讹言，市井不宁'] },
  { id: 'meteor', name: '陨石', seasons: [], w: 2,
    tpl: ['有星陨于{place}，声如雷', '陨石坠地，{place}掘得石如铁'],
    eff: ['士民以为天示之兆，讹言四起', '有人借此倡言天命'] },
  { id: 'omen', name: '祥瑞', seasons: [], w: 3,
    tpl: ['{place}献白鹿，以为祥瑞', '{place}得嘉禾一茎九穗', '凤凰见于{place}，乡民聚观'],
    eff: ['有司欲上祥瑞以邀功', '或为官员粉饰太平之具'] },
  { id: 'omen_bad', name: '凶兆', seasons: [], w: 3,
    tpl: ['{place}有石人出地，上有字', '童谣流传，词意不详', '{place}井水变赤，人心惶惧'],
    eff: ['或为有心人伪造，以摇动人心', '官府欲究其源，牵连甚广'] },
  { id: 'fire_city', name: '城市火灾', seasons: ['冬', '春'], w: 4,
    tpl: ['{place}火起，延烧百馀家', '夜市失火，{place}市廛半毁', '{place}官仓失火，损失颇巨'],
    eff: ['粮储焚毁，需重购补', '纵火之由不明，疑有奸人'] },
  { id: 'bandit', name: '盗贼', seasons: [], w: 7,
    tpl: ['{place}界盗贼蜂起，商旅不通', '群盗劫掠{place}，官军追捕不及', '饥民相聚为盗，{place}戒严'],
    eff: ['商道断绝，财源大损', '官府勒兵征讨，费钱粮', '良民亦有从贼者，难以尽剿'] },
  { id: 'mutiny', name: '兵变', seasons: [], w: 4,
    tpl: ['戍卒缺饷，{place}鼓噪', '军中哗变，杀主将而据其营', '饥兵劫粮于{place}'],
    eff: ['若不抚则愈炽，抚则弃法', '诸营观望，恐相效尤'] },
  { id: 'price', name: '粮价腾踊', seasons: ['春', '夏'], w: 5,
    tpl: ['{place}米价一日数涨，斗米数百钱', '商贾闭粜，{place}米贵如珠', '军需采买，{place}粮价顿起'],
    eff: ['贫民买不起粮，多有饿殍', '官仓出粜可平，然储亦有限', '囤积者大发，民怨沸腾'] },
  { id: 'refugee', name: '流民', seasons: ['秋', '冬'], w: 6,
    tpl: ['流民数万至{place}，求食于官', '{place}道旁饥民络绎，扶老携幼', '邻境流民蚁聚{place}城外'],
    eff: ['赈则费粮，不赈则生变', '流民中或藏奸细、或聚为贼'] },
  { id: 'rumor', name: '谣言', seasons: [], w: 5,
    tpl: ['{place}谣传朝廷将加赋', '有人散播{place}将陷之语，民多搬迁', '匿名文揭于{place}市门'],
    eff: ['民心浮动，需弹压或安抚', '或系政敌所为，欲乱尔阵脚'] },
  { id: 'official', name: '上官/御史', seasons: [], w: 5,
    tpl: ['御史巡按至{place}，所过州县供亿甚巨', '朝命征{place}钱粮，限期严迫', '上官檄文至，责令{place}具报'],
    eff: ['应付失当即获罪', '需权衡供给与民力'] },
  { id: 'edict', name: '诏令', seasons: [], w: 4,
    tpl: ['朝廷诏书至{place}，大赦或加征', '朝命改元，{place}须更张', '诏征{place}精壮从军'],
    eff: ['奉诏则损己利，违则获罪', '下属观望你的态度'] },
  { id: 'envoy', name: '使者/邻境', seasons: [], w: 4,
    tpl: ['邻境使者至{place}，欲结盟或借道', '邻镇发兵屯于{place}界上，来意不明', '他方密使赍书至，许以厚利'],
    eff: ['是盟是诈，须细察', '允之或触怒他人，拒之或启衅'] },
  { id: 'border', name: '边衅', seasons: [], terrain: ['边塞'], w: 5,
    tpl: ['{place}北有胡骑游弋', '边报：敌骑数百犯{place}塞', '斥候报，境外聚兵，意图未明'],
    eff: ['边戍须增，军费随之', '或可因之立功，或因此失地'] },
  { id: 'wind', name: '大风', seasons: ['春', '冬'], w: 4,
    tpl: ['{place}连日大风，拔木毁屋', '怪风起于{place}，尘沙蔽天', '飓风过{place}，海舶多坏'],
    eff: ['敌火攻之机或在此', '海运漕运俱受阻'] },
];
FAMILIES.forEach(f => { f.seasons = f.seasons || []; f.tpl = f.tpl || []; f.eff = f.eff || []; });

const DIRS = ['东方', '东南', '南方', '西南', '西方', '西北', '北方', '东北'];
const RIVERS = ['大河', '江水', '淮水', '汉水', '渭水', '济水', '漕渠', '运河'];

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296; }; }
function weighted(r, arr, wkey = 'w') {
  const tot = arr.reduce((s, x) => s + (x[wkey] || 1), 0);
  let v = r() * tot;
  for (const x of arr) { v -= (x[wkey] || 1); if (v <= 0) return x; }
  return arr[arr.length - 1];
}

/** 事件族总组合数（用于说明「近乎无限」） */
function varietyEstimate() {
  let n = 0;
  for (const f of FAMILIES) n += f.tpl.length * f.eff.length;
  return { families: FAMILIES.length, pairs: n, withSeverity: n * SEVERITY.length, withPlace: n * SEVERITY.length * (DIRS.length + RIVERS.length + 6) };
}

/**
 * 掷一个突发事件。返回 null 表示本轮「无事」。
 * @param state 存档
 * @param opts { force, probability }  force 用于测试/剧情需要
 */
function rollEvent(state, opts = {}) {
  const month = Number(state.clock && state.clock.month) || 6;
  // 以存档已锁定的季节为准（clock.season 由推进时钟写入），缺失时才按月推。
  // 旧版这里只信 SEASON_OF_MONTH，而那张表和 engine/world 的又不一样，
  // 于是出现了「存档写着冬、事件却按秋来掷」的矛盾。
  const season = (state.clock && state.clock.season) || SEASON_OF_MONTH(month);
  const place = shortPlace(state.location && state.location.full);
  const terrainTags = terrainOf(state);
  const gy = (state.clock && state.clock.gregorianYear) || 0;

  const prob = opts.probability != null ? opts.probability : 0.08; // 默认每回合 8%
  const seedStr = `${state.meta ? state.meta.id : ''}|${state.turn}|${gy}|${month}|evt`;
  const r = rng(hash(seedStr));
  if (!opts.force && r() > prob) return null;

  // 冷却：近 6 轮出现过的族，权重降到 1/5，避免老是同一类
  const recent = new Set((state.eventLog || []).slice(-6).map(e => e.family));
  // 开局头两轮不掷：先让玩家站稳，再谈天灾人祸
  if (!opts.force && (state.turn || 0) < 2) return null;
  // 年景决定本年可能出什么事：旱年才有蝗、涝年才有水患；
  // 星变、陨石、祥瑞凶兆、兵变这类不靠掷骰子——要么有天文/史书依据，要么有欠饷等前因。
  const omen = yearOmen(state);
  if (!opts.force && omen.kind === '平' && r() > 0.35) return null;   // 平年多半无事
  // force（测试或剧情点名要事）时不受年景限制，但仍守季节与地形
  const allowed = new Set(opts.force ? FAMILIES.map(f => f.id) : omen.families);
  const pool = FAMILIES.filter(f => allowed.has(f.id) && (!f.seasons.length || f.seasons.includes(season)) && (!f.terrain || f.terrain.some(t => terrainTags.includes(t))));
  // 旧版写 `pool.length ? pool : FAMILIES`——季节/地形筛不出东西时静默退回全部事件族，
  // 等于把季节约束整个绕过（冬天照样闹蝗灾）。筛不出就本轮无事，不硬凑。
  if (!pool.length) return null;
  const usable = pool.map(f => ({ ...f, w: recent.has(f.id) ? Math.max(1, (f.w || 4) / 5) : (f.w || 4) }));

  const fam = weighted(r, usable);
  // 重灾只出在大旱/大涝之年；平年、丰年最多是「轻」
  const sev = omen.severe ? weighted(r, SEVERITY) : omen.kind === '平' || omen.kind === '丰' ? SEVERITY[0] : weighted(r, SEVERITY.slice(0, 2));
  const text = fam.tpl[Math.floor(r() * fam.tpl.length)]
    .replace('{place}', place)
    .replace('{dir}', DIRS[Math.floor(r() * DIRS.length)])
    .replace('{river}', localRiver(state, r));
  const effects = [];
  const n = Math.floor(r() * 2) + 1;
  const shuffledEff = [...fam.eff].sort(() => r() - 0.5);
  for (let i = 0; i < n && i < shuffledEff.length; i++) effects.push(shuffledEff[i]);

  return {
    id: `${fam.id}-${state.turn}-${Math.floor(r() * 1e6)}`,
    family: fam.id,
    familyName: fam.name,
    season,
    severity: sev.id,
    severityLabel: sev.label,
    severityNote: sev.note,
    text,
    effects,
    probability: prob,
    yearOmen: omen.kind,
  };
}

/**
 * 年景：同一地方、同一年只有一种年景，整年口径一致（不会春旱夏涝秋又旱）。
 * 去年旱，今年蝗的可能大增（旱蝗相随，史书常见）。按存档与年份确定，读档重玩结果不变。
 */
const OMENS = [
  { kind: '大旱', p: 0.04, severe: true, families: ['drought', 'locust', 'wildfire', 'price', 'refugee', 'bandit'] },
  { kind: '旱', p: 0.09, families: ['drought', 'hail', 'wildfire', 'price'] },
  { kind: '大水', p: 0.03, severe: true, water: true, families: ['flood', 'rainstorm', 'landslide', 'plague', 'price', 'refugee', 'bandit'] },
  { kind: '涝', p: 0.07, water: true, families: ['rainstorm', 'flood', 'landslide', 'plague'] },
  { kind: '寒', p: 0.05, families: ['snow', 'livestock', 'price'] },
  { kind: '丰', p: 0.14, families: ['official', 'rumor', 'envoy'] },
];
const OMEN_PLAIN = { kind: '平', families: ['rainstorm', 'fire_city', 'wind', 'official', 'rumor', 'border', 'envoy'] };
function baseOmen(state, year) {
  const place = shortPlace(state.location && state.location.full);
  const r = rng(hash(`${state.meta ? state.meta.id : ''}|${year}|${place}|omen`));
  const wet = terrainOf(state).includes('水乡');
  let v = r(), acc = 0;
  for (const o of OMENS) { acc += o.water && !wet ? o.p * 0.4 : o.p; if (v < acc) return o; }
  return OMEN_PLAIN;
}
function yearOmenAt(state, year) {
  const r = rng(hash(`${state.meta ? state.meta.id : ''}|${year}|locust`));
  if (/旱/.test(baseOmen(state, year - 1).kind) && r() < 0.35) return { kind: '蝗', severe: true, families: ['locust', 'price', 'refugee', 'bandit'] };
  return baseOmen(state, year);
}
function yearOmen(state) {
  const gy = Number(state.clock && state.clock.gregorianYear) || 0;
  return yearOmenAt(state, gy);
}
/** 用当地真实水系的名字；查不到就泛称，不再从全国河流里随机挑一条 */
function localRiver(state, r) {
  const g = (state.geography && typeof state.geography === 'object') ? state.geography : {};
  const blob = String(g['水系'] || '');
  const hit = RIVERS.filter(x => blob.includes(x.replace(/水$/, '')));
  if (hit.length) return hit[Math.floor(r() * hit.length)];
  const m = blob.match(/[\u4e00-\u9fa5]{1,3}(?:江|河|水|溪|渠)/);
  return m ? m[0] : '境内河道';
}

/**
 * 事件正文里用的地名：只取「聚落」那一层。
 * location.full 存的是完整地址串（如「两浙路 常州 晋陵县 常州州衙」），
 * 旧版直接整串替换 {place}，于是写出「朝命征两浙路 常州 晋陵县 常州州衙钱粮」——
 * 又长又重复（常州出现两次）。这里剥掉路/道/衙署等后缀，取人真正会说出口的那个地名。
 */
const PLACE_SUFFIX = /(州衙|县衙|府衙|郡衙|道衙|治所|官署|廨舍|城内|城外|城北门外|城南门外|城东门外|城西门外|门外|郭外)+$/;
function shortPlace(full) {
  const s = String(full || '').trim();
  if (!s) return '本境';
  const segs = s.split(/[\s·、,，]+/).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const t = segs[i].replace(PLACE_SUFFIX, '').trim();
    if (!t) continue;
    // 必须是说得出口的地名（州/县/郡/府/城/镇/乡，或原本就是纯地名如「成都」）
    if (/[州县郡府城镇乡]$/.test(t) || segs.length === 1) return t;
  }
  return segs[segs.length - 1] || '本境';
}

/** 从地理里推断地形标签，用于事件过滤 */
function terrainOf(state) {
  const g = (state.geography && typeof state.geography === 'object') ? state.geography : {};
  const blob = [g['地形'], g['水系'], g['常发灾异'], (state.location && state.location.full)].filter(Boolean).join(' ');
  const tags = [];
  if (/山|丘|岭|陉|坂/.test(blob)) tags.push('山地', '丘陵');
  if (/水|江|河|湖|泽|渠|海/.test(blob)) tags.push('水乡');
  if (/海|斥卤|滨/.test(blob)) tags.push('海滨');
  if (/边|塞|关|戍|长城/.test(blob)) tags.push('边塞');
  if (/平原|沃|腴|野/.test(blob)) tags.push('平原');
  return tags;
}

/** 给 GM 提示词用的段落 */
function renderEvent(evt) {
  if (!evt) return '';
  return [
    '=== 天降之事（引擎本轮掷出的突发事，须自然地发生在本轮场景中，不得无视） ===',
    `【${evt.severityLabel}·${evt.familyName}】${evt.text}。可能的后果：${evt.effects.join('；')}。${evt.yearOmen ? `（本年年景：${evt.yearOmen}。此事须与年景相符，并写出前因。）` : ''}`,
    '要求：这是「天有不测」而非人力所能预先安排之事，须写出在场人的真实反应（惊、惧、趁火打劫、或借机行事），并让它与玩家本轮的指令相互作用；不得把它写成对玩家有利的巧合，也不得每次都替他化解。',
  ].join('\n');
}

module.exports = { rollEvent, yearOmen, renderEvent, varietyEstimate, FAMILIES, SEVERITY, SEASON_OF_MONTH, SEASON_TABLE, terrainOf, shortPlace };
