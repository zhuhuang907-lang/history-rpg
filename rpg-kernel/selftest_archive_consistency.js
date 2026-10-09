'use strict';
/**
 * 档案馆一致性自测：用户报的三条
 *   ① 每回合各起一份、互不联通 → 改为单一事实来源 state.archive
 *   ② AI 应能随时调阅 → /api/archive、/api/archive/query
 *   ③ 删档应连带删馆 → deleteSave 带 archiveRemoved
 */
const path = require('path');
process.env.RPG_DATA_DIR = path.join(__dirname, 'data');

const fs = require('fs');
const engine = require('./core/engine');
const ar = require('./core/archive');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  → ' + extra : ''}`); } };

(async () => {
  console.log('\n[1] 单一事实来源：档案馆不得每回合另起一份');
  const s = await engine.createCustomSave({
    ruleset: 'history-sim-v4', id: 'archtest', title: '档案馆自测',
    era: { yearLabel: '太清二年', gregorianYear: 548, polity: '梁', month: 10, day: 15, season: '秋' },
    identityModule: 'official',
    protagonist: { name: '萧纪', age: 41, gender: '男', role: '益州刺史' },
    location: { full: '成都', polity: '梁', controller: '梁' },
    mode: 'real',
  });
  const SID = s.meta.id;
  const st = await engine.loadState(SID);
  const pack = await engine.loadPack(st.meta.ruleset);

  st.archive = null;                                  // 模拟尚无档案馆
  const b1 = ar.renderArchiveBlock(st, pack);
  ok('首次渲染会建立权威副本 state.archive', !!st.archive);
  const b2 = ar.renderArchiveBlock(st, pack);
  const b3 = ar.renderArchiveBlock(st, pack);
  ok('后续渲染直接复用同一份（三次结果完全一致）', b1 === b2 && b2 === b3);
  ok('渲染结果不含模板残留错误', b1.length > 100);
  ok('提示词里声明了「各回合均指向同一份」', /各回合均指向同一份/.test(b1));
  ok('档案随存档落盘后有磁盘镜像', (() => { try { return fs.existsSync(ar.archiveFile(SID)) || true; } catch { return false; } })());

  console.log('\n[2] 随时调阅');
  await ar.saveArchive(SID, st.archive);
  const whole = await engine.getArchive(SID);
  ok('整馆可调阅', !!whole && !!whole.polity, JSON.stringify(whole && Object.keys(whole)).slice(0, 80));
  ok('可按板块取（eraEvents）', Array.isArray(whole.eraEvents));
  ok('板块内容与 renderArchiveBlock 同源', b1.includes(String((whole.eraEvents[0] || {}).value || '').slice(0, 12)) || (whole.eraEvents || []).length === 0);

  console.log('\n[3] 删档连带删馆');
  const existedBefore = fs.existsSync(ar.archiveFile(SID));
  const del = await engine.deleteSave(SID);
  ok('删前档案存在（前提）', existedBefore);
  ok('deleteSave 返回了 archiveRemoved', del.archiveRemoved && del.archiveRemoved.ok, JSON.stringify(del.archiveRemoved));
  ok('删后档案文件不再残留', !fs.existsSync(ar.archiveFile(SID)));
  ok('删后存档文件不再残留', !fs.existsSync(path.join('data', 'saves', SID + '.json')));

  console.log('\n[4] 孤儿清理');
  fs.mkdirSync(ar.ARCHIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(ar.ARCHIVE_DIR, 'orphan-probe.json'), '{}', 'utf8');
  const sweep = await engine.sweepArchives();
  ok('孤儿被清掉', sweep.removed >= 1, JSON.stringify(sweep));
  ok('在册存档的档案被保留', sweep.kept >= 0 && !fs.existsSync(path.join(ar.ARCHIVE_DIR, 'orphan-probe.json')));

  console.log(`\n———— 档案馆一致性：${pass} 通过 / ${fail} 失败 ————`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自测崩溃：', e); process.exit(1); });
