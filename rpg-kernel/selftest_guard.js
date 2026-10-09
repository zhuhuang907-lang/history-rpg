'use strict';
/** 大模型护栏自测：熔断、退避重试、JSON 修复、缓存（不联网，用假适配器） */
const { guard, stats } = require('./adapters/guard');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

(async () => {
  // 1) 401 熔断：第二次调用不再真的发请求
  let hits = 0;
  const bad = guard({ id: 'fake401', kind: 'llm', call: async () => { hits++; throw new Error('HTTP 401 Unauthorized :: bad key'); } });
  try { await bad.call({ system: 's', prompt: 'p' }, {}); } catch (_) {}
  try { await bad.call({ system: 's', prompt: 'p' }, {}); } catch (e) { ok(/暂停调用/.test(e.message), '401 后熔断，提示去核对 Key'); }
  ok(hits === 1, `401 不重试、熔断后不再请求（实际请求 ${hits} 次）`);
  // 测试连接绕过熔断
  try { await bad.call({ system: 's', prompt: 'p' }, { __noBreaker: true }); } catch (_) {}
  ok(hits === 2, '「测试连接」可绕过熔断');

  // 2) 503 退避后成功
  let n = 0;
  const flaky = guard({ id: 'flaky', kind: 'llm', call: async () => { if (n++ < 1) throw new Error('HTTP 503 busy retry-after 0'); return { text: '正文', meta: {} }; } });
  const r = await flaky.call({ system: 's', prompt: 'p' }, {});
  ok(r.text === '正文' && n === 2, '503 退避重试后成功');

  // 3) JSON：围栏 + 尾逗号自动修复；修不好时请模型自修一次
  const fenced = guard({ id: 'fenced', kind: 'llm', call: async () => ({ text: '<think>想一想</think>好的：```json\n{"scene":"甲",}\n```', meta: {} }) });
  const j = await fenced.call({ system: '只输出 JSON。', prompt: 'x' }, {});
  ok(JSON.parse(j.text).scene === '甲', '围栏、思考段、尾逗号被清理成合法 JSON');
  let calls = 0;
  const broken = guard({ id: 'broken', kind: 'llm', call: async p => { calls++; return { text: p.__repair ? '{"scene":"修好了"}' : '场景：乙（没有给 JSON）', meta: {} }; } });
  const k = await broken.call({ system: '只输出 JSON。', prompt: 'y' }, {});
  ok(JSON.parse(k.text).scene === '修好了' && calls === 2, '模型自修一次成功');

  // 4) 抽取类调用缓存；正文类（高温）不缓存
  let c2 = 0;
  const cnt = guard({ id: 'cnt', kind: 'llm', call: async () => { c2++; return { text: '{"a":1}', meta: {} }; } });
  await cnt.call({ system: '只输出 JSON。', prompt: 'z' }, {});
  await cnt.call({ system: '只输出 JSON。', prompt: 'z' }, {});
  await cnt.call({ system: '写正文', prompt: 'z', temperature: 0.9 }, {});
  await cnt.call({ system: '写正文', prompt: 'z', temperature: 0.9 }, {});
  ok(c2 === 3, `抽取类命中缓存、正文类不缓存（实际请求 ${c2} 次）`);
  ok(stats().fake401.breaker.open === true, '统计里能看到熔断状态');
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
