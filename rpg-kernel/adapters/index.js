'use strict';
/**
 * 适配器层：把「调用某个框架」抽象成一个统一合约。
 *
 *   call({ system, prompt, temperature, maxTokens }, config) -> { text, raw, meta }
 *
 * 引擎只知道这个合约，不知道背后是 OpenAI、Anthropic、本地 Ollama、
 * 一个 Python 脚本、还是一个 MCP server。
 *
 * 新增外部框架有两种方式：
 *   1) 在 data/adapters/ 丢一个 manifest json（不需要改代码）
 *   2) 在 BUILTIN 里加一个对象实现 call()
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const ADAPTER_DIR = path.join(__dirname, '..', 'data', 'adapters');
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'adapter-config.json');

/** 叙事适配器的配置落盘：换电脑/清浏览器缓存/换浏览器都不会丢，双击就能直接用 */
// 2026-10-08 加固（与检索配置同一类事故：博查 Key 被清空）：
//   读：去 BOM；文件存在却读不懂时标记 broken，保存时拒绝写入，免得用空配置冲掉 Key。
//   写：逐个适配器、逐字段合并；空串不覆盖已有的 Key。
function readAdapterFile() {
  try { return { cfg: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '')) }; }
  catch (e) { return { cfg: { selected: null, configs: {} }, broken: !(e && e.code === 'ENOENT') }; }
}
async function loadAdapterConfig() {
  return readAdapterFile().cfg;
}
async function saveAdapterConfig({ selected, configs }) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const { cfg: cur, broken } = readAdapterFile();
  if (broken) {
    try { fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + `.unreadable-${Date.now()}.bak`); } catch { /* 忽略 */ }
    throw new Error('模型配置文件读不懂，已另存备份；为防丢失 Key，本次不写入，请检查 data/adapter-config.json');
  }
  const merged = { ...(cur.configs || {}) };
  for (const [id, c] of Object.entries(configs || {})) {
    const m = { ...(merged[id] || {}) };
    for (const [k, v] of Object.entries(c || {})) if (v !== '' && v != null) m[k] = v;
    merged[id] = m;
  }
  const next = {
    selected: selected === undefined ? cur.selected : selected,
    configs: merged,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

async function httpJson(url, { method = 'POST', headers = {}, body, timeoutMs = 120000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${raw.slice(0, 400)}`);
  let json = null;
  try { json = JSON.parse(raw); } catch { /* 非 JSON 响应按纯文本处理 */ }
  return { json, raw };
}

/* ------------------------------------------------------------------ */
/* 内置适配器                                                          */
/* ------------------------------------------------------------------ */

// 离线骨架：不联网、不生成叙事，只用于验证引擎管线。诚实标明。
const skeleton = {
  id: 'skeleton',
  displayName: '本地骨架（离线，不生成叙事）',
  kind: 'local',
  builtin: true,
  needsKey: false,
  describe: () => '不调用任何外部框架。返回结构完整的空壳结果，用于验证管线与审查器是否工作。',
  async call({ prompt }) {
    const text = JSON.stringify({
      scene: '【骨架输出】此处本应由外部框架生成正文。当前未接入任何叙事框架。\n\n场景停在「' +
        (String(prompt).split('\n').find(l => l.includes('玩家本回合输入')) || '').slice(0, 60) + '」之后，等待玩家决定。',
      worldNote: '',
      newNpcs: [],
      touchedThreads: [],
      pendingDecision: '「用户决定」',
    }, null, 2);
    return { text, raw: text, meta: { adapter: 'skeleton', note: '离线骨架，非真实叙事' } };
  },
};

/* 假文适配器：**专为自检审计管线**。
   不调任何外部框架，按 MOCK_SCENE（环境变量）或默认埋雷文本返回正文，
   用来验证十遍扫描 P0–P15 是不是真的在跑、拦不拦得住。
   默认文本里故意埋了：替玩家决定、擅自连续行动、无来源的账、NPC 无条件答应、
   推翻史实锚点、时代错置、数量超承载力、重大后果零延迟。 */
const mockText = {
  id: 'mock',
  displayName: '本地假文（离线自检审计用）',
  kind: 'local',
  builtin: true,
  experimental: true,
  needsKey: false,
  describe: () => '返回一段故意埋了错的固定正文，用来检查审计各遍是否真的会拦。不用于正式游玩。',
  async call({ prompt }) {
    const scene = process.env.MOCK_SCENE || [
      '你打定主意，明日亲自去江都查账，随即翻开账册核对数目。',
      '你拱手道："此事全凭大人做主。"',
      '蒋文举道："遵命，我这就去办。"',
      '城中设内阁，巡抚到任。皇帝已崩。',
      '他调集五千兵马，征发三千民夫，得钱八百贯。',
      '朝廷下诏彻查扬州财赋。',
    ].join('\n');
    const text = JSON.stringify({
      scene: scene + '\n\n（以上为假文，等待玩家决定。）',
      worldNote: '', newNpcs: [], touchedThreads: [], pendingDecision: '「用户决定」',
    }, null, 2);
    // 构思阶段不要返回正文，否则"先想后写"第二步会把正文当构思
    if (String(prompt).includes('先想，不要写正文')) {
      return {
        text: '{"世界自行推进":"米价微涨","玩家指令的直接结果":["账册取到"],"NPC反应":[{"人":"蒋文举","他知道什么":"账目有缺","他想要什么":"把账做平","他害怕什么":"被查出","他会怎么做":"拖延"}],"状态变化":[{"项":"粮","前":"100","后":"95","来源":"日常支用"}],"信息传播":[],"停在哪里":"等你决定要不要追查","自检":{"是否替玩家做了决定":"否","有没有未卜先知":"否","数字有没有出处":"有","有没有把推测写成事实":"否"}}',
        raw: '', meta: { adapter: 'mock' },
      };
    }
    return { text, raw: text, meta: { adapter: 'mock', note: '假文，仅供审计自检' } };
  },
};

// OpenAI 兼容层：覆盖 OpenAI / DeepSeek / Qwen / Moonshot / vLLM / LM Studio / Ollama(兼容端点)
// 注意：DeepSeek-R1（deepseek-reasoner）不接受 temperature/top_p 一类的采样参数，传了会被拒，所以按模型名跳过。
async function openaiChat({ system, prompt, temperature, maxTokens }, cfg) {
  const base = trimSlash(cfg.baseUrl || 'https://api.openai.com/v1');
  const model = cfg.model || 'gpt-4o-mini';
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    max_tokens: maxTokens ?? 3000,
    stream: false,
  };
  if (!/reasoner|r1/i.test(model)) body.temperature = temperature ?? 0.9;
  const { json } = await httpJson(`${base}/chat/completions`, {
    headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    body,
    timeoutMs: cfg.timeoutMs || 180000,
  });
  const text = json?.choices?.[0]?.message?.content ?? '';
  return { text, raw: JSON.stringify(json), meta: { adapter: 'openai-compatible', model, usage: json?.usage } };
}

const openaiCompatible = {
  id: 'openai-compatible',
  displayName: 'OpenAI 兼容接口',
  kind: 'llm',
  builtin: true,
  needsKey: true,
  fields: [
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1', def: 'https://api.openai.com/v1' },
    { key: 'apiKey', label: 'API Key', placeholder: 'sk-...', secret: true },
    { key: 'model', label: 'Model', placeholder: 'gpt-4o-mini', def: 'gpt-4o-mini' },
  ],
  describe: () => '调用任何实现了 /chat/completions 的框架：OpenAI、DeepSeek、通义、Moonshot、vLLM、LM Studio、Ollama 的兼容层。',
  call: openaiChat,
};

const deepseek = {
  id: 'deepseek',
  displayName: 'DeepSeek（deepseek-chat / deepseek-reasoner）',
  kind: 'llm',
  builtin: true,
  needsKey: true,
  fields: [
    { key: 'apiKey', label: 'API Key', placeholder: 'sk-...', secret: true },
    { key: 'model', label: 'Model', placeholder: 'deepseek-chat', def: 'deepseek-chat' },
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.deepseek.com', def: 'https://api.deepseek.com' },
  ],
  describe: () => '调用 DeepSeek 官方 endpoint（https://api.deepseek.com/chat/completions）。填 deepseek-chat（V3，快，适合正文）或 deepseek-reasoner（R1，慢但推理强，适合当第二个核查模型）。R1 不接受 temperature，引擎会自动跳过该参数。',
  async call(params, cfg) {
    return openaiChat(params, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', ...cfg });
  },
};

const ollama = {
  id: 'ollama',
  displayName: 'Ollama（本地模型）',
  kind: 'llm',
  builtin: true,
  needsKey: false,
  fields: [
    { key: 'baseUrl', label: 'Ollama 地址', placeholder: 'http://127.0.0.1:11434', def: 'http://127.0.0.1:11434' },
    { key: 'model', label: 'Model', placeholder: 'qwen2.5:14b', def: 'qwen2.5:14b' },
  ],
  describe: () => '调用本机 Ollama 的 /api/chat。完全离线，不依赖任何云厂商。',
  async call({ system, prompt, temperature, maxTokens }, cfg) {
    const base = trimSlash(cfg.baseUrl || 'http://127.0.0.1:11434');
    const { json } = await httpJson(`${base}/api/chat`, {
      body: {
        model: cfg.model || 'qwen2.5:14b',
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        stream: false,
        options: { temperature: temperature ?? 0.9, num_predict: maxTokens ?? 3000 },
      },
      timeoutMs: cfg.timeoutMs || 300000,
    });
    const text = json?.message?.content ?? json?.response ?? '';
    return { text, raw: JSON.stringify(json), meta: { adapter: 'ollama', model: cfg.model } };
  },
};

const anthropic = {
  id: 'anthropic',
  displayName: 'Anthropic Messages API',
  kind: 'llm',
  builtin: true,
  needsKey: true,
  fields: [
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.anthropic.com', def: 'https://api.anthropic.com' },
    { key: 'apiKey', label: 'API Key', placeholder: 'sk-ant-...', secret: true },
    { key: 'model', label: 'Model', placeholder: 'claude-sonnet-4-5', def: 'claude-sonnet-4-5' },
  ],
  describe: () => '原生 /v1/messages 协议。注意 system 需放在顶层 system 字段，这是 Anthropic 与 OpenAI 的主要差异。',
  async call({ system, prompt, temperature, maxTokens }, cfg) {
    const base = trimSlash(cfg.baseUrl || 'https://api.anthropic.com');
    const { json } = await httpJson(`${base}/v1/messages`, {
      headers: {
        'x-api-key': cfg.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: cfg.model || 'claude-sonnet-4-5',
        max_tokens: maxTokens ?? 3000,
        temperature: temperature ?? 0.9,
        system: [{ type: 'text', text: system }],
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      },
      timeoutMs: cfg.timeoutMs || 180000,
    });
    const text = (json?.content || []).map(b => b.text || '').join('\n');
    return { text, raw: JSON.stringify(json), meta: { adapter: 'anthropic', model: cfg.model, usage: json?.usage } };
  },
};

const httpJsonBridge = {
  id: 'http-json',
  displayName: '任意 HTTP JSON 框架（Webhook / 自建服务）',
  kind: 'bridge',
  builtin: true,
  needsKey: false,
  fields: [
    { key: 'url', label: 'Endpoint', placeholder: 'http://127.0.0.1:8000/gm', def: '' },
    { key: 'apiKey', label: 'Bearer（可空）', placeholder: '可选', secret: true },
  ],
  describe: () => '把 {system, prompt, state} POST 给任意服务，读取其 JSON 里的 text 字段。这是接进自研框架最省事的一条路。',
  async call({ system, prompt }, cfg) {
    if (!cfg.url) throw new Error('未配置 Endpoint');
    const headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
    const { json, raw } = await httpJson(cfg.url, { body: { system, prompt }, headers, timeoutMs: cfg.timeoutMs || 180000 });
    const text = json?.text ?? json?.content ?? json?.choices?.[0]?.message?.content ?? raw;
    return { text: String(text), raw, meta: { adapter: 'http-json', url: cfg.url } };
  },
};

async function runChild(cmd, args, payload, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...(env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { if (!done) { done = true; p.kill(); reject(new Error('子进程超时')); } }, 300000);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    p.on('close', code => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code !== 0) return reject(new Error(`exit ${code} :: ${err.slice(0, 500)}`));
      let json = null;
      try { json = JSON.parse(out); } catch { /* 原样返回 stdout */ }
      resolve({ text: json?.text ?? out, raw: out, meta: { adapter: 'python-subprocess', stderr: err.slice(0, 300) } });
    });
    p.stdin.write(JSON.stringify(payload));
    p.stdin.end();
  });
}

const pythonBridge = {
  id: 'python-subprocess',
  displayName: 'Python 子进程（接 numpy / langchain / 自研规则引擎）',
  kind: 'bridge',
  builtin: true,
  needsKey: false,
  fields: [
    { key: 'command', label: '命令', placeholder: 'python', def: 'python' },
    { key: 'script', label: '脚本路径', placeholder: 'D:/myframework/gm.py', def: '' },
  ],
  describe: () => 'spawn 一个进程，stdin 写入 JSON，读 stdout 的 JSON。任何语言写的框架都能这样挂进来（换成 node/java 同理）。',
  async call({ system, prompt }, cfg) {
    if (!cfg.script) throw new Error('未配置脚本路径');
    return runChild(cfg.command || 'python', [cfg.script], { system, prompt });
  },
};

// MCP：通过 stdio 走 JSON-RPC，把外部 MCP server 的 tool 当叙事后端。
// 说明：initialize → tools/call，取回结果里的 text 内容。
const mcpStdio = {
  id: 'mcp-stdio',
  displayName: 'MCP Server（stdio JSON-RPC）',
  kind: 'mcp',
  builtin: true,
  needsKey: false,
  experimental: true,
  fields: [
    { key: 'command', label: '命令', placeholder: 'npx', def: 'npx' },
    { key: 'args', label: '参数（空格分隔）', placeholder: '-y @modelcontextprotocol/server-filesystem .' },
    { key: 'toolName', label: 'Tool 名', placeholder: '' },
  ],
  describe: () => '实验实现：把 MCP server 的某个 tool 当后端调用。协议细节（采样能力、入参名）各 server 不一，可能需要按具体 server 调整入参映射。',
  async call({ system, prompt }, cfg) {
    return new Promise((resolve, reject) => {
      const args = String(cfg.args || '').split(/\s+/).filter(Boolean);
      const p = spawn(cfg.command || 'npx', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '';
      const respond = [];
      p.stdout.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === 1) { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); continue; }
          if (msg.id === 2) {
            p.kill();
            const text = (msg.result?.content || []).map(c => c.text || '').join('\n') || JSON.stringify(msg);
            return resolve({ text, raw: line, meta: { adapter: 'mcp-stdio', tool: cfg.toolName } });
          }
        }
      });
      p.stderr.on('data', () => {});
      p.on('error', reject);
      p.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pivot', version: '0.1' } },
      }) + '\n');
      p.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: cfg.toolName, arguments: { system, prompt } },
      }) + '\n');
      setTimeout(() => reject(new Error('MCP 调用超时或未返回结果')), 120000);
    });
  },
};

const BUILTIN = [skeleton, mockText, deepseek, openaiCompatible, ollama, anthropic, httpJsonBridge, pythonBridge, mcpStdio];

/* ------------------------------------------------------------------ */
/* 注册表：内置 + data/adapters/*.json                                  */
/* ------------------------------------------------------------------ */

async function loadManifests() {
  const list = [];
  let files = [];
  try { files = (await fsp.readdir(ADAPTER_DIR)).filter(f => f.endsWith('.json')); } catch { return list; }
  for (const f of files) {
    try {
      const m = JSON.parse(await fsp.readFile(path.join(ADAPTER_DIR, f), 'utf8'));
      const base = BUILTIN.find(b => b.id === m.kind);
      if (!base) continue;
      list.push({
        id: m.id,
        displayName: m.displayName || m.id,
        kind: m.kind,
        builtin: false,
        external: true,
        describe: base.describe,
        needsKey: !!m.config?.apiKey,
        fields: base.fields || [],
        call: base.call,
        config: m.config || {},
      });
    } catch (e) {
      list.push({ id: `broken:${f}`, displayName: `${f}（读取失败）`, kind: 'broken', broken: String(e.message) });
    }
  }
  return list;
}

async function listAdapters() {
  const ext = await loadManifests();
  return [...BUILTIN, ...ext].map(a => ({
    id: a.id,
    displayName: a.displayName,
    kind: a.kind,
    builtin: !!a.builtin,
    external: !!a.external,
    experimental: !!a.experimental,
    broken: a.broken,
    describe: typeof a.describe === 'function' ? a.describe() : '',
    fields: a.fields || [],
    defaultConfig: a.config || {},
  }));
}

async function resolveAdapter(id, runtimeConfig) {
  const ext = await loadManifests();
  const all = [...BUILTIN, ...ext];
  // id 为空时的兜底顺序：明确指定 > 配置里选中的 > skeleton。
  // 旧实现直接从 id 跳到 skeleton——调用方忘了传 adapterId 就会静默降级到本地骨架，
  // 那东西只返回占位符正文，用户看到的就是「AI 没有反馈」，却查不出原因。
  let want = id;
  if (!want) {
    try { want = (await loadAdapterConfig()).selected || ''; } catch { want = ''; }
  }
  const found = all.find(a => a.id === want)
    || all.find(a => a.id === id)
    || all.find(a => a.id === 'skeleton');
  const cfg = { ...(found.config || {}), ...(runtimeConfig || {}) };
  const degraded = found.id === 'skeleton' && !!id && id !== 'skeleton';
  if (degraded) console.warn(`[adapter] 适配器「${id}」不可用，退回本地骨架（正文会是占位符）`);
  return { adapter: found, config: cfg, degraded };
}

async function testAdapter(id, runtimeConfig) {
  const { adapter, config } = await resolveAdapter(id, runtimeConfig);
  const t0 = Date.now();
  const res = await adapter.call({ system: '你是一个连通性测试。', prompt: '只回复两个字：正常' }, config);
  return { ok: true, ms: Date.now() - t0, adapter: adapter.id, preview: String(res.text).slice(0, 200) };
}

module.exports = { listAdapters, resolveAdapter, testAdapter, loadAdapterConfig, saveAdapterConfig, ADAPTER_DIR };
