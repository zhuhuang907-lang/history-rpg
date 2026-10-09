'use strict';
/* 清理测试残留存档：只删「测试专用前缀」的存档，绝不碰真实存档（liangmo- / custom-）。
 * 既可作为独立测试运行，也可被 test_runner.js 调用。 */
const engine = require('./core/engine');

// 测试残留存档的 id 前缀（只删这些）
const TEST_PREFIXES = [
  'selftest-', 'plot-e2e-', 'plot-', 'xjlong-', 'yanjun-',
  'yezhiwei-', 'mxs-', 't-', 'vlock-', 'archtest', 'apitest-', 'tmp-', 'zzz-',
];
// 真实存档前缀（双重保险：即便上面清单漏了，这些也绝不删）
const PROTECTED_PREFIXES = ['liangmo-', 'custom-'];
// 精确排除：被某些测试当作「模板夹具」读取、却又以测试前缀开头的存档。
// 例如 yezhiwei-1068-autumn 是 selftest_bugs / selftest_economy 的读入模板，删了会让它们崩溃。
// 注意：同名带随机后缀的残留（如 yezhiwei-1068-autumn-muyv6064）不在此列，仍会被清掉。
const EXACT_FIXTURES = ['yezhiwei-1068-autumn'];

function isTestSave(id) {
  if (typeof id !== 'string' || !id) return false;
  if (EXACT_FIXTURES.includes(id)) return false;
  if (PROTECTED_PREFIXES.some(p => id.startsWith(p))) return false;
  return TEST_PREFIXES.some(p => id.startsWith(p));
}

async function cleanupTestSaves(verbose = true) {
  const saves = await engine.listSaves();
  const targets = saves.filter(s => isTestSave(s.id));
  const kept = saves.filter(s => !isTestSave(s.id));
  let removed = 0;
  const removedIds = [];
  for (const s of targets) {
    try { await engine.deleteSave(s.id); removed++; removedIds.push(s.id); }
    catch { /* 已删或不存在，忽略 */ }
  }
  if (verbose) {
    console.log(`[清理] 移除 ${removed} 个测试残留存档；保留 ${kept.length} 个真实存档。`);
    if (removedIds.length) console.log('  移除：' + removedIds.join(', '));
    const keepShown = kept.slice(0, 30).map(s => s.id).join(', ');
    console.log('  保留：' + keepShown + (kept.length > 30 ? ' …' : ''));
  }
  return { removed, removedIds, kept: kept.length };
}

module.exports = { TEST_PREFIXES, PROTECTED_PREFIXES, isTestSave, cleanupTestSaves };

if (require.main === module) {
  cleanupTestSaves().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
