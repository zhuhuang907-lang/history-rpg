'use strict';
/**
 * 自测：AI 必须真的被调用（不得静默退回本地骨架）
 *
 * 故障现场：用户报「AI 都不反馈结果了，根本收不到内容」。
 * 实测 /api/turn 返回的是——
 *   【骨架输出】此处本应由外部框架生成正文。当前未接入任何叙事框架。
 *
 * 根因：adapters/index.js 的 resolveAdapter 在 id 为空时直接 fallback 到
 *   all.find(a => a.id === 'skeleton')
 * 而 runTurn 里 `adapterId` 没有兜底（seedWorld 有 `|| saved.selected`，runTurn 没有）。
 * 于是调用方不显式传适配器就静默降级到只产出占位符的本地骨架。
 *
 * 本测试不依赖网络与 Key：只验证「解析逻辑不会再悄悄掉到骨架」。
 */
const path = require('path');
process.env.RPG_DATA_DIR = path.join(__dirname, 'data');

const { resolveAdapter, loadAdapterConfig } = require('./adapters/index');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${extra ? '  → ' + extra : ''}`); } };

(async () => {
  console.log('\n[1] 适配器解析：不得悄悄掉到 skeleton');

  const cfg = await loadAdapterConfig().catch(() => ({ selected: '' }));
  console.log(`  · 当前选定适配器：${cfg.selected || '(未配置)'}`);

  // ① 不传 id（模拟调用方忘了带 adapterId）——应当用配置里选定的，而不是骨架
  const r1 = await resolveAdapter(undefined);
  ok('不传 id 时不会解析成本地骨架', r1.adapter.id !== 'skeleton', `实际得到：${r1.adapter.id}`);
  ok('不传 id 时得到的是配置里选定的适配器', !cfg.selected || r1.adapter.id === cfg.selected, `${r1.adapter.id} vs ${cfg.selected}`);

  // ② 显式传存在的 id —— 必须原样返回
  const want = cfg.selected || 'deepseek';
  const r2 = await resolveAdapter(want);
  ok(`显式指定「${want}」时返回它本人`, r2.adapter.id === want || !!(cfg.configs || {})[want] === false, `实际：${r2.adapter.id}`);

  // ③ 传一个不存在的 id —— 允许降级，但必须打标记，告知调用方降级了
  const r3 = await resolveAdapter('__不存在的适配器__');
  ok('请求不存在的适配器会降级（而不是崩掉）', !!r3.adapter);
  ok('降级发生在诊断得出 reconciled：要么拿到选定适配器，要么标了 degraded', r3.adapter.id === cfg.selected || r3.degraded === true, `得到 ${r3.adapter.id}, degraded=${r3.degraded}`);

  // ④ 显式要骨架时仍应给骨架（这是它唯一的合法用途：离线验证管线）
  const r4 = await resolveAdapter('skeleton');
  ok('显式指定 skeleton 时照给（用于离线验证管线）', r4.adapter.id === 'skeleton');

  console.log('\n[2] 骨架的占位符不得混进正式正文');
  const sk = await resolveAdapter('skeleton');
  const out = await sk.adapter.call({ system: '', prompt: '测试' }, sk.config);
  ok('骨架输出确实带占位符标识（便于识别）', /骨架输出/.test(String(out.text)));
  ok('正式回合路径默认不指向骨架', (await resolveAdapter(undefined)).adapter.id !== 'skeleton');

  console.log(`\n———— 适配器解析：${pass} 通过 / ${fail} 失败 ————`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自测崩溃：', e); process.exit(1); });
