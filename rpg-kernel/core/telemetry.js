'use strict';
/**
 * 调用日志与统计面板（《设计书》§8.12）。
 * 每回合一行 JSON 追加到 data/logs/<存档id>.jsonl：输入摘要、计划卡问题、红线命中、重写次数、是否未解决、
 * 字数、检索后端、耗时。**不记任何 Key**，也不记整段提示词（只记长度）。
 * 统计：按每十回合汇总红线命中率、重写率、未解决率、平均字数与耗时，并合并玩家标记分布。
 */
const fs = require('fs');
const path = require('path');
const LOG_DIR = path.join(process.env.RPG_DATA_DIR || path.join(__dirname, '..', 'data'), 'logs');
const safe = s => String(s || 'unknown').replace(/[^\w一-龥-]/g, '_');

function logTurn(saveId, rec) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, safe(saveId) + '.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n', 'utf8');
  } catch (_) { /* 日志失败不影响游戏 */ }
}
function readLog(saveId) {
  try {
    return fs.readFileSync(path.join(LOG_DIR, safe(saveId) + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function stats(saveId, state) {
  const rows = readLog(saveId);
  const buckets = {};
  for (const r of rows) {
    const k = Math.floor((r.turn || 0) / 10);
    const b = buckets[k] || (buckets[k] = { 回合: `${k * 10 + 1}–${k * 10 + 10}`, 生成次数: 0, 红线命中: 0, 重写: 0, 未解决: 0, 字数: 0, 秒: 0, 计划卡不合格: 0, 检索: {} });
    b.生成次数++; b.字数 += r.chars || 0; b.秒 += r.secs || 0;
    if ((r.redlines || []).length) b.红线命中++;
    if (r.rewrites) b.重写++;
    if ((r.unresolved || []).length) b.未解决++;
    if ((r.planErrors || []).length) b.计划卡不合格++;
    for (const p of (r.providers || [])) b.检索[p] = (b.检索[p] || 0) + 1;
  }
  const table = Object.values(buckets).map(b => ({
    回合: b.回合, 生成次数: b.生成次数,
    红线命中率: pct(b.红线命中, b.生成次数), 重写率: pct(b.重写, b.生成次数), 未解决率: pct(b.未解决, b.生成次数),
    计划卡不合格率: pct(b.计划卡不合格, b.生成次数),
    平均字数: Math.round(b.字数 / Math.max(1, b.生成次数)), 平均秒: Math.round(b.秒 / Math.max(1, b.生成次数)), 检索后端: b.检索,
  }));
  const hot = {};
  for (const r of rows) for (const x of (r.redlines || [])) hot[x] = (hot[x] || 0) + 1;
  const flags = {};
  for (const f of ((state && state.playerFlags) || [])) flags[f.flag] = (flags[f.flag] || 0) + 1;
  return { 总生成次数: rows.length, 每十回合: table, 最常命中的红线: Object.entries(hot).sort((a, b) => b[1] - a[1]).slice(0, 6), 玩家标记: flags };
}
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');

function renderStats(s) {
  const L = [`总生成次数：${s.总生成次数}`];
  for (const r of s.每十回合) L.push(`第${r.回合}回合：生成 ${r.生成次数} 次｜红线命中 ${r.红线命中率}｜重写 ${r.重写率}｜仍未解决 ${r.未解决率}｜计划卡不合格 ${r.计划卡不合格率}｜平均 ${r.平均字数} 字、${r.平均秒} 秒｜检索 ${Object.entries(r.检索后端).map(([k, v]) => k + v).join(' ') || '—'}`);
  if (s.最常命中的红线.length) L.push('最常命中的红线：' + s.最常命中的红线.map(([k, v]) => `${k}×${v}`).join('；'));
  L.push('玩家标记：' + (Object.entries(s.玩家标记).map(([k, v]) => k + v).join(' ') || '（尚无）'));
  return L.join('\n');
}

module.exports = { logTurn, readLog, stats, renderStats };
