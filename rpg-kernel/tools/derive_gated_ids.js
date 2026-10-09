/**
 * 派生「需要载入存档才可用」的按钮 id 清单。
 * 做法：解析 on('#id', 函数名)，再看该函数体内是否含 !STATE 守卫；
 *       同时处理直接写成箭头函数、且函数体内含 !STATE 的情况。
 * 输出：给 human 看的结果 + 可直接粘进 app.js 的数组字面量。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appjs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// index.html 里真实存在的所有按钮 id（不在 HTML 里的 id 不管）
const htmlIds = new Set();
{
  const re = /<button([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const idm = m[1].match(/id\s*=\s*"([^"]+)"/);
    if (idm) htmlIds.add(idm[1]);
  }
}

// 抓取具名函数的函数体（朴素花括号配对）
function grabBody(src, braceIdx) {
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceIdx, i + 1); }
  }
  return '';
}

const namedBodies = new Map();
{
  const re = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(appjs))) {
    const body = grabBody(appjs, m.index + m[0].length - 1);
    if (!namedBodies.has(m[1])) namedBodies.set(m[1], body);
  }
}

const gated = new Map(); // id -> 证据
function note(id, why) {
  if (!gated.has(id)) gated.set(id, why);
}

// 1) on('#id', 函数名)
{
  const re = /\bon\(\s*['"]#([A-Za-z0-9_\-]+)['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let m;
  while ((m = re.exec(appjs))) {
    const [, id, fn] = m;
    const body = namedBodies.get(fn) || '';
    if (/!\s*STATE/.test(body)) note(id, `处理函数 ${fn}() 内含 !STATE 守卫`);
  }
}

// 2) $('#id').onclick = 函数名   /   $('#id').onclick = async () => { ... }
{
  const re = /\$\(\s*['"]#([A-Za-z0-9_\-]+)['"]\s*\)\s*\.\s*onclick\s*=\s*([\s\S]{0,400}?);/g;
  let m;
  while ((m = re.exec(appjs))) {
    const [, id, rhs] = m;
    const asFn = rhs.match(/^([A-Za-z_$][\w$]*)$/);
    if (asFn) {
      const body = namedBodies.get(asFn[1]) || '';
      if (/!\s*STATE/.test(body)) note(id, `处理函数 ${asFn[1]}() 内含 !STATE 守卫`);
    } else if (/!\s*STATE/.test(rhs)) {
      note(id, '内联箭头函数内直接有 !STATE 守卫');
    }
  }
}

// 3) getElementById('id') 后再赋 onclick 的（含循环动态绑定）
{
  const blocks = appjs.split('\n');
  blocks.forEach((line, i) => {
    const idm = line.match(/getElementById\(\s*['"]([A-Za-z0-9_\-]+)['"]\s*\)/);
    if (!idm) return;
    // 往后看 6 行内是否出现 onclick 且该片段含 !STATE
    const ctx = blocks.slice(i, i + 6).join('\n');
    if (/onclick/.test(ctx) && /!\s*STATE/.test(ctx)) note(idm[1], 'getElementById 后绑定的处理含 !STATE 守卫');
  });
}

// 4) 类名批量绑定且含 !STATE（如 .flagbtn）
const classGated = [];
{
  const re = /querySelectorAll\(\s*['"]\.([A-Za-z0-9_\-]+)['"]\s*\)([\s\S]{0,300}?);/g;
  let m;
  while ((m = re.exec(appjs))) {
    if (/!\s*STATE/.test(m[2])) classGated.push(m[1]);
  }
}

const onlyInHtml = [...gated.keys()].filter((id) => htmlIds.has(id));
const notInHtml = [...gated.keys()].filter((id) => !htmlIds.has(id));

console.log('=== 需要「已载入存档」的按钮（且 index.html 里确实存在）===');
onlyInHtml.sort().forEach((id) => console.log(`  #${id}  — ${gated.get(id)}`));
console.log(`\n小计：${onlyInHtml.length} 个`);
if (notInHtml.length) {
  console.log('\n=== 命中但 index.html 中不存在的 id（忽略）===');
  notInHtml.forEach((id) => console.log(`  #${id}`));
}
if (classGated.length) {
  console.log('\n=== 按类名批量绑定、同样需要存档的 ===');
  classGated.forEach((c) => console.log(`  .${c}`));
}

console.log('\n=== 可直接粘进 app.js 的数组 ===');
console.log("const GATED_SAVE_IDS = ['" + onlyInHtml.join("', '") + "'];");
if (classGated.length) {
  console.log("const GATED_SAVE_CLASSES = ['" + classGated.join("', '") + "'];");
}
