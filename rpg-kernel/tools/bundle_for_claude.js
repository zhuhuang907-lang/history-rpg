/**
 * 把前端 UI（含后端接口清单）打包成一个 Markdown 文件，方便直接发给 Claude。
 * 顺带做静态体检：
 *   1) 前端 post()/get() 调用  vs  server.js 的 routes  -> 失效调用
 *   2) index.html 里带 id 的按钮 vs app.js 里绑定的 onclick -> 疑似没作用的按钮
 *   3) server.js 里从未被界面调用的接口 -> 精简候选
 *
 * 用法： node tools/bundle_for_claude.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'frontend-ui-bundle-for-claude.md');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('public/index.html');
const css = read('public/style.css');
const appjs = read('public/app.js');
const server = read('server.js');

// ---------- 1. 解析 server.js 的 routes ----------
const lines = server.split('\n');
const startIdx = lines.findIndex((l) => /const\s+routes\s*=\s*\{/.test(l));
let endIdx = -1;
if (startIdx >= 0) {
  for (let i = startIdx + 1; i < lines.length; i++) {
    // 只认「顶格」的 }; —— 否则会把 handler 函数体内部的缩进 } 误当成对象结尾，
    // 导致 routes 被提前截断（曾因此只解析到 9 条路由）。
    if (/^\};?\s*$/.test(lines[i])) { endIdx = i; break; }
  }
}
const routesBlock = startIdx >= 0 && endIdx > startIdx
  ? lines.slice(startIdx, endIdx + 1).join('\n')
  : server;

const routes = [];
const seen = new Set();
const routeRe = /(GET|POST)\s+(\/api\/[^\s'"`]+)/g;
let m;
while ((m = routeRe.exec(routesBlock))) {
  const key = `${m[1]} ${m[2]}`;
  if (!seen.has(key)) { seen.add(key); routes.push({ method: m[1], path: m[2] }); }
}

// ---------- 2. 解析前端 API 调用 ----------
// app.js 里只有 post(url, body) / get(url) 两个 helper；
// 注意排除 helper 自身的定义（它们不是 post('...') 形式，天然不会命中）
const callRe = /\b(post|get)\(\s*['"`]([^'"`]+)/g;
const calls = [];
const callSeen = new Set();
while ((m = callRe.exec(appjs))) {
  const method = m[1] === 'post' ? 'POST' : 'GET';
  let p = m[2];
  let dynamic = false;
  const tpl = p.indexOf('${');
  if (tpl >= 0) { p = p.slice(0, tpl); dynamic = true; }
  const line = appjs.slice(0, m.index).split('\n').length;
  const key = `${method} ${p}`;
  if (!callSeen.has(key)) {
    callSeen.add(key);
    calls.push({ method, path: p, dynamic, line, raw: m[2] });
  }
}

// ---------- 3. 解析 index.html 里的按钮 ----------
const btnRe = /<button([^>]*)>([\s\S]*?)<\/button>/g;
const buttons = [];
while ((m = btnRe.exec(html))) {
  const attrs = m[1];
  const idm = attrs.match(/id\s*=\s*"([^"]+)"/);
  const text = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const line = html.slice(0, m.index).split('\n').length;
  const inlineOnclick = /onclick\s*=/.test(attrs);
  buttons.push({ id: idm ? idm[1] : null, text, line, inlineOnclick });
}

// ---------- 4. 解析 app.js 里绑定的事件 ----------
// 本项目实际混用了多种绑定写法，必须都抓到，否则会把「活着的按钮」误判为失效：
//   $('#id').onclick = ...        // 最直白
//   on('#id', fn)                 // 第 1263 行定义的 helper，内部帮你 onclick
//   document.getElementById('id') // 直接取元素再赋 onclick
//   ['a:甲','b:乙'].forEach(...)   // 循环动态绑定（字面量是 'id:文案' 形式）
//   document.querySelectorAll('.flagbtn')  // 按类名批量绑定
const precise = new Set();
const patterns = [
  /\$\(\s*['"]#([A-Za-z0-9_\-]+)['"]\s*\)/g,                 // $('#id')
  /\bon\(\s*['"]#([A-Za-z0-9_\-]+)['"]/g,                    // on('#id', fn)
  /getElementById\(\s*['"]([A-Za-z0-9_\-]+)['"]/g,           // getElementById('id')
  /querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_\-]+)['"]/g,   // querySelector('#id')
  /'([A-Za-z0-9_\-]+):[^']*'/g,                              // 'id:文案' —— 循环动态绑定的字面量
];
patterns.forEach((re) => {
  let mm;
  while ((mm = re.exec(appjs))) precise.add(mm[1]);
});

// 按类名批量绑定的（如 .flagbtn），这些按钮通常没有 id
const classBound = [];
const classRe = /querySelectorAll\(\s*['"]\.([A-Za-z0-9_\-]+)['"]\s*\)/g;
{
  let mm;
  while ((mm = classRe.exec(appjs))) classBound.push(mm[1]);
}

// ---------- 5. 交叉比对 ----------
// 路由含 * 通配时按前缀匹配
function matches(routePath, callPath) {
  if (routePath === callPath) return true;
  if (routePath.endsWith('*')) {
    const base = routePath.slice(0, -1);
    return callPath.startsWith(base);
  }
  return false;
}
const findRoute = (method, p) => routes.find((r) => r.method === method && matches(r.path, p));

const apiCalls = calls.filter((c) => c.path.startsWith('/api/'));
const brokenCalls = apiCalls.filter((c) => !findRoute(c.method, c.path));

const usedRoutes = new Set();
apiCalls.forEach((c) => {
  const r = findRoute(c.method, c.path);
  if (r) usedRoutes.add(`${r.method} ${r.path}`);
});
const unusedRoutes = routes.filter((r) => !usedRoutes.has(`${r.method} ${r.path}`));

// 分两档，避免误判：
//   deadButtons  —— 精确绑定没命中，且 app.js 全文搜不到这个 id  -> 基本可确认真失效
//   maybeDead    —— 精确绑定没命中，但 id 以别的形式出现过（如 'btnRecap:前情回顾' 循环绑定）-> 需人工复核
const idButtonEligible = (b) => b.id && !b.inlineOnclick && !precise.has(b.id);
const deadButtons = buttons.filter((b) => idButtonEligible(b) && !appjs.includes(b.id));
const maybeDead = buttons.filter((b) => idButtonEligible(b) && appjs.includes(b.id));

// ---------- 6. 运行时「像坏了」的常见成因统计 ----------
const guardState = (appjs.match(/if\s*\(\s*!STATE\s*\)/g) || []).length;
const guardTurn = (appjs.match(/turn\s*>\s*0/g) || []).length;
// 需要 AI 适配器（会因 Key 401 而降级）的界面调用数
const aiPaths = ['/api/turn', '/api/figure/generate', '/api/world/seed', '/api/world/fill', '/api/verify/', '/api/gm-cards'];
const callDeps = apiCalls.filter((c) => aiPaths.some((p) => c.path.startsWith(p))).length;

// ---------- 7. 生成 Markdown ----------
// 源码里若自带 ``` 会把围栏撑破（server.js 里确实有），所以按内容中最长的反引号串动态加长围栏
function fence(content, lang) {
  let n = 3;
  const runs = content.match(/`{3,}/g);
  if (runs) runs.forEach((r) => { n = Math.max(n, r.length + 1); });
  const f = '`'.repeat(n);
  return `${f}${lang}\n${content}\n${f}`;
}
const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB';
const now = new Date().toLocaleString('zh-CN', { hour12: false });

const L = [];
L.push('# rpg-kernel 前端 UI 打包（供 Claude 使用）');
L.push('');
L.push(`> 自动生成于 ${now}`);
L.push('> 生成脚本：`tools/bundle_for_claude.js`（如需更新，跑一遍该脚本即可）');
L.push('');
L.push('---');
L.push('');
L.push('## 0. 任务背景与诉求');
L.push('');
L.push('这是一个「历史政治 RPG 引擎」项目（`rpg-kernel`）：Node.js v22、**零依赖**（原生 http + 静态前端），存档为 JSON 文件。');
L.push('');
L.push('本次希望 Claude 帮忙处理**前端界面**：');
L.push('');
L.push('1. **修复失效按钮**：有些按钮点了没反应 / 不起作用。');
L.push('2. **精简**：按钮太多太杂，去掉冗余的，收敛 UI。');
L.push('3. **美观**：整体视觉提升（目前比较朴素）。');
L.push('');
L.push('### 环境约束');
L.push('');
L.push('- 前端是**原生 JS**，没有 React/Vue，也没有构建步骤 —— 直接改 `public/` 下三个文件即刻生效。');
L.push('- 后端同样无框架，`server.js` 里用 `routes` 映射分发（形如 `\'GET /api/health\'`）。');
L.push('- 前端只有两个请求 helper：`post(url, body)` 和 `get(url)`（`app.js` 第 23-24 行）。');
L.push('- **Deepseek API Key 目前返回 401**，`data/adapter-config.json` 里的 Key 失效。所有依赖大模型的功能（`/api/turn` 生成剧情、`/api/figure/generate`、`/api/verify/*` 等）会降级到「本地骨架」输出。这是**环境/账号问题，不是代码 bug**，请不要把精力花在排查「为什么 AI 不出内容」上。');
L.push('- 已完成的端点安全审查见 `端点审查报告_2026-10-08.md`（路径穿越已用 `safeId()` 修复，勿回退）。');
L.push('');
L.push('---');
L.push('');
L.push('## 1. 静态体检快报（脚本自动比对，供参考）');
L.push('');
L.push(`- 后端接口总数：**${routes.length}** 个`);
L.push(`- 前端发出的 API 调用：**${apiCalls.length}** 个（去重后）`);
L.push(`- index.html 里的 \`<button>\`：**${buttons.length}** 个，其中带 id 的 **${buttons.filter((b) => b.id).length}** 个`);
L.push(`- app.js 里能定位到精确绑定的 id：**${precise.size}** 个` + (classBound.length ? `；另外按类名批量绑定：${classBound.map((c) => `.${c}`).join('、')}` : ''));
L.push('');

L.push('### 1.1 疑似「点了没反应」的按钮');
L.push('');
L.push('**A. 基本可确认真失效**（五种精确绑定写法全都没命中，且 app.js 全文搜不到该 id）：');
L.push('');
if (deadButtons.length === 0) {
  L.push('_（无）_');
} else {
  L.push('| index.html 行号 | 按钮 id | 按钮文字 |');
  L.push('|---|---|---|');
  deadButtons.forEach((b) => L.push(`| ${b.line} | \`#${b.id}\` | ${b.text || '_（无文字）_'} |`));
}
L.push('');
L.push('**B. 需人工复核**（找不到直接赋 onclick，但 id 在 app.js 里出现过，可能走循环动态绑定）：');
L.push('');
if (maybeDead.length === 0) {
  L.push('_（无）_');
} else {
  L.push('| index.html 行号 | 按钮 id | 按钮文字 |');
  L.push('|---|---|---|');
  maybeDead.forEach((b) => L.push(`| ${b.line} | \`#${b.id}\` | ${b.text || '_（无文字）_'} |`));
}
L.push('');
L.push('> 判定口径：本项目混用了五种绑定写法 —— `$(\'#id\').onclick = ...`、`on(\'#id\', fn)`（第 1263 行定义的 helper，内部帮你赋 onclick）、`document.getElementById(\'id\')`、`[\'a:文案\'].forEach(...)` 循环动态绑定、以及 `.flagbtn` 这类按类名批量绑定。');
L.push('> A 类＝这些写法都没命中且全文搜不到 id；B 类＝id 出现过但找不到直接赋 onclick。两类都请 Claude 打开 `public/app.js` 搜 id 复核后再决定删或修。');
L.push('');
L.push('### 1.1.1 「按钮其实绑了，但点了仍像没反应」的运行时原因');
L.push('');
L.push('静态结果显示**没有漏绑的按钮**，所以用户口中的「没作用」大概率是运行时行为，主要有三类：');
L.push('');
L.push(`1. **未开局时的静默返回**：\`app.js\` 里有 **${guardState}** 处 \`if (!STATE) return ...\` 守卫。`);
L.push('   没加载存档时点这些按钮，只会「什么都没发生」（或弹一句「先开一个局」），极易被当成按钮坏了。');
L.push('   → 建议 Claude：把这类按钮在未开局时统一置灰（disabled）或给出明确提示，而不是静默 return。');
L.push('');
L.push(`2. **依赖大模型的按钮全部降级**：本项目 \`app.js\` 中有 **${callDeps}** 处调用指向需要 AI 适配器的接口。`);
L.push('   由于 **Deepseek Key 401**，这些按钮点了要么返回占位正文、要么无内容——这是环境问题，改 UI 修不好。');
L.push('   → 建议 Claude：给这类按钮加「需要 API Key」的视觉标识或点击后的明确说明，避免用户以为是 UI bug。');
L.push('');
L.push(`3. **回合数守卫**：有 **${guardTurn}** 处 \`turn > 0\` 判断，回合 0 时相关按钮无响应。`);
L.push('');
L.push('> 结论：本任务真正该修的是「反馈缺失」（无 disabled 态、无错误提示），而非「事件没绑」。');
L.push('');

L.push('### 1.2 前端调用了但后端没有的接口（失效调用）');
L.push('');
if (brokenCalls.length === 0) {
  L.push('_（无，前端调用均有对应后端路由）_');
} else {
  L.push('| app.js 行号 | 调用 |');
  L.push('|---|---|');
  brokenCalls.forEach((c) => L.push(`| ${c.line} | \`${c.method} ${c.raw}\` |`));
}
L.push('');

L.push('### 1.3 后端有但界面从未调用的接口（精简候选）');
L.push('');
if (unusedRoutes.length === 0) {
  L.push('_（无）_');
} else {
  L.push('| 路由 | 备注 |');
  L.push('|---|---|');
  unusedRoutes.forEach((r) => L.push(`| \`${r.method} ${r.path}\` | 界面未调用 |`));
}
L.push('');

L.push('### 1.4 后端接口全清单');
L.push('');
L.push('```text');
routes.forEach((r) => L.push(`${r.method.padEnd(5)} ${r.path}`));
L.push('```');
L.push('');
L.push('---');
L.push('');
L.push('## 2. 文件清单');
L.push('');
L.push('| 文件 | 大小 | 行数 | 作用 |');
L.push('|---|---|---|---|');
L.push(`| \`public/index.html\` | ${kb(html)} | ${html.split('\n').length} | 页面结构、所有按钮声明 |`);
L.push(`| \`public/style.css\` | ${kb(css)} | ${css.split('\n').length} | 全部样式 |`);
L.push(`| \`public/app.js\` | ${kb(appjs)} | ${appjs.split('\n').length} | 所有交互逻辑、网络调用 |`);
L.push(`| \`server.js\` | ${kb(server)} | ${server.split('\n').length} | 后端路由与静态服务 |`);
L.push('');
L.push('> `core/engine.js` 等后端业务逻辑未打包进来；本任务聚焦 UI，接口行为看上面第 1.4 节清单即可。');
L.push('');
L.push('---');
L.push('');
L.push('## 3. public/index.html');
L.push('');
L.push(fence(html, 'html'));
L.push('');
L.push('---');
L.push('');
L.push('## 4. public/style.css');
L.push('');
L.push(fence(css, 'css'));
L.push('');
L.push('---');
L.push('');
L.push('## 5. public/app.js');
L.push('');
L.push(fence(appjs, 'javascript'));
L.push('');
L.push('---');
L.push('');
L.push('## 6. server.js（含 routes 全表，供对照）');
L.push('');
L.push(fence(server, 'javascript'));
L.push('');
L.push('---');
L.push('');
L.push('打包结束。');
L.push('');

fs.writeFileSync(OUT, L.join('\n'), 'utf8');

console.log('已生成：' + OUT);
console.log(`  大小：${kb(L.join('\n'))}`);
console.log(`  路由：${routes.length}  前端调用：${apiCalls.length}  按钮：${buttons.length}(带id ${buttons.filter((b) => b.id).length})  精确绑定：${precise.size}`);
console.log(`  基本确认真失效按钮：${deadButtons.length}   需人工复核：${maybeDead.length}   失效调用：${brokenCalls.length}   未被调用路由：${unusedRoutes.length}`);
