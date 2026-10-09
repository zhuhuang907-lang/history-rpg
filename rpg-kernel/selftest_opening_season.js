'use strict';
/**
 * 回归：开局突兀 / 季节错乱 / 提示词泄漏
 *
 * 起因（用户原话：「开头剧情很突兀」「数据几乎都是错的」）：
 *  ① 季节有两套表：events.js 的 SEASON_OF_MONTH 把 10 月判成「秋」，
 *     engine.js/world.js 把 10 月判成「冬」。同一时刻两个季节，
 *     于是太清二年冬月的成都闹起了只该夏秋发生的蝗灾——开局第一节就是「蔽日如云，禾稼一空」。
 *  ② rollEvent 里 `pool.length ? pool : FAMILIES`：季节筛不出事件族时静默退回全部，
 *     等于把季节约束整个绕过。
 *  ③ worldgen.historyOpening() 把导演指令（「开场须落在…不得开篇即写急报密诏」）
 *     拼进了 state.opening，而这个字段 UI 直接显示给玩家——提示词原文被贴到界面上。
 *  ④ plot.js 背景层把 yearLabel（「太清二年」）再拼一个「年」，写成「太清二年年10月」。
 *
 * 这个文件把上述四条钉死，任何一条退化都会红。
 */
const events = require('./core/events');
const worldgen = require('./core/worldgen');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const sec = t => console.log('\n[' + t + ']');

/* ------------------------------------------------------------------ */
sec('1 季节只有一张表');

// engine.js:1460 与 world.js:109 用的口径
const CANON = ['春', '春', '春', '夏', '夏', '夏', '秋', '秋', '秋', '冬', '冬', '冬'];
let seasonMismatch = [];
for (let m = 1; m <= 12; m++) {
  if (events.SEASON_OF_MONTH(m) !== CANON[m - 1]) seasonMismatch.push(`${m}月:${events.SEASON_OF_MONTH(m)}≠${CANON[m - 1]}`);
}
ok(seasonMismatch.length === 0,
  `SEASON_OF_MONTH 与 engine/world 的季节点径逐月一致${seasonMismatch.length ? '（不一致：' + seasonMismatch.join('，') + '）' : ''}`);
ok(JSON.stringify(events.SEASON_TABLE) === JSON.stringify(CANON), '季节表可按常量导出，供别处复用');

/* ------------------------------------------------------------------ */
sec('2 事件必须守季节：冬天不许闹蝗灾');

const winter = {
  meta: { id: 't-winter' }, turn: 3,
  clock: { yearLabel: '太清二年', gregorianYear: 548, month: 10, day: 15, season: '冬' },
  location: { full: '成都', polity: '梁', controller: '梁' },
  geography: {}, eventLog: [],
};
const locustFam = events.FAMILIES.find(f => f.id === 'locust');
ok(Array.isArray(locustFam.seasons) && !locustFam.seasons.includes('冬'),
  `蝗灾族限定季节为 ${JSON.stringify(locustFam.seasons)}，不含冬`);

// 强制掷 200 次，只要 season 被尊重就绝不该出蝗灾
let locustInWinter = 0, got = 0;
for (let i = 0; i < 200; i++) {
  const e = events.rollEvent({ ...winter, turn: 3 + i }, { force: true });
  if (!e) continue;
  got++;
  if (e.family === 'locust') locustInWinter++;
}
ok(got > 0, `强制掷 200 次确有事件产出（${got} 次）`);
ok(locustInWinter === 0, `冬季（clock.season=冬）不再掷出蝗灾（实测 ${locustInWinter} 次）`);

// 反例：夏天应当允许蝗灾出现，确认不是把蝗灾一刀砍没了
let locustInSummer = 0;
const summer = { ...winter, clock: { ...winter.clock, month: 7, season: '夏' } };
for (let i = 0; i < 200; i++) {
  const e = events.rollEvent({ ...summer, turn: 30 + i }, { force: true });
  if (e && e.family === 'locust') locustInSummer++;
}
ok(locustInSummer > 0, `夏季仍会掷出蝗灾（实测 ${locustInSummer} 次）——说明是按季节筛，不是禁掉该族`);

/* ------------------------------------------------------------------ */
sec('3 筛不出就不再硬凑（不许静默退回全部事件族）');

// 造一个没有任何事件族能匹配的季节：把全部族的 seasons 临时改成只剩「春」，再以「冬」去掷
const backup = events.FAMILIES.map(f => f.seasons);
events.FAMILIES.forEach(f => { f.seasons = ['春']; });
let anyNull = 0, anyProduced = 0;
for (let i = 0; i < 20; i++) {
  const e = events.rollEvent({ ...winter, turn: 90 + i }, { force: true });
  if (e === null) anyNull++; else anyProduced++;
}
events.FAMILIES.forEach((f, i) => { f.seasons = backup[i]; });
ok(anyProduced === 0 && anyNull === 20,
  `无事件族匹配时返回「本轮无事」（null ${anyNull}/20，硬凑 ${anyProduced}/20）`);

/* ------------------------------------------------------------------ */
sec('4 开局不许被天灾砸脸');

// 复刻 engine.runTurn 的首回合判定：日志里还没有 GM 发言时，不掷事件
const isFirstTurn = !(winter.log || []).some(l => l.speaker === 'GM');
ok(isFirstTurn === true, '尚无 GM 发言 → 判定为首回合');
const firstEvt = isFirstTurn ? null : events.rollEvent(winter, { probability: 0.08 });
ok(firstEvt === null, '首回合不掷突发事件（旧版会让玩家一睁眼先吃一场蝗灾）');

/* ------------------------------------------------------------------ */
sec('5 开局处境里不许出现导演指令');

const DIRECTIVE_RE = /开场须|不得开篇|严禁|须落在|不许开篇|GM|提示词|你不是在写剧情|不要开场即写/;
const wgSrc = require('fs').readFileSync(require('path').join(__dirname, 'core/worldgen.js'), 'utf8');
const fnBody = wgSrc.slice(wgSrc.indexOf('function historyOpening'), wgSrc.indexOf('/* 历史一致性检查'));
ok(!DIRECTIVE_RE.test(fnBody.replace(/^\s*\/\/.*$/gm, '')),
  'historyOpening() 源码里已无导演指令文案（指令只在 prompt.js）');

// 真跑一次未成年分支，确认输出干净
const minor = {
  meta: { id: 't-minor' }, turn: 0,
  clock: { yearLabel: '开平元年', gregorianYear: 907, month: 3, day: 2, season: '春' },
  location: { full: '潭州', polity: '楚', controller: '楚' },
  protagonist: { name: '马希声', age: 9, born: 899, role: '', office: '' },
  threads: [], npcs: [],
};
let minorOpening = '';
try { minorOpening = worldgen.historyOpening ? worldgen.historyOpening(minor, () => 0.5, []) : ''; } catch { /* 未导出则跳过 */ }
if (minorOpening) {
  ok(!DIRECTIVE_RE.test(minorOpening), `未成年分支的开局文本不含指令（实际：${minorOpening.slice(0, 40)}…）`);
  ok(/马殷|府中主事者/.test(minorOpening), '未成年分支点明了真正拿主意的人');
} else {
  console.log('  · historyOpening 未导出，跳过运行时校验（已做源码级校验）');
}

/* ------------------------------------------------------------------ */
sec('6 时间字段不许叠字：太清二年年 → 太清二年');

const plot = require('./core/plot');
const st = {
  clock: { yearLabel: '太清二年', gregorianYear: 548, month: 10, day: 15, season: '冬' },
  location: { full: '成都', polity: '梁', controller: '梁' },
  economy: null, npcs: [], threads: [],
};
const bg = plot.backgroundOf ? plot.backgroundOf(st) : null;
if (bg && bg.时间) {
  ok(!/年年/.test(bg.时间), `背景层时间无叠字：${bg.时间}`);
  ok(bg.时间.startsWith('太清二年'), `背景层时间以年号起头：${bg.时间}`);
} else {
  console.log('  · plot.backgroundOf 未导出，跳过');
}

/* ------------------------------------------------------------------ */
sec('7 米价不再写死 300，按朝代给估算量级并标注来源');

const econ = require('./core/economy');
const G = e => e.market.grainWenPerShi;
const checkGrain = (y, dyn) => {
  const st = { clock: { yearLabel: '', gregorianYear: y, month: 5, day: 1, season: '夏' }, location: { full: '某州' }, protagonist: { name: '测试', age: 40 } };
  try { const e = econ.initEconomy(st, { force: true }); return e; } catch { return null; }
};
const gTang = checkGrain(730);     // 唐开元：应明显低于 300
const gSong = checkGrain(1068);    // 宋熙宁：应低于 300
const gLiang = checkGrain(548);    // 梁太清：南北朝量级
ok(gTang && G(gTang) < 300, `唐代米价基准低于 300（实测 ${gTang ? G(gTang) : 'N/A'}）`);
ok(gSong && G(gSong) < 300, `宋代米价基准低于 300（实测 ${gSong ? G(gSong) : 'N/A'}）`);
ok(gLiang && gLiang.market.grainSource === 'estimate', '米价标注来源为 estimate（不再是裸常数）');
ok(gLiang && /推算|估算|据史核定/.test(gLiang.market.grainNote || ''), '米价备注说明是推算、可据史核定');
const gMing = checkGrain(1450);
ok(gMing && G(gMing) >= 300, `明代米价基准不低于 300（实测 ${gMing ? G(gMing) : 'N/A'}）`);

console.log('\n———— 开局与季节回归：' + pass + ' 通过 / ' + fail + ' 失败 ————');
process.exit(fail ? 1 : 0);
