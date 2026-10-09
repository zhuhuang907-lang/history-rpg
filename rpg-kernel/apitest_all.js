'use strict';
/**
 * 全接口巡检：把 59 个路由都真打一遍，报「能用 / 报错 / 返回空壳」。
 * 用户原话：「很多功能用不了……你就是在骗人啊，纯文字而已」。
 * 所以不是看代码猜，是起服务之后一个一个打。
 * 用法：先 `node server.js`，再 `node apitest_all.js`
 */
const BASE = 'http://127.0.0.1:8787';

async function call(method, path, body) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
    });
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* 非 JSON */ }
    return { status: res.status, json, text: txt.slice(0, 400), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, error: String(e && e.message || e), ms: Date.now() - t0 };
  }
}

/* 判定：返回是否「有实质内容」，还是空壳/报错 */
function verdict(r, expect) {
  if (r.status === 0) return ['FAIL', `网络不通：${r.error}`];
  if (r.status === 404) return ['FAIL', '404 没有这个路由'];
  if (r.status >= 500) return ['FAIL', `${r.status} ${String(r.json ? JSON.stringify(r.json) : r.text).slice(0, 120)}`];
  if (r.json && r.json.ok === false && r.json.why) return ['BLOCK', String(r.json.why).slice(0, 100)];
  if (expect && expect(r.json) === false) return ['EMPTY', '200 但返回的是空壳/缺关键字段'];
  return ['OK', ''];
}

const results = [];
async function probe(name, method, path, body, expect) {
  const r = await call(method, path, body);
  const [v, note] = verdict(r, expect);
  results.push({ name, path, v, note, ms: r.ms, sample: r.json != null ? JSON.stringify(r.json).slice(0, 160) : r.text.slice(0, 160) });
  console.log(`  ${v === 'OK' ? '✓' : v === 'BLOCK' ? '◐' : '✗'} [${v}] ${name}　${note}`);
  return r;
}

(async () => {
  console.log('—— 健康与静态 ——');
  await probe('健康', 'GET', '/api/health', null, j => j && j.ok === true);
  await probe('规则包', 'GET', '/api/rulepacks', null, j => Array.isArray(j) && j.length > 0);
  await probe('适配器列表', 'GET', '/api/adapters');
  await probe('检索后端列表', 'GET', '/api/search/providers');
  await probe('检索配置', 'GET', '/api/search/config');
  await probe('存档列表', 'GET', '/api/saves', null, j => Array.isArray(j));
  await probe('时代语汇', 'GET', '/api/era-vocab');
  await probe('战阵目录', 'GET', '/api/battle/catalog');
  await probe('史料库', 'GET', '/api/lore');
  await probe('适配器配置', 'GET', '/api/adapter-config');

  console.log('\n—— 建档与种子 ——');
  const mk = await probe('自定义建档', 'POST', '/api/save/custom', {
    ruleset: 'history-sim-v4', id: 'audit', title: '巡检测试档',
    era: { yearLabel: '太清二年', gregorianYear: 548, polity: '梁', month: 10, day: 24 },
    identityModule: 'noble',
    protagonist: { name: '萧纪', age: 41, gender: '男', role: '益州刺史' },
    location: { full: '成都', polity: '梁', controller: '梁' },
    mode: 'real',
  }, j => j && j.meta && j.meta.id);
  const SID = mk.json && mk.json.meta && mk.json.meta.id;
  console.log('  → saveId =', SID);
  await probe('读档', 'POST', '/api/state', { saveId: SID }, j => j && j.meta);
  await probe('开局生成世界（联网）', 'POST', '/api/world/seed', { saveId: SID }, j => j && j.state);
  await probe('档案馆', 'POST', '/api/archive', { saveId: SID });
  await probe('档案卡', 'POST', '/api/archive-card', { saveId: SID });
  await probe('世界面板', 'POST', '/api/world/panel', { saveId: SID }, j => j && j.sections);
  await probe('世界补全', 'POST', '/api/world/fill', { saveId: SID });
  await probe('世界更新', 'POST', '/api/world/update', { saveId: SID });
  await probe('旧档剧情重算', 'POST', '/api/world/replot', { saveId: SID });

  console.log('\n—— 人物核实 ——');
  await probe('全名籍体检', 'POST', '/api/world/figures', { saveId: SID }, j => j && typeof j.count === 'number');
  await probe('候选人物', 'POST', '/api/verify/candidates', { name: '萧纪', from: 450, to: 560 });
  await probe('核查真人', 'POST', '/api/verify/realperson', { name: '萧纪', year: 548 });
  await probe('核查NPC', 'POST', '/api/verify/npc', { saveId: SID, name: '萧纪' });
  await probe('核查人物（人物卡）', 'POST', '/api/verify/person', { name: '萧纪', year: 548 });
  await probe('核查地名', 'POST', '/api/verify/place', { place: '成都', year: 548 });
  await probe('核查词语', 'POST', '/api/verify/term', { term: '刺史', year: 548 });
  await probe('身份核定（联网）', 'POST', '/api/dossier/identify', { name: '萧纪', year: 548, polity: '梁' });
  await probe('核定写入档', 'POST', '/api/dossier/apply', { saveId: SID });
  await probe('核定状态', 'POST', '/api/dossier/state', { saveId: SID });
  // 用真实在册的 NPC（seed 之后世界里有历史人物）
  const st0 = await call('POST', '/api/state', { saveId: SID });
  const npcName = (((st0.json || {}).npcs || [])[0] || {}).name || '萧纪';
  console.log('  → 用作决策的 NPC：', npcName);
  await probe('NPC决策', 'POST', '/api/npc/decide', { saveId: SID, npcName, request: { gain: 0.3, cost: 0.6, risk: 0.7 } }, j => j && j.ok === true);

  console.log('\n—— 剧情系统 ——');
  await probe('剧情列表', 'POST', '/api/plot/list', { saveId: SID }, j => j && j.summary);
  await probe('剧情后台日志', 'POST', '/api/plot/audit', { saveId: SID }, j => typeof j.log === 'string');
  await probe('登记状态变化', 'POST', '/api/plot/effect', { saveId: SID, arcId: 'P999', 项: '粮', 变化: '-1 石', 由谁所致: '巡检', 依据: '测试' });

  console.log('\n—— 分歧与历史 ——');
  await probe('加史实锚点', 'POST', '/api/history/anchor', { saveId: SID, year: 548, text: '侯景围台城' });
  const cz = await probe('登记因果', 'POST', '/api/history/causal', { saveId: SID, cause: '放粮', effect: '粮价回落' });
  const chainId = cz.json && (cz.json.id || cz.json.chainId);
  await probe('反事实推演', 'POST', '/api/history/counterfactual', { saveId: SID, chainId, replaceWith: '不放粮' });

  console.log('\n—— 快照与回滚 ——');
  await probe('存快照', 'POST', '/api/snapshot/now', { saveId: SID });
  await probe('快照列表', 'POST', '/api/snapshot/list', { saveId: SID }, j => j && Array.isArray(j.list !== undefined ? j.list : j));
  await probe('修复计划', 'POST', '/api/snapshot/repair', { saveId: SID });
  await probe('影响分析', 'POST', '/api/snapshot/impact', { saveId: SID, code: 'P8-B01' });

  console.log('\n—— 纠正与人判 ——');
  await probe('加纠正', 'POST', '/api/correction', { saveId: SID, text: '刺史不是太守' });
  await probe('纠正列表', 'POST', '/api/correction/list', { saveId: SID });
  await probe('人判断勾', 'POST', '/api/human-check', { saveId: SID, checks: { history: 'bad' } });
  await probe('事件日志', 'POST', '/api/events/log', { saveId: SID });
  await probe('档案卡列表', 'POST', '/api/cards', { saveId: SID });

  console.log('\n—— 回合执行（真实 LLM，仅记录能否跑到适配器层） ——');
  const tr = await probe('跑一轮（需配 Key）', 'POST', '/api/turn', { saveId: SID, input: '开仓查账', verbosity: 'short' });
  await probe('采纳草稿（版本锁应拦过期）', 'POST', '/api/apply', { saveId: SID, draft: { baseTurn: -1, scene: '测试' }, advanceDays: 1 });

  console.log('\n—— 其余 ——');
  await probe('NPC 更新', 'POST', '/api/npc', { saveId: SID, name: '萧纪', fields: {} });
  await probe('线索更新', 'POST', '/api/thread', { saveId: SID, title: '查仓', status: 'open' });
  await probe('身份变更', 'POST', '/api/identity', { saveId: SID, identityModule: 'noble' });
  await probe('时代语汇转译', 'POST', '/api/era-vocab/translate', { text: '玉米和土豆', year: 548 });
  await probe('战阵模拟', 'POST', '/api/battle/simulate', { a: { troops: 1000 }, b: { troops: 800 } });
  await probe('史料库写', 'POST', '/api/lore', { saveId: SID, key: '测试', text: '测试' });
  await probe('适配器测试（无 Key 应如实报错）', 'POST', '/api/adapter-test', { adapterId: 'deepseek' });
  await probe('检索测试', 'POST', '/api/search/test', {});
  // 2026-10-08：这两条旧测试会把空配置写回磁盘（博查 Key 因此被清空过）。现在原样读出再原样写回，只测接口通不通
  {
    const curA = await fetch(BASE + '/api/adapter-config').then(r => r.json()).catch(() => null);
    await probe('存适配器配置（原样写回）', 'POST', '/api/adapter-config', { selected: curA && curA.selected, configs: {} });
    const curS = await fetch(BASE + '/api/search/config').then(r => r.json()).catch(() => null);
    await probe('存检索配置（原样写回）', 'POST', '/api/search/config', { config: curS || {} });
  }
  await probe('删档', 'POST', '/api/save/delete', { saveId: SID });

  console.log('\n================ 汇总 ================');
  const okN = results.filter(r => r.v === 'OK').length;
  const blockN = results.filter(r => r.v === 'BLOCK').length;
  const failN = results.filter(r => r.v === 'FAIL').length;
  const emptyN = results.filter(r => r.v === 'EMPTY').length;
  console.log(`OK ${okN} / BLOCK(设计内拦截) ${blockN} / EMPTY(空壳) ${emptyN} / FAIL ${failN}　共 ${results.length} 项`);
  if (failN + emptyN > 0) {
    console.log('\n—— 有问题的 ——');
    for (const r of results.filter(x => x.v === 'FAIL' || x.v === 'EMPTY')) {
      console.log(`  ✗ [${r.v}] ${r.name}（${r.path}）　${r.note}`);
      console.log(`      返回：${r.sample}`);
    }
  }
})();
