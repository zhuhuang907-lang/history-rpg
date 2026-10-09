'use strict';
/* 端点安全回归：API 的 saveId 直接拼进文件路径（path.join(SAVE_DIR, `${id}.json`）），
 * 旧版零过滤 —— `saveId:"../../foo"` 能路径穿越读到/删到 SAVE_DIR 之外的文件；
 * `saveId:undefined` 删档会静默「成功」。本测试守住这两条底线。 */
const engine = require('./core/engine');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

const ROOT = process.cwd();
const tmpIds = [];
function track(id) { tmpIds.push(id); }

(async function main() {
  console.log('[1] loadState 拒绝路径穿越字符');
  for (const bad of ['../../package', '..\\..\\foo', '../x', 'a/../b', '..', '.', 'a..b']) {
    let threw = false, code = '';
    try { await engine.loadState(bad); } catch (e) { threw = true; code = e.code; }
    ok(threw && code === 'BADID', `loadState(${JSON.stringify(bad)}) 被拒绝 (BADID)`);
  }

  console.log('[2] deleteSave 拒绝路径穿越字符');
  for (const bad of ['../../package', '..\\win', '../x', 'a/../b']) {
    let threw = false, code = '';
    try { await engine.deleteSave(bad); } catch (e) { threw = true; code = e.code; }
    ok(threw && code === 'BADID', `deleteSave(${JSON.stringify(bad)}) 被拒绝 (BADID)`);
  }

  console.log('[3] 缺失 / 非字符串 saveId 一律拒绝（不再静默「成功」）');
  for (const bad of [undefined, null, '', 123, '   ']) {
    let threw = false, code = '';
    try { await engine.deleteSave(bad); } catch (e) { threw = true; code = e.code; }
    ok(threw && code === 'BADID', `deleteSave(${JSON.stringify(bad)}) 被拒绝 (BADID)`);
    try { await engine.loadState(bad); } catch (e) { code = e.code; }
    ok(code === 'BADID', `loadState(${JSON.stringify(bad)}) 被拒绝 (BADID)`);
  }

  console.log('[4] 不存在的合法 id 报错信息明确（「存档不存在」而非裸 ENOENT）');
  const missing = 'selftest-sec-missing-' + Date.now().toString(36);
  let mErr = null;
  try { await engine.loadState(missing); } catch (e) { mErr = e; }
  ok(mErr && mErr.code === 'ENOENT' && /存档不存在/.test(mErr.message), 'loadState 缺失档 → 明确提示「存档不存在」');

  console.log('[5] writeState 拒绝非法 id（防止写穿出 SAVE_DIR）');
  let wErr = null;
  try { await engine.writeState({ meta: { id: '../../escape' } }); } catch (e) { wErr = e; }
  ok(wErr && wErr.code === 'BADID', 'writeState 非法 id 被拒绝');
  // 良性中文 id 仍允许（自定义存档名可能含中文，不能误伤）
  let wOk = true;
  try {
    const id = 'selftest-安全测试-' + Date.now().toString(36);
    await engine.writeState({ meta: { id } });
    track(id);
    await engine.loadState(id);
  } catch (e) { wOk = false; }
  ok(wOk, '含中文的合法 id 仍可正常读写');

  console.log('[6] 真实 HTTP 层：POST /api/save/delete 穿越 id 不会删到外部文件');
  const probe = path.join(ROOT, 'SEC_PROBE_DO_NOT_DELETE.json');
  fs.writeFileSync(probe, 'keep');
  let httpChecked = false;
  try {
    const http = require('http');
    const body = JSON.stringify({ saveId: '../../SEC_PROBE_DO_NOT_DELETE' });
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: 8787, path: '/api/save/delete', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ code: r.statusCode, body: d }));
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
    httpChecked = true;
    let parsed = {}; try { parsed = JSON.parse(res.body); } catch {}
    ok(parsed.ok === false, 'HTTP 删除穿越 id 返回 ok:false（未放行）');
    ok(fs.existsSync(probe), '被探测的外部文件未被删除（穿越已阻断）');
  } catch (e) {
    console.log('  SKIP HTTP 探测（服务未启动？）: ' + (e && e.message));
  } finally {
    try { fs.unlinkSync(probe); } catch {}
  }

  console.log('[7] 已建测试存档清理');
  for (const id of tmpIds) { try { await engine.deleteSave(id); } catch {} }
  ok(true, '清理 ' + tmpIds.length + ' 个临时存档');

  console.log(`\n端点安全测试：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
