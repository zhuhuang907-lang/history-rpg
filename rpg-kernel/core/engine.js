'use strict';
/**
 * 内核：存档状态 / 回合调度 / 档案卡。
 *
 * 时空锁定（v4.0 方案D）：runTurn 只产出「草稿」，绝不写入时间线。
 * 只有玩家点「采纳」走 applyDraft，才会改 clock / turn / npcs / threads。
 * 线索状态也只能由玩家改，引擎不得自动推进或收尾。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { buildPrompt, npcHasContact } = require('./prompt');
const { audit } = require('./audit');
const { runPasses } = require('./passes');
// —— 世界运行六模块：世界状态机 / 资源经济 / 信息传播 / NPC 自主 / 历史分歧 / 快照回滚 ——
const world = require('./world');
const economy = require('./economy');
const capability = require('./capability');
const info = require('./info');
const agency = require('./npcAgency');
const div = require('./divergence');
const snapshot = require('./snapshot');
const anticheat = require('./anticheat');
const plot = require('./plot');
const { runPasses2, renderPasses2 } = require('./passes2');
const dossier = require('./dossier');
const figure = require('./figure-data');
const initializer = require('./initializer');
const { resolveAdapter, loadAdapterConfig } = require('../adapters/index');
const { verifyNpcName, findCandidates, personFitsYear } = require('./verify');
const { search, sparql } = require('../adapters/search');
const reign = require('./reign');
const { yearOf } = reign;
const geo = require('./geo');
const { fetchYearEvents } = require('./liveHistory');
const events = require('./events');
const drama = require('./drama');
const corrections = require('./corrections');
const factcheck = require('./factcheck');
const battle = require('./battle');
const worldgen = require('./worldgen');
const archive = require('./archive');

const figureGen = require('./figureGen');
// 启动时注册已自动生成过的人物档案与年表事件（data/figures/*.json）
try { figureGen.loadAll(); } catch (_) { /* 目录不存在不影响启动 */ }

const ROOT = path.join(__dirname, '..');
const SAVE_DIR = path.join(ROOT, 'data', 'saves');
const PACK_DIR = path.join(ROOT, 'rulepacks');

function ensureDirs() {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'data', 'adapters'), { recursive: true });
}

/**
 * 存档 id 白名单校验：API 端点的 saveId 直接拼进文件路径（path.join(SAVE_DIR, `${id}.json`)），
 * 旧版没有任何过滤 —— 于是 `saveId:"../../foo"` 这种路径穿越能读到/删到 SAVE_DIR 之外的文件，
 * 而 `saveId:undefined` 时删档会静默返回「成功」（前端以为删掉了，其实什么都没发生）。
 *
 * 真正的穿越风险只有三类字符：路径分隔符 `/` `\`、连续两点 `..`、控制字符。
 * 其余（字母、数字、下划线、连字符、中文——自定义存档名可能含中文）都无害，放行。
 */
function safeId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 120) {
    const err = new Error('缺少或非法的 saveId（必须是非空字符串）');
    err.code = 'BADID';
    throw err;
  }
  if (/[\/\\]/.test(id) || id.includes('..') || /[\x00-\x1f]/.test(id)) {
    const err = new Error('saveId 含路径穿越字符（/ \\ 或 ..），已拒绝');
    err.code = 'BADID';
    throw err;
  }
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]+$/.test(id)) {
    const err = new Error('saveId 含非法字符，只允许字母、数字、下划线、连字符和中文');
    err.code = 'BADID';
    throw err;
  }
  return id;
}

async function listSaves() {
  ensureDirs();
  const files = (await fsp.readdir(SAVE_DIR)).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(await fsp.readFile(path.join(SAVE_DIR, f), 'utf8'));
      out.push({ id: s.meta.id, title: s.meta.title, ruleset: s.meta.ruleset, turn: s.turn, updatedAt: s.meta.updatedAt });
    } catch { /* 损坏存档跳过 */ }
  }
  return out;
}

async function loadState(id) {
  safeId(id);
  const p = path.join(SAVE_DIR, `${id}.json`);
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch (e) {
    // 文件不在 → 明确告诉调用方「存档不存在」，而不是把 ENOENT 原始信息甩给前端
    if (e.code === 'ENOENT') {
      const err = new Error(`存档不存在：${id}`);
      err.code = 'ENOENT';
      throw err;
    }
    throw e;
  }
}

async function writeState(s) {
  ensureDirs();
  safeId(s.meta && s.meta.id);
  s.meta.updatedAt = new Date().toISOString();
  await fsp.writeFile(path.join(SAVE_DIR, `${s.meta.id}.json`), JSON.stringify(s, null, 2), 'utf8');
  return s;
}

async function listRulepacks() {
  const files = (await fsp.readdir(PACK_DIR)).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const pk = JSON.parse(await fsp.readFile(path.join(PACK_DIR, f), 'utf8'));
    out.push({
      id: pk.id, name: pk.name, version: pk.version, description: pk.description,
      identityModules: Object.keys(pk.identityModules || {}),
      starters: pk.starters || [],
      eraPresets: pk.eraPresets || [],
      identities: pk.identities || null,
    });
  }
  return out;
}

async function loadPack(id) {
  return JSON.parse(await fsp.readFile(path.join(PACK_DIR, `${id}.json`), 'utf8'));
}

/** 从 rulepacks/states/*.json 建新档 */
async function createSave({ ruleset, starterId, title }) {
  safeId(starterId);
  const pk = await loadPack(ruleset);
  const seed = JSON.parse(await fsp.readFile(path.join(PACK_DIR, 'states', `${starterId}.json`), 'utf8'));
  const starter = (pk.starters || []).find(s => s.id === starterId) || {};
  const id = starterId;
  let finalId = id;
  if (fs.existsSync(path.join(SAVE_DIR, `${id}.json`))) finalId = `${id}-${Date.now().toString(36)}`;
  const state = {
    meta: { id: finalId, title: title || seed.title || starter.title || starterId, ruleset, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    turn: 0,
    ...seed,
    log: [],
  };
  await writeState(state);
  return state;
}

/**
 * 自定义开局：任意朝代 / 任意身份 / 任意地点。
 * 不依赖任何预置局面，也不替玩家编造史实 —— 控制者、资源这些填了才写进档案，
 * 没填就如实登记为「未核实」，让 GM 在开场时按该朝代真实情况处理。
 */
/* ---------------- 本地事实库 data/lore/ ----------------
 * 末年真人极多，公共数据源要么没有、要么互相打架。
 * 这个目录让你把自己整理的资料（正史、墓志、族谱、地方志摘录）塞进来，
 * 检索时**优先查它**，查不到才去网上。文件名即人物名。 */
const LORE_DIR = path.join(ROOT, 'data', 'lore');

async function listLore() {
  fs.mkdirSync(LORE_DIR, { recursive: true });
  const files = (await fsp.readdir(LORE_DIR)).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try { const d = JSON.parse(await fsp.readFile(path.join(LORE_DIR, f), 'utf8')); out.push({ file: f, name: d.name || f.replace('.json', ''), source: d.source || '' }); }
    catch { out.push({ file: f, name: f.replace('.json', ''), source: '(读取失败)' }); }
  }
  return out;
}
async function loadLore(name) {
  fs.mkdirSync(LORE_DIR, { recursive: true });
  try { return JSON.parse(await fsp.readFile(path.join(LORE_DIR, `${name}.json`), 'utf8')); } catch { return null; }
}
async function saveLore(data) {
  fs.mkdirSync(LORE_DIR, { recursive: true });
  // 兼容 name 与 key 两种写法（前端与旧调用不一致）
  const name = data.name || data.key;
  if (!name) return { ok: false, why: '缺少 name（或 key）：要写哪一条？' };
  await fsp.writeFile(path.join(LORE_DIR, `${name}.json`), JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  return { ok: true, name };
}

/**
 * 从维基正文首句推断一个人物的**真实历史身份**。
 * 例：「杜伏威（598年－624年），隋朝末期农民起义军领导者之一。齐州章丘人。」
 *   → 「隋朝末期农民起义军领导者」
 */
const ROLE_CUE = /(起义军|义军|首领|领袖|将领|将军|节度使|刺史|太守|知州|知县|尚书|侍郎|丞相|宰相|御史|太尉|大将军|校尉|都督|总管|皇帝|君主|王|诸侯|军阀|割据|大臣|官员|官吏|士人|诗人|文人|学者|僧|道士|商人|豪强|地主|农民|起义|叛|太监|宦官|后妃|皇后|太后)/;
function inferRoleFromExtract(extract, name) {
  const t = String(extract || '').replace(/\s+/g, '');
  // 取头两句：中文传记常把「名X，字Y，某地人」放第一句，真正的身份在第二句
  const sents = t.split(/[。\n]/).filter(Boolean);
  const head = sents.slice(0, 2).join('，').slice(0, 200);
  const clean = head.replace(/[（(][^）)]*[）)]/g, '');     // 去掉生卒年括号
  const segs = clean.split(/[，,、]/).map(s => s.trim()).filter(Boolean);
  const isByname = s => /^(名|字|号|谥|世称|人称|小字)/.test(s);
  const isPlace = s => /(人$|籍|郡|县|州|今)/.test(s);
  const ok = s => !isByname(s) && !isPlace(s) && s.replace(name, '').length >= 4;
  // 先找带身份线索的一段（「唐朝诗人」这类虽以「人」结尾，也要认下来）；
  // 找不到再退到「不像字号的最后一段」。
  const hit = segs.find(s => ROLE_CUE.test(s) && !isByname(s) && s.replace(name, '').length >= 4);
  const pick = hit || segs.filter(ok).pop() || '';
  return pick.replace(name, '').replace(/^[，,、\s]+|[。；;\s]+$/g, '').slice(0, 24).trim();
}

async function createCustomSave(spec) {
  const pk = await loadPack(spec.ruleset);
  const id = (spec.id || 'custom').replace(/[^\w\u4e00-\u9fa5-]/g, '') + '-' + Date.now().toString(36);
  const era = spec.era || {};
  const proto = spec.protagonist || {};
  // 年龄：玩家可自定义、可留空（留空 → 真人模式搜真实年龄 / 虚构模式由 seedWorld 按身份估计）。绝不强行兜底成 20。
  const age = (proto.age != null && proto.age !== '' && !Number.isNaN(Number(proto.age))) ? Number(proto.age) : null;
  // 年号 → 公元年。这一环不做，后面全错：
  //   gregorianYear=0 会让「同代人物」按公元 0 年去挖，拉回来的是西汉人，
  //   世界整个错代 —— 这就是「开场很古怪」最常见的根因。
  const polityHint = spec.location?.polity || era.polity || '';
  let gYear = Number(era.gregorianYear) || 0;
  let reignNote = '';
  if (!gYear && era.yearLabel) {
    const rg = reign.resolveGregorian(era.yearLabel, polityHint);
    if (rg.year) { gYear = rg.year; reignNote = rg.note; }
  }
  const state = {
    meta: { id, title: spec.title || `${era.yearLabel || '自定义'} · ${proto.name || '无名'}`, ruleset: spec.ruleset, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    turn: 0,
    identityModule: spec.identityModule || 'official',
    eraPresetId: era.id || null,
    protagonist: {
      name: proto.name || '（未命名）',
      gender: proto.gender || '男',
      age,
      birthYear: (gYear && age) ? gYear - age + 1 : null,
      role: proto.role || '（身份待定）',
      background: proto.background || '',
      nativePlace: proto.nativePlace || '',
      disposition: proto.disposition || '',
    },
    clock: {
      yearLabel: era.yearLabel || '（年号待定）',
      gregorianYear: gYear,
      month: Number(era.month) || 1,
      day: Number(era.day) || 1,
      season: era.season || '',
      maxAdvancePerTurn: 5,
    },
    location: {
      // 地点绝不「待定」：玩家填了就用；没填则依次从「职衔里的地名」「真人籍贯」「该时代真实行政中心」推断
      ...(() => {
        const filled = spec.location?.full && !/待定|未定|不详/.test(spec.location.full);
        if (filled) return { full: spec.location.full, placeFrom: 'player' };
        const fromRole = worldgen.inferPlaceFromText(proto.role, proto.background);
        if (fromRole) return { full: fromRole, placeFrom: 'role' };
        const np = String(proto.nativePlace || '').trim();
        if (np) return { full: np, placeFrom: 'native' };
        return { full: worldgen.defaultPlace(era.yearLabel, spec.location?.polity || era.polity, gYear), placeFrom: 'era-default' };
      })(),
      polity: spec.location?.polity || era.polity || '（未核实）',
      controller: spec.location?.controller || '未核实',
    },
    resources: spec.resources || {},
    npcs: (spec.npcs || []).map(n => ({ ...n, firstSeenTurn: 0, source: 'fictional' })),
    threads: (spec.threads || []).map((t, i) => ({ id: `c${i + 1}`, title: t, status: 'open', lastTouchedTurn: 0, note: '开局自定义' })),
    log: [],
    opening: spec.situation || '',
    // 真人模式：史实锚点是硬约束，叙事不得违反
    mode: spec.mode || 'fictional',
    anchors: spec.anchors || null,
    // 家庭：宗族、成员、家产、义务。真人模式下这些来自核查，虚构模式下来自你或 AI 生成
    household: spec.household || { clan: '', members: [], property: {}, obligations: [] },
    // 地理：地形/水系/道路/物产/邻境。它决定行军、传信、运粮的天数和税役种类
    geography: spec.geography || null,
  };
  if (reignNote) state.reignNote = reignNote;
  // 年号换算不出来时，明确记下来 —— 宁可提示，也不要让世界按「公元 0 年」去跑
  if (!gYear) state.yearUnknown = true;

  // —— 真人模式：用检索核定的真实人物资料，按搜索结果适配身份/年龄/位置/事件 ——
  // 这是用户最痛的点：「你不能通过真实人物的搜索信息来给其适配身份……身份年龄位置等等事件，按照搜索的来」。
  // 不再让「玩家随手填的 20 岁」「界面选的皇帝模板」盖过真实记载。
  // 不论 identityModule 为何，只要 mode==='real' 且给了姓名，都走 dossier.identify：
  //   · 查得到 → 按真实生卒/身份/籍贯/事件强制写档（force），并写进 anchors 硬约束；
  //   · 查不到且确属「史无此人」→ 直接报错阻断建档，绝不拿一个空身份糊弄过去；
  //   · 查不到但属于「网络限流/超时」→ 只记警告，不阻断（玩家可稍后在「档案核定」重新核定）。
  // 真人模式：用检索核定的真实人物资料。但若姓名是占位符（未命名/无名），说明玩家没指名，
  // 此时不该去核查「未命名」而误报「查无此人」阻断建档——留待 anchorRuler 按年代定君主。
  const _namedForDossier = state.protagonist.name && !/未命名|无名|（未命名）/.test(state.protagonist.name);
  if (state.mode === 'real' && _namedForDossier) {
    try {
      const d = await dossier.identify(state.protagonist.name, gYear, polityHint);
      state.dossier = mergeDossier(state.dossier, d);
      if (!d.found) {
        if (d.allSourcesFailed) {
          // 网络故障：建档不阻断，但明确告诉玩家主角身份未核实
          state.dossierError = d.why || '检索后端暂不可用，未能核实主角真实身份；可稍后在「档案核定」重新核定。';
        } else {
          // 真的查无此人：必须阻断，逼玩家改姓名或换虚构模式
          throw new Error(`查无此人：「${state.protagonist.name}」${d.why}。真人模式要求扮演真实历史人物并核对底子；请确认姓名用字（繁简/异体/字号），或改用虚构模式。`);
        }
      } else {
        const ch = dossier.applyToState(state, d, { force: true });
        state.dossierChanges = ch.changed;
        // 有本地人工档案的：联网自动抽取只作参考，身份/驻地/生卒一律以本地档案为准。
        // 实测新建萧纪档时，联网抽取把他写成「元太守」（元是北魏宗室姓）、地点写成「益州」，
        // 初始化检查随即判三项阻断——一个本该最稳的剧本开不了局。
        const lf = figure.dossierAt(state.protagonist.name, gYear, state.clock.month);
        if (lf) {
          const t = figure.titleAt(state.protagonist.name, gYear);
          if (t) { state.protagonist.role = t; state.protagonist.office = (lf.post && lf.post.title) || t; }
          state.protagonist.born = lf.born; state.protagonist.birthYear = lf.born; state.protagonist.died = lf.died;
          if (lf.age != null) state.protagonist.age = lf.age;
          if (lf.seat && state.location.placeFrom !== 'player') { state.location.full = lf.seat; state.location.placeFrom = 'figure-verified'; }
          if (state.anchors) {
            state.anchors.born = lf.born; state.anchors.died = lf.died;
            // 仕履也用本地档案（截至开局年），否则联网抽到的「元太守」会作为硬约束进提示词
            const f0 = figure.FIGURES[state.protagonist.name] || {};
            state.anchors.officeHistory = (f0.posts || []).filter(p => p.from <= gYear)
              .map(p => `${p.from}起 ${p.title}${p.seat ? '（驻' + p.seat + '）' : ''}`).join('；');
          }
          state.dossierChanges = (state.dossierChanges || []).concat([`以本地核验档案为准：${t || ''}，驻${lf.seat || '?'}（联网抽取的身份「${d.role || ''}」仅作参考）`]);
        }
        // —— 修复「点错成皇帝不会修改」：真人身份与所选身份模块矛盾时，按真实身份纠正 ——
        const isRuler = dossier.roleIsRuler(d.role);
        if (state.identityModule === 'emperor' && !isRuler) {
          const to = dossier.classifyIdentity(d.role);
          state.identityCorrected = {
            from: 'emperor', to,
            note: `你勾选了「皇帝」，但「${d.name}」的真实身份是「${d.role}」，并非君主。已按真实身份更正为「${IDM_LABEL_ALL[to]}」。`,
          };
          state.identityModule = to;
        }
        if (reignNote) state.reignNote = reignNote;
      }
    } catch (e) {
      if (/查无此人/.test(e.message)) throw e;     // 史无此人：必须阻断
      state.dossierError = String(e.message || e);  // 其它（含网络）不阻断建档
    }
  }

  // 年代→真实君主锚定：皇帝身份 + 预置年代，主角强制为该年代真实在位君主
  worldgen.anchorRuler(pk, state.eraPresetId, state);

  // —— 硬校验：真人（非皇帝）必须活在其开局年份。皇帝由年表锚定，天然相容，跳过。——
  // 这道闸门是为了堵住「选了后赵的人物却在秦朝游玩」这类 时代错置。
  // gYear 为 0 表示玩家没填公元年（公元0年不存在），此时无从判定，跳过校验。
  if (gYear && state.mode === 'real' && state.identityModule !== 'emperor' && state.anchors) {
    const f = personFitsYear(state.anchors, gYear);
    if (!f.ok && !f.unknown) {
      throw new Error(`真实人物与年代不相容：${f.why}。请改年号/公元年，或换一个活在该时代的人。`);
    }
    // 生卒不详：放行，但记下来，由审查面板提示玩家自行核实
    if (f.unknown) state.realDateUnknown = true;
  }
  // 本地档案精确到月的生死闸门：萧纪卒于 553 年 7 月，553 年 9 月的萧纪档同样不该建起来
  if (gYear && state.protagonist && state.protagonist.name) {
    const st = figure.statusAt(state.protagonist.name, gYear, state.clock && state.clock.month);
    if (st && !st.alive) {
      throw new Error(`真实人物与年代不相容：${st.deathNote}，不可能活在 ${gYear} 年${state.clock && state.clock.month ? state.clock.month + '月' : ''}。请改年号/公元年，或换一个活在该时代的人。`);
    }
  }

  await writeState(state);
  return state;
}

async function deleteSave(id) {
  safeId(id);
  const p = path.join(SAVE_DIR, `${id}.json`);
  // 档案馆依附于存档存在：删档必须连带删馆，否则会留下查无此局的孤儿
  // （清理前库里一度积了 23 份存档已删、档案已在的残留）
  const archiveRemoved = archive.deleteArchive(id);
  // 用户要求：删存档时，这一档的调用日志与本地档案卡（历史RPG存档/<存档名>/）一并删掉，每档互不影响
  let title = '';
  try { title = JSON.parse(fs.readFileSync(p, 'utf8')).meta.title || ''; } catch (_) { /* 读不到就只按 id 删 */ }
  const extraRemoved = [];
  try {
    const lg = path.join(ROOT, 'data', 'logs', String(id).replace(/[^\w一-龥-]/g, '_') + '.jsonl');
    if (fs.existsSync(lg)) { fs.unlinkSync(lg); extraRemoved.push('日志'); }
    const cardDir = path.join(ROOT, '历史RPG存档', String(title || id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40));
    if (title && fs.existsSync(cardDir)) { fs.rmSync(cardDir, { recursive: true, force: true }); extraRemoved.push('档案卡'); }
  } catch (_) { /* 附属文件删不掉不影响删档 */ }
  try { await fsp.unlink(p); return { ok: true, deleted: id, archiveRemoved, extraRemoved }; }
  catch (e) {
    // 文件本来就不在，也算删掉了（避免前端弹一堆吓人的错）
    if (e && e.code === 'ENOENT') return { ok: true, deleted: id, missing: true, archiveRemoved };
    throw e;
  }
}

/** 清理孤儿档案馆（存档已删而档案残留）；不带参数时自动按当前存档表清理 */
async function sweepArchives(explicitIds) {
  const ids = explicitIds || (await listSaves()).map(s => s.id || s.meta && s.meta.id).filter(Boolean);
  return archive.sweepOrphans(ids);
}

function dedupeNpcs(arr) {
  const seen = new Set(); const out = [];
  for (const n of arr) { if (!n || !n.name || seen.has(n.name)) continue; seen.add(n.name); out.push(n); }
  return out;
}

/**
 * 跨年推进：让**所有真实人物**跟着历史往前走，而不是停在开局那一年。
 * 用户的原话：「你目前长线不行，跟不上历史变化」——
 * 跑到 552 年，萧纪已经称帝；跑到 554 年，他已经被杀。若存档还写着
 * 「益州刺史」「在世」，后面所有的派系、地盘、剧情都会建立在错的人上面。
 *
 * 更新范围：主角 + 所有真实历史 NPC（source==='historical'）。
 * 两类依据：
 *   ① 有本地档案（figure-data）的，按档案的逐年轨迹改年龄/官职/治所/生死/身份；
 *   ② 没有本地档案但 Wikidata 给了生卒的，至少做到年龄随年走、卒年之后标记为已故。
 * 变化全部写进 state.figureLog，可追溯。
 */
function advanceAllFigures(state, oldY, newY) {
  const log = [];
  if (!state || oldY === newY) return log;

  const applyOne = (obj, name) => {
    if (!obj || !name) return;
    const nm = String(name).trim();
    // ① 本地档案优先（含身份轨迹）
    const changes = figure.advanceOne(nm, oldY, newY);
    if (changes.length) {
      const d = figure.dossierAt(nm, newY);
      if (d) {
        if (d.age != null) obj.age = d.age;
        // 称谓按「该年应有的名分」走：已称帝的不再写旧官职（长线最常见的错）
        const t = figure.titleAt(nm, newY);
        if (t && obj.role !== t) obj.role = t;
        if (d.post && d.post.title) obj.office = d.post.title;
        if (d.seat) { obj.seat = d.seat; if (obj === state.protagonist && state.location) { /* 主角驻地在下面统一处理 */ } }
        if (!d.alive) { obj.status = '已故'; obj.alive = false; }
        if (d.identity && obj === state.protagonist) {
          // 该年已称帝而身份模块仍是宗室 → 记录待改（不静默改玩家设定，交由玩家确认）
          if (state.identityModule !== d.identity) {
            state.identityIssue = {
              at: newY, from: state.identityModule, to: d.identity, name: nm,
              note: `按档案，${nm}在${newY}年已是${d.identity === 'emperor' ? '皇帝' : d.identity}。`,
              source: 'figure-data',
            };
          }
        }
      }
      log.push(...changes);
      return;
    }
    // ② 无本地档案：凡有生卒的真实人物，年龄随年走，卒年后标已故
    //    born / birthYear 两种写法都认（Wikidata 拉回来的写 born，存档里写 birthYear）
    const rawBy = obj.birthYear != null ? obj.birthYear : obj.born;
    const by = rawBy != null ? Number(rawBy) : null;
    if (by != null && Number.isFinite(by)) { obj.age = newY - by + 1; obj.birthYear = by; }
    if (obj.died != null && Number(newY) > Number(obj.died)) {
      if (obj.status !== '已故') {
        obj.status = '已故'; obj.alive = false;
        log.push({ name: nm, kind: 'death', text: `${nm}于${obj.died}年去世（据生卒记载）` });
      }
    }
  };

  if (state.protagonist) applyOne(state.protagonist, state.protagonist.name);
  for (const n of (state.npcs || [])) {
    if (n && n.source === 'historical') applyOne(n, n.name);
  }
  // 主角驻地随档案走
  const pd = state.protagonist && figure.dossierAt(state.protagonist.name, newY);
  if (pd && pd.seat && state.location && !String(state.location.full || '').includes(pd.seat)) {
    const fromLoc = String(state.location.full || '');
    state.location.full = pd.seat;
    state.location.placeFrom = 'figure-verified';
    log.push({ name: state.protagonist.name, kind: 'seat', text: `主角治所随年份更新：${fromLoc} → ${pd.seat}` });
  }
  return log;
}

/* ================= 剧情系统对外接口 =================
   第十节：正文给玩家看「可观察层」，后台日志另存，两者物理分离。
   这里只开两个读接口 + 一个「登记状态变化」的写接口——
   玩家看到的剧情面板永远拿不到隐藏动机与未来结果。 */
async function getPlot(saveId) {
  const s = await loadState(saveId);
  plot.ensurePlot(s);
  return { summary: plot.summarize(s), visible: plot.renderPlotBlock(s) };
}
async function getPlotAudit(saveId) {
  const s = await loadState(saveId);
  plot.ensurePlot(s);
  return { log: plot.renderPlotAudit(s), summary: plot.summarize(s) };
}
async function recordPlotEffect({ saveId, arcId, 项, 变化, 由谁所致, 依据, noResult } = {}) {
  const s = await loadState(saveId);
  plot.ensurePlot(s);
  if (noResult) return plot.recordNoResult(s, arcId, noResult);
  return plot.recordEffect(s, arcId, { 项, 变化, 由谁所致, 依据 });
}

/**
 * 为任意真实人物自动建档（不建存档，仅生成/查看档案）。
 * 前端「新建自定义人物」时可先调它预览：这个人在该年处境如何、身边有谁、档案可信度如何。
 */
async function generateFigure({ name, year, month, polity, adapterId, force } = {}) {
  const nm = String(name || '').trim();
  const Y = Number(year) || 0;
  if (!nm || !Y) throw new Error('需要人物姓名与公元年');
  const existing = figure.dossierAt(nm, Y, month);
  if (existing && !force) {
    return { ok: true, existed: true, generated: !!(figure.FIGURES[nm] && figure.FIGURES[nm].generated), dossier: existing,
      circle: figure.circleAt(nm, Y, month), factions: figure.factionsAt(nm, Y, month) || [] };
  }
  const saved = await loadAdapterConfig();
  const aid = adapterId || saved.selected || 'deepseek';
  const { adapter, config } = await resolveAdapter(aid, saved.configs?.[aid] || {});
  const g = await figureGen.generate(nm, Y, polity || '', { adapter, config, force: !!force });
  if (!g.ok) return { ok: false, why: g.why, notes: g.notes || [] };
  return { ok: true, generated: true, dossier: figure.dossierAt(nm, Y, month), circle: figure.circleAt(nm, Y, month),
    factions: figure.factionsAt(nm, Y, month) || [], events: (g.events || []).length, notes: g.notes, sources: g.sources };
}

/** 开局初始化检查（随时可单独跑，不生成世界） */
async function checkInit(saveId, { online = true } = {}) {
  const state = await loadState(saveId);
  const r = await initializer.checkScenario(state, { online });
  return { ...r, report: initializer.renderInitAudit(r) };
}

/** 名籍体检（随时可查）：把当前存档里所有真实人物的身份错误列出来。 */
async function auditFigures(saveId) {
  const state = await loadState(saveId);
  const a = figure.auditAll(state);
  state.figureIssues = a.issues;
  state.figureAudit = Object.assign({}, state.figureAudit || {}, { lastAuditTurn: state.turn, lastAuditYear: a.year, issues: a.issues });
  await writeState(state);
  return a;
}

/**
 * 开局档案核定：**所有真实人物（尤其是「要玩的皇帝」）在开局时必须先联网搜索核实**，
 * 不能只靠本地档案，更不能靠身份猜。
 * 用户的原话：「不是只要他一个人，我说的所有要玩的皇帝，你开局的时候要搜索好啊。」
 *
 * 两路来源，取用次序：
 *   ① 本地人工核实档案（figure-data，可信度 high）——人工逐条查过，最可靠，优先采用；
 *   ② 联网核定（dossier.identify：维基百科正文 + 检索后端 + Wikidata）——普遍适用，
 *      但自动抽取会出错（实测把萧纪抽成「元太守」），故只作补充与交叉校验。
 * 两者冲突时保留本地档案，并把冲突记录下来供玩家核对；没有本地档案时才用联网结果填空。
 * 网络不可用不阻塞开局，但会明确标记「未核定」。
 */
async function verifyProtagonistOnSeed(state) {
  const name = String((state.protagonist && state.protagonist.name) || '').trim();
  if (!name || /未命名|无名|（未命名）|\(未命名\)/.test(name)) return null;
  const year = (state.clock && state.clock.gregorianYear) || 0;
  const polity = (state.location && state.location.polity) || '';
  const res = { name, year, polity, local: null, online: null, applied: [], conflicts: [], verified: false };

  // ① 本地人工核实档案
  const fd = figure.dossierAt(name, year);
  if (fd) {
    res.local = { seat: fd.seat, age: fd.age, post: fd.post && fd.post.title, born: fd.born, died: fd.died, source: 'figure-data' };
  }

  // ② 联网核定：维基正文 + 检索 + Wikidata
  try {
    const d = await dossier.identify(name, year, polity);
    res.online = {
      found: !!d.found,
      why: d.why || '',
      born: d.born ?? null, died: d.died ?? null,
      role: d.role || '', nativePlace: d.nativePlace || '', place: d.place || '',
      sources: (d.sources || []).map(s => s.label),
    };
    state.dossier = mergeDossier(state.dossier, d); // 旧的史料原文/亲属不得被新的结构化字段冲掉
    if (d.found) {
      res.verified = true;
      if (fd) {
        // 本地档案优先：自动抽取的官职/身份不可靠，只用它补本地没有的字段
        if (fd.age == null && d.age != null) { state.protagonist.age = d.age; if (d.born) state.protagonist.birthYear = d.born; res.applied.push(`年龄 ${d.age}（联网核定）`); }
        if (!state.protagonist.nativePlace && d.nativePlace) { state.protagonist.nativePlace = d.nativePlace; res.applied.push(`籍贯 ${d.nativePlace}（联网核定）`); }
        // 冲突留痕，不静默改
        if (d.died && fd.died && d.died !== fd.died) res.conflicts.push(`卒年：本地 ${fd.died} / 联网 ${d.died}`);
        if (d.born && fd.born && d.born !== fd.born) res.conflicts.push(`生年：本地 ${fd.born} / 联网 ${d.born}`);
      } else {
        // 没有本地档案 → 用联网结果填空（force:false，绝不覆盖玩家已填的）
        const ch = dossier.applyToState(state, d, { force: false }).changed;
        res.applied = ch.slice();
      }
    } else {
      state.dossierError = d.why || '三处来源都查无此人';
    }
  } catch (e) {
    state.dossierError = String((e && e.message) || e);
  }
  state.seedVerify = res;
  return res;
}

/* 并发受限的 map：一次最多 n 个，避免开局把检索源打爆 */
async function mapLimit(list, n, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += n) {
    const slice = await Promise.all(list.slice(i, i + n).map(fn));
    out.push(...slice);
  }
  return out;
}

/**
 * **所有真实人物的开局核定**——不只是主角。
 * 用户原话：「不是只要他一个人，我说的所有要玩的皇帝，你开局的时候要搜索好啊」。
 *
 * 现状的问题：历史 NPC 是从 Wikidata 批量拉回来的，只有「名字 + 一个自动抽的职位」。
 * 自动抽取会错（实测萧纪被抽成「元太守」：元是北魏的姓，与梁朝宗室无关），
 * 于是开局满屏身份错误，而系统毫无察觉。
 *
 * 做法（对每个真实人物，主角 + 所有 historical NPC）：
 *   ① 本地人工档案（figure-data）最可靠，命中即以此为准；
 *   ② 否则联网核定（dossier.identify：维基正文 + 检索 + Wikidata），但要用
 *      「时代错置 / 生卒矛盾」的确定性体检筛一遍，明显不可信的不用、只留痕；
 *   ③ 最后对全名籍做一次体检，问题写进 state.figureAudit，不静默放过。
 * 网络不可用不阻塞开局，但会明确标 unverified。
 */
async function verifyFiguresOnSeed(state, { limit = 20, concurrency = 6 } = {}) {
  const year = (state.clock && state.clock.gregorianYear) || 0;
  const polity = (state.location && state.location.polity) || '';
  const out = { year, checked: 0, local: 0, online: 0, onlineFailed: 0, rejected: [], applied: [], at: Date.now() };
  if (!year) return out;

  const list = [];
  if (state.protagonist && state.protagonist.name) list.push(state.protagonist);
  for (const n of (state.npcs || [])) {
    // 本地档案名单里的人已人工核过，不再拿联网自动抽取去覆盖（那条路曾把萧纪抽成「元太守」）
    if (n && n.source === 'historical' && n.name && n.verifySource !== 'figure-data.circle') list.push(n);
  }
  const targets = list.slice(0, limit);
  out.checked = targets.length;

  // ① 本地档案：命中即以此为准（人工核实过，可信度最高）
  for (const obj of targets) {
    const d = figure.dossierAt(obj.name, year, state.clock && state.clock.month);
    if (!d) continue;
    out.local += 1;
    if (d.age != null) obj.age = d.age;
    if (d.born != null) { obj.born = d.born; obj.birthYear = d.born; }
    if (d.died != null) obj.died = d.died;
    const t = figure.titleAt(obj.name, year);
    if (t && obj.role !== t) {
      out.applied.push(`${obj.name}：${obj.role || '（无）'} → ${t}（本地档案，${year}年名分）`);
      obj.role = t;
    }
    if (d.post && d.post.title) obj.office = d.post.title;
    if (d.seat) obj.seat = d.seat;
    if (!d.alive) { obj.status = '已故'; obj.alive = false; }
    obj.verified = 'high'; obj.verifySource = 'figure-data';
    if (d.situation && d.situation.text) obj.situation = d.situation.text;
  }

  // ② 联网核定：只补本地没有档案的人，且结果要通过确定性体检
  const need = targets.filter(o => !figure.dossierAt(o.name, year));
  await mapLimit(need, concurrency, async (obj) => {
    let d = null;
    try { d = await dossier.identify(obj.name, year, polity); }
    catch { out.onlineFailed += 1; obj.verified = 'unchecked'; obj.verifyNote = '联网核定失败（开局不阻塞）'; return; }
    if (!d || !d.found) { obj.verified = 'unchecked'; obj.verifyNote = d ? (d.why || '查无此人') : '查无此人'; return; }
    out.online += 1;
    // 体检：联网抽出来的角色若与年份矛盾（如梁朝人抽到「元太守」），不予采用
    const probe = figure.auditFigure({
      name: obj.name, year, polity, role: d.role || '',
      born: d.born ?? obj.born, died: d.died ?? obj.died,
      identityModule: obj === state.protagonist ? (state.identityModule || '') : '',
    });
    if (probe.length) {
      out.rejected.push({ name: obj.name, role: d.role || '', why: probe.map(p => p.text).join('；') });
      obj.verified = 'low'; obj.verifyNote = `联网抽取的「${d.role || '角色'}」未通过史实体检，未采用`;
      if (d.born != null && obj.born == null) obj.born = d.born;
      if (d.died != null && obj.died == null) obj.died = d.died;
      return;
    }
    if (d.role) {
      const old = obj.role || '';
      obj.role = d.role; obj.office = d.role;
      out.applied.push(`${obj.name}：${old || '（无）'} → ${d.role}（联网核定）`);
    }
    if (d.born != null) { obj.born = d.born; obj.birthYear = d.born; }
    if (d.died != null) obj.died = d.died;
    if (d.nativePlace && !obj.nativePlace) obj.nativePlace = d.nativePlace;
    obj.verified = 'medium'; obj.verifySource = (d.sources || []).map(s => s.label).join('、') || 'online';
  });

  // ③ 全名籍体检：把「身份设定错误」摆到明面上，不再藏在存档里
  out.audit = figure.auditAll(state);
  out.issues = out.audit.issues.slice();
  state.figureAudit = out;
  return out;
}

/**
 * 开局自动生成世界：真实历史人物（免费 Wikidata）+ 规则生成的家族/本地势力/地理/地图。
 * 真人模式下不覆盖玩家已核查的 household / anchors。
 */
/**
 * 合并两次人物核定的结果：后一次常常只回 born/died/place（结构化字段），
 * 会把前一次的史料原文（excerpt）、亲属（kin）、事件（events）冲掉——
 * 而「他是谁的儿子」恰恰决定他此刻在哪、归谁管。故这些字段只增不减。
 */
function mergeDossier(prev, next) {
  if (!prev || typeof prev !== 'object') return next;
  const out = { ...(next || {}) };
  for (const k of ['excerpt', 'kin', 'desc', 'role']) {
    if (!out[k] && prev[k]) out[k] = prev[k];
  }
  if ((!out.events || !out.events.length) && (prev.events || []).length) out.events = prev.events;
  return out;
}

async function seedWorld({ saveId, adapterId, force }) {
  const state = await loadState(saveId);
  const year = state.clock.gregorianYear || 0;
  // 地理/地图要接 LLM 从真实原文里做结构化抽取，故把当前适配器与配置传进去
  let adapter = null, adapterCfg = {};
  try {
    const saved = await loadAdapterConfig();
    const aid = adapterId || saved.selected || 'deepseek';
    const rs = await resolveAdapter(aid, saved.configs?.[aid] || {});
    adapter = rs.adapter; adapterCfg = rs.config || {};
  } catch { /* 没配 Key 也能跑，地理退化为只取原文 */ }

  // —— 开局档案核定：**先搜索核实人物，再生成世界**——
  // 凡填了具体姓名的主角（尤其是「要玩的皇帝」），一律先联网核实其生卒/身份/籍贯/驻地。
  // 网络失败不阻塞开局，但会明确标记「未核定」。
  // —— 任意真实人物：本地没有人工档案的，用当前模型 API + 检索自动建档（校验通过才启用）——
  //    这样玩家输入任何一个历史人物，都能得到萧纪那样「分月处境 / 身边真人 / 派系 / 年表」的开局，
  //    而不是退回「Wikidata 随便拉一批同代人 + 通用模板」。证据不足就不建档，并把原因留给玩家看。
  const pname = String((state.protagonist && state.protagonist.name) || '').trim();
  if (state.mode === 'real' && pname && !/未命名|无名/.test(pname) && !figure.dossierAt(pname, year)) {
    try {
      const g = await figureGen.generate(pname, year, (state.location && state.location.polity) || '', { adapter, config: adapterCfg });
      state.figureGen = { ok: !!g.ok, why: g.why || '', notes: (g.notes || []).slice(0, 20), sources: g.sources || [], at: Date.now() };
    } catch (e) {
      state.figureGen = { ok: false, why: String((e && e.message) || e), at: Date.now() };
    }
  }

  let seedVerify = null;
  try { seedVerify = await verifyProtagonistOnSeed(state); }
  catch { /* 核定失败不阻塞开局 */ }

  // —— 初始化合法性检查（规格 §5 / 总指令 §3.2）——
  // 先确定世界里什么是真的，再决定开局怎么写。
  // 有阻断项（年号错位/政权不存在/人物错代/治所与开局地矛盾）时，
  // 默认**不进入正式开局生成**，把审计报告交回给玩家；
  // 玩家明确要按架空条件开局时，传 force 强行进入，但审计仍留档。
  let initAudit = null;
  try {
    initAudit = await initializer.checkScenario(state, { online: true });
    state.initAudit = {
      at: Date.now(), year, summary: initAudit.summary,
      blocking: initAudit.blocking, conflicts: initAudit.conflicts,
      unfounded: initAudit.unfounded, canProceed: initAudit.canProceed,
      checks: initAudit.checks,
    };
  } catch { /* 检查失败不阻塞 */ }
  if (initAudit && !initAudit.canProceed && !force) {
    await writeState(state);
    return {
      blocked: true, state, initAudit,
      report: initializer.renderInitAudit(initAudit),
      note: '初始化检查存在阻断项，未生成世界。修复设定或以架空条件（force）重试。',
    };
  }

  const w = await worldgen.seed(state, { adapter, adapterCfg });
  const keep = (state.npcs || []).filter(n => n.source === 'real-kin' || n.source === 'historical-keep');
  const gen = [...w.historicalNpcs, ...w.localCast];
  state.npcs = dedupeNpcs([...keep, ...gen]);
  state.household = w.household;
  state.geography = w.geography;
  state.map = w.map;
  if (w.territory) state.territory = w.territory;
  if (w.factions) state.factions = w.factions;
  if (!state.opening) state.opening = w.opening;
  if (!state.threads || !state.threads.length) state.threads = w.threads || [];
  // 真人模式（非皇帝）：主角有名字却没生卒，自动去 Wikidata 估年龄与官职（尽量用真实）
  if (state.mode === 'real' && state.identityModule !== 'emperor' && state.protagonist.name && !(state.anchors && state.anchors.born)) {
    try {
      const v = await findCandidates({ name: state.protagonist.name, from: Math.max(-3000, year - 90), to: year });
      const c = (v.rows || []).find(x => x.born);
      if (c && c.born) {
        state.protagonist.birthYear = c.born;
        if (c.gender) state.protagonist.gender = c.gender;
        if (year) state.protagonist.age = year - c.born + 1;
        state.anchors = { ...(state.anchors || {}), born: c.born, died: c.died || null, qid: c.qid || null, gender: c.gender || '' };
      }
    } catch { /* 估不到就留空，不阻塞开局 */ }
  }
  // —— 所有真实人物的开局核定 + 名籍体检（不只主角）——
  // 用户原话：「我不是只要一个皇帝一个人物，我选择的所有人物都要有合理的搜索和开局」。
  // 放在世界生成之后，这样连 worldgen 批量拉来的历史朝臣也一并核定。
  let figureAudit = null;
  try {
    figureAudit = await verifyFiguresOnSeed(state, {
      limit: state.identityModule === 'emperor' ? 24 : 16,
    });
  } catch { /* 核定失败不阻塞开局 */ }

  // 历史底盘聚合（档案馆）：按 身份/时代/地理 差异化，带来源/可信度标注并持久化
  try {
    const pk = await loadPack(state.meta.ruleset);
    state.archive = archive.worldContext(state, pk);
    archive.saveArchive(saveId, state.archive);
  } catch { /* 底盘聚合失败不阻塞开局 */ }

  // —— 开局即建账：世界/经济/信息/人物自主性/史实分歧/剧情台账（幂等，已有则不重置）——
  // 规格 §5.5：初始资源验证必须在开局时就有账可查，不能拖到第一回合才建账；
  // 否则初始化检查器只能报「资源·账本：不适用」，等于开局资源无人核。
  try {
    world.ensureWorld(state);
    economy.eco(state);
    info.ensureFacts(state);
    agency.ensureAgency(state);
    div.ensureDiv(state);
    plot.ensurePlot(state);
  } catch { /* 台账初始化失败不阻塞开局 */ }

  await writeState(state);
  return { state, histError: w.histError, histCount: w.historicalNpcs.length, localCount: w.localCast.length, seedVerify, figureAudit, initAudit };
}

/** 取本局「档案馆」底盘：优先返回已落盘的结构；没有则现算并缓存。 */
async function getArchive(saveId) {
  const state = await loadState(saveId);
  if (state.archive) return state.archive;
  const pk = await loadPack(state.meta.ruleset).catch(() => null);
  const ctx = archive.worldContext(state, pk);
  archive.saveArchive(saveId, ctx);
  return ctx;
}

/**
 * 反查：公元年 → 年号 + 第几年（跨年改元用）。
 * 年号同名者（如「建兴」有 223/313）在不知政权时会有歧义，故只作提示，标待核。
 */
function reignLabelFor(gregorianYear) {
  const y = Number(gregorianYear);
  if (!Number.isFinite(y)) return null;
  let best = null;
  for (const [name, start] of reign.REIGNS) {
    if (start <= y && (!best || start > best[1])) best = [name, start];
  }
  if (!best) return null;
  const n = y - best[1] + 1;
  const NUMS = [null, '元', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  return `${best[0]}${n === 1 ? '元年' : (n <= 10 ? NUMS[n] + '年' : n + '年')}`;
}

function extractJson(raw) {
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return { scene: text, parseFailed: true };
  // 取第一个完整对象。必须**跳过字符串里的花括号**：
  // 旧实现直接数 `{`/`}`，正文里出现「他说：“{某事}”」就会数错层级导致解析失败。
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const slice = text.slice(start, end > 0 ? end : undefined);
  try { return JSON.parse(slice); } catch { return { scene: text, parseFailed: true }; }
}

/** 解析 GM 回复里的 `SEARCH: <查询词>`（实时检索）与 `CLAIM: <地名>|<控制者>|<备注>`（地盘变更）。 */
function parseSearch(text) {
  const lines = String(text || '').split('\n');
  const searches = [];
  const claims = [];
  const identities = [];
  const encounters = [];
  const rest = [];
  let inJson = false;
  for (const line of lines) {
    if (!inJson) {
      const ms = line.match(/^\s*SEARCH\s*[:：]\s*(.+?)\s*$/i);
      if (ms) { searches.push(ms[1].trim()); continue; }
      const mc = line.match(/^\s*CLAIM\s*[:：]\s*(.+?)\s*$/i);
      if (mc) {
        const parts = mc[1].split(/[|｜]/).map(s => s.trim());
        if (parts[0]) claims.push({ name: parts[0], controlledBy: parts[1] || '', note: parts[2] || '' });
        continue;
      }
      const mi = line.match(/^\s*IDENTITY\s*[:：]\s*(.+?)\s*$/i);
      if (mi) {
        const parts = mi[1].split(/[|｜]/).map(s => s.trim());
        if (parts[0]) identities.push({ identityModule: parts[0], role: parts[1] || '', reason: parts[2] || '' });
        continue;
      }
      // BATTLE: <敌军名>|<敌兵力>|<敌阵形 id 或中文>|<地形>
      const mb = line.match(/^\s*BATTLE\s*[:：]\s*(.+?)\s*$/i);
      if (mb) {
        const p = mb[1].split(/[|｜]/).map(s => s.trim());
        encounters.push({ enemyName: p[0] || '敌军', enemyTroops: Number(p[1]) || 1000, enemyFormation: p[2] || '', terrain: p[3] || '' });
        continue;
      }
    }
    if (line.trim().startsWith('{')) inJson = true;
    rest.push(line);
  }
  return { searches, claims, identities, encounters, cleaned: rest.join('\n') };
}

/* 把本轮的 CLAIM 落到地盘表：同名更新，新地名追加。地盘只增不编——没有 CLAIM 就不动。 */
function applyClaims(state, claims, turn) {
  if (!claims || !claims.length) return [];
  state.territory = state.territory || [];
  const changed = [];
  for (const c of claims) {
    const t = state.territory.find(x => x.name === c.name);
    if (t) {
      t.controlledBy = c.controlledBy || t.controlledBy;
      if (c.note) t.note = c.note;
      t.updatedTurn = turn; t.source = 'gm';
    } else {
      state.territory.push({ name: c.name, controlledBy: c.controlledBy, note: c.note, source: 'gm', updatedTurn: turn });
    }
    changed.push(c);
  }
  return changed;
}

/* ===================== 先想后写：构思阶段 =====================
   只让模型出结构化构思，不许写正文。温度压低，减少飘。 */
const PLANNER_SUFFIX = `

############ 第一步：只填回合计划卡，不写正文 ############
只输出一个 JSON（不要包裹代码块）：
{
  "player_intent": {"actions": ["玩家本轮写明的行动"], "speech": ["玩家写明的原话"], "time_instruction": null},
  "turn_type": "压力/谈判/行动/揭示/日常/余波 之一（不得与最近三轮全同）",
  "atom_or_recipe": "从上面配方库挑一个原子或配方（配方注明第几拍）",
  "dramatic_question": "一句话：谁想要什么，什么在挡路",
  "present_npcs": ["本轮出场的人，必须是名册上已有的名字"],
  "new_npcs_needed": [{"name": "全名", "function": "剧情上要他干什么"}],
  "opponent_action": "对手或不在场的人本轮在暗处做什么（会在后面以后果出现）",
  "due_foreshadow_handling": [{"id": "伏笔编号", "plan": "回收(兑现/反转/代价/落空)、转化或推迟，并说理由"}],
  "new_fact": "本轮投放的一条新事实（注明大/中/小）",
  "twist": "一个玩家没料到的变数",
  "stop_point": "停在什么局面（有人在等主角一句话）",
  "redline_declaration": {"no_speaking_for_player": true, "no_unrequested_timeskip": true}
}
要求：玩家没说的不要替他补；时钟格数由引擎给定，只写它如何体现；先问自己三句——世界有没有给出有意思的反应？有没有新的压力、信息或选择？玩家读完最后一句会不会想立刻回答？`;

function parsePlan(text) {
  const t = String(text || '');
  const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };
  let j = tryParse(t.trim());
  if (!j) {
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/) || t.match(/(\{[\s\S]*\})/);
    if (m) j = tryParse(m[1].trim());
  }
  return j && typeof j === 'object' ? j : null;
}

/* 提示词文件热加载（prompts/*.md；改完即生效）。# 开头的行是给维护者看的注释，不进提示词 */
const _prompts = {};
function loadPromptFile(name) {
  const f = path.join(ROOT, 'prompts', name + '.md');
  try {
    const st = fs.statSync(f);
    if (!_prompts[name] || _prompts[name].mtime !== st.mtimeMs) {
      const txt = fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => !/^#/.test(l)).join('\n').trim();
      _prompts[name] = { mtime: st.mtimeMs, txt };
    }
    return _prompts[name].txt;
  } catch (_) { return ''; }
}

/* 计划卡校验（《实现包》§3.8、§8.8 第 4 步）：只查代码查得准的 */
function validatePlan(p, state, input) {
  const errs = [];
  const TT = ['压力', '谈判', '行动', '揭示', '日常', '余波'];
  if (!TT.includes(p.turn_type)) errs.push(`turn_type 必须是 ${TT.join('/')} 之一`);
  const tt = ((state.longline && state.longline.turnTypes) || []).slice(-3);
  if (tt.length === 3 && tt.every(t => t === tt[0]) && p.turn_type === tt[0]) errs.push(`最近三轮都是「${tt[0]}」，本轮换一种`);
  if (!String(p.dramatic_question || '').trim()) errs.push('缺 dramatic_question（谁想要什么，什么在挡路）');
  if (!String(p.stop_point || '').trim()) errs.push('缺 stop_point（停在什么局面）');
  if (!String(p.atom_or_recipe || '').trim()) errs.push('缺 atom_or_recipe（从配方库挑一个）');
  // 意图必须来自本轮原话：拆出来的行动与原话毫无共同字眼，说明拿错了（实测把旧回合的输入当成了本轮）
  const inp = String(input || '').trim();
  const acts = [].concat((p.player_intent && p.player_intent.actions) || []).join('');
  if (inp && acts) {
    const grams = new Set(); for (let i = 0; i < inp.length - 1; i++) grams.add(inp.slice(i, i + 2));
    if (![...grams].some(g => acts.includes(g))) errs.push(`player_intent 与玩家本回合原话「${inp.slice(0, 30)}」对不上——只能从这句原话里拆`);
  }
  const names = new Set((state.npcs || []).map(n => n.name));
  const newNames = new Set(((p.new_npcs_needed || [])).map(x => x && x.name).filter(Boolean));
  const ghost = (p.present_npcs || []).filter(n => n && !names.has(n) && !newNames.has(n) && n !== (state.protagonist && state.protagonist.name));
  if (ghost.length) errs.push(`present_npcs 里有名册上没有的人：${ghost.join('、')}——要么换成名册里的人，要么在 new_npcs_needed 里申请`);
  const dead = (p.present_npcs || []).filter(n => (state.npcs || []).some(x => x.name === n && (x.status === '已故' || x.alive === false)));
  if (dead.length) errs.push(`present_npcs 里有已故之人：${dead.join('、')}`);
  try {
    const L = state.longline;
    const overdue = ((L && L.foreshadows) || []).filter(f => !['已回收', '已转化', '已作废'].includes(f.state) && (state.turn || 0) >= f.latest).map(f => f.id);
    const handled = new Set((p.due_foreshadow_handling || []).map(x => x && x.id));
    const miss = overdue.filter(id => !handled.has(id));
    if (miss.length) errs.push(`逾期伏笔没有处理方案：${miss.join('、')}`);
  } catch (_) { /* 无长线数据 */ }
  const rd = p.redline_declaration || {};
  if (rd.no_speaking_for_player !== true || rd.no_unrequested_timeskip !== true) errs.push('redline_declaration 两项都须为 true');
  return errs;
}

function renderPlan(p) {
  const L = [];
  const push = (k, v) => { if (v) L.push(`· ${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`); };
  // 新版计划卡字段
  if (p.turn_type || p.dramatic_question) {
    push('回合类型', p.turn_type);
    push('剧情原子/配方', p.atom_or_recipe);
    push('戏剧问题', p.dramatic_question);
    push('玩家意图（只照这些写，没说的不补）', p.player_intent);
    push('出场人物', (p.present_npcs || []).join('、'));
    push('对手本轮在做什么', p.opponent_action);
    push('到期伏笔的处理', p.due_foreshadow_handling);
    push('本轮投放的新事实', p.new_fact);
    push('变数（玩家没料到的东西）', p.twist);
    push('停点', p.stop_point);
    return L.join('\n');
  }
  push('世界自行推进', p['世界自行推进']);
  (p['玩家指令的直接结果'] || []).forEach((x, i) => push(`直接结果${i + 1}`, x));
  (p['NPC反应'] || []).forEach(n => {
    L.push(`· NPC ${n['人'] || '?'}：他知道「${n['他知道什么'] || ''}」；他要「${n['他想要什么'] || ''}」；他怕「${n['他害怕什么'] || ''}」；所以他会「${n['他会怎么做'] || ''}」`);
  });
  (p['状态变化'] || []).forEach(c => L.push(`· 状态变化：${c['项'] || '?'} ${c['前'] || ''} → ${c['后'] || ''}（来源：${c['来源'] || '**未写来源，这条不许写进正文**'}）`));
  (p['信息传播'] || []).forEach(c => L.push(`· 信息：${c['信息'] || ''}；新增知情：${c['新增知情人'] || ''}（${c['怎么知道的'] || ''}）`));
  push('停在哪里', p['停在哪里']);
  if (p['自检']) L.push(`· 自检：${JSON.stringify(p['自检'])}`);
  return L.join('\n');
}

/**
 * 用户 GM 规范（history-rpg-gm v5.0）第六章的每回合固定栏目。
 *   【当前情况】时间、地点、主角年龄身份 —— 取自存档时钟与人物档案，不靠模型自报；
 *   同场人物 —— 取模型给的 presentNpcs，并用名籍补年龄身份；
 *   【世界大事】—— 模型的 worldNote（须注明消息来源）；
 *   【人物表·本回合新增】—— 模型的 newNpcs；
 *   【存疑】—— 模型的 doubts；
 *   【本回合查证】—— 引擎**实际**发出的检索（写前预检索 + 模型要求的检索），杜绝「声称查过实际没查」。
 */
/* 像不像一个全名：2~4 个汉字、不是职名/占位（女性「某氏」「某娘」、排行「王二郎」、法名均可） */
function isProperName(nm) {
  const s = String(nm || '').trim();
  if (!/^[一-龥]{2,5}$/.test(s)) return false;
  return !/^(主簿|书吏|小吏|门吏|亲兵|侍从|老农|佃户|商人|将领|官员|使者|僧人|某|无名|姓名)/.test(s) && !/未具|不详|某人/.test(s);
}

function gmPanels(state, draft, { preEvidence = [], didSearches = [] } = {}) {
  const c = state.clock || {}, p = state.protagonist || {};
  const title = figure.titleAt(p.name, c.gregorianYear) || p.role || '';
  const roster = new Map((state.npcs || []).map(n => [n.name, n]));
  const present = (Array.isArray(draft.presentNpcs) ? draft.presentNpcs : []).map(x => {
    const nm = typeof x === 'string' ? x : (x && x.name) || '';
    const n = roster.get(nm) || {};
    const a0 = (x && x.age) != null ? x.age : n.age;
    const age = /^\d+$/.test(String(a0 == null ? '' : a0).replace(/岁$/, '')) ? String(a0).replace(/岁$/, '') + '岁' : '年岁未详';
    const role = (x && x.role) || n.role || '';
    return nm ? `${nm}，${age}${role ? `，${role}` : ''}` : '';
  }).filter(Boolean);
  const newNpcs = (Array.isArray(draft.newNpcs) ? draft.newNpcs : []).map(n =>
    `${n.name || '（缺名）'}，${n.age != null ? n.age + '岁' : '年龄未写'}，${n.background || n.role || '身份未写'}，${n.nativePlace || '籍贯未写'}，${n.source === 'historical' ? '真实' : '虚构'}，${n.tie || '关系未写'}，首见于第${(state.turn || 0) + 1}回合`);
  const doubts = (Array.isArray(draft.doubts) ? draft.doubts : []).map(d =>
    typeof d === 'string' ? d : `${d.item || ''}　查证：${d.checked || ''}　处理：${d.handling || ''}`).filter(s => s.trim());
  // 规范 4.1：新虚构人物须有全名。没起名的（「主簿」「某人」「姓名未具」）明列进存疑，不悄悄放过
  const unnamed = (Array.isArray(draft.newNpcs) ? draft.newNpcs : []).filter(n => !isProperName(n.name));
  for (const n of unnamed) doubts.push(`新人物「${n.name || '（无名）'}」没有全名　处理：须补全名并查重，补齐前不得单独展开其遭遇`);
  // 每条标出实际用的后端；兜底的写明「兜底」，没结果的写明「无结果」——混用一眼可见
  const PNAME = { bocha: '博查', wikipedia: '维基', wikidata: 'Wikidata', tavily: 'Tavily', serper: 'Serper', bing: 'Bing', searxng: 'SearXNG' };
  const tag = x => `${x.query}〔${PNAME[x.provider] || x.provider || '?'}${x.fallbackFrom ? '·兜底' : ''}${x.count === 0 ? '·无结果' : ''}〕`;
  const searched = [...(preEvidence || []), ...(didSearches || [])].filter(x => x && x.query).map(tag);
  return {
    当前情况: [
      `时间：${c.yearLabel || '?'}${c.month || '?'}月${c.day || '?'}日（公历${c.gregorianYear || '?'}年·${c.season || ''}）`,
      `地点：${(state.location && state.location.full) || '?'}`,
      `主角：${p.name || '?'}，此时年${p.age != null ? p.age : '?'}岁，${title}`,
      `同场人物：${present.length ? present.join('；') : '（未列）'}`,
    ],
    世界大事: String(draft.worldNote || '').trim() || '本回合无新外讯',
    人物表: newNpcs,
    存疑: doubts,
    本回合查证: searched.length ? searched : ['（本回合检索未成功，正文细节未经联网查证）'],
  };
}

async function runTurn({ saveId, input, adapterId, adapterConfig, confirmedThreads, identityModule, temperature, autoVerifyNpcs, verbosity: verbosityOverride, battle: battleOrders, autoFactCheck: autoFactCheckIn = true, autoRepair = true, planFirst = true, factMode }) {
  const state = await loadState(saveId);
  const pack = await loadPack(state.meta.ruleset);
  // 史实宽容度（《设计书》§1.3）：严格 / 标准（默认）/ 宽松。记在存档里，下次沿用。
  if (['strict', 'standard', 'loose'].includes(factMode)) state.meta.factMode = factMode;
  const fm = state.meta.factMode || 'standard';
  // 宽松档只守红线：不做写后史实核查（省一轮检索与改写，剧情优先），正文里允许合理架空
  let autoFactCheck = fm === 'loose' ? false : autoFactCheckIn;
  const idm = identityModule || state.identityModule || 'official';

  // —— 主角已故：本局到此为止，不再让模型替死人写下一回合 ——
  //    （库里曾有 554 年仍在理政的萧纪档，就是没有这道闸）
  {
    const pst = state.protagonist && figure.statusAt(state.protagonist.name, state.clock.gregorianYear || 0, state.clock.month);
    if (state.protagonistDead || (pst && !pst.alive)) {
      const why = (state.protagonistDead && state.protagonistDead.note) || (pst && pst.deathNote) || '主角已故';
      throw new Error(`本局主角已故（${why}），故事到此结束，不能再推进回合。可回滚到身故之前的快照，或另开新局。`);
    }
  }

  // 持续推进历史：本游戏年份首次出现时，检索该公元年的真实大事并缓存进存档。
  // 本地年表优先；联网结果按政权过滤，抓不到就标「未核定」，不拿世界年表里无关的事充数。
  state.liveHistory = state.liveHistory || {};
  const gy = state.clock.gregorianYear || 0;
  if (gy && (!state.liveHistory[gy] || !state.liveHistory[gy].v2)) {
    const ev = await fetchYearEvents(gy, { polity: state.location && state.location.polity, name: state.protagonist && state.protagonist.name, place: state.location && state.location.full });
    state.liveHistory[gy] = { text: ev.text, lines: ev.lines || [], source: ev.source, status: ev.status || '', fetchedTurn: state.turn, v2: true };
    await writeState(state); // 缓存该年，避免每轮重搜同年
  }
  try { worldgen.refreshEraEvents(state); } catch (_) { /* 无年表不影响 */ }

  // —— 世界运行：四个台账初始化（幂等，老存档也会补齐）——
  world.ensureWorld(state);          // 24 项世界状态
  economy.eco(state);                // 人口 / 农业 / 财政 / 市场 / 四本账（已有则不重置）
  info.ensureFacts(state);           // 信息分层 F1–F5
  agency.ensureAgency(state);        // NPC 的目标 / 恐惧 / 底线 / 行动能力
  div.ensureDiv(state);              // 史实锚点 / 因果链 / 分歧
  plot.ensurePlot(state);            // 剧情：编号 / 七层 / 状态机 / 因果链
  // —— 剧情生成器：先决定「本轮可能发生什么、为什么、谁行动」——
  // 这一步在写正文**之前**：没有可追溯的触发条件就一个剧情也不生成，
  // 从根上掐掉「为了精彩强行编排」。
  const plotPlan = plot.planArcs(state, { input, advanceDays: 0, touched: [] });

  // —— 突发事件：低概率掷一个（约 8%），同族冷却；掷出就注入本轮，并记进 eventLog ——
  //    **开局那一回合不掷**：玩家还没落地就天降蝗灾、地震，正是「开头太突兀」的直接来源。
  //    规格 §十四：开场只选一个核心问题，严禁一上来就连环爆发大事件。
  //    先让他站稳，第二回合起再掷。
  // 注意：下面那个 isOpening 变量要到后面才定义（TDZ），这里自己判一次。
  const isFirstTurn = !(state.log || []).some(l => l.speaker === 'GM');
  const evt = isFirstTurn ? null : events.rollEvent(state, { probability: 0.08 });
  state.currentEvent = evt;
  if (evt) {
    state.eventLog = state.eventLog || [];
    // 同一族、同一文案的重复条目不再堆记（旧实现会连记七八条一模一样的蝗灾）
    const dup = state.eventLog.some(x => x.family === evt.family && x.text === evt.text && (state.turn - (x.turn || 0)) <= 1);
    if (!dup) {
      state.eventLog.push({ turn: state.turn, family: evt.family, familyName: evt.familyName, severity: evt.severity, text: evt.text, effects: evt.effects });
      if (state.eventLog.length > 60) state.eventLog = state.eventLog.slice(-60);
    }
  }

  // —— 戏剧张力：每轮掷一个「有分量」的节拍（约 75%），让人物自己动起来、把剧情推向有价值处 ——
  state.drama = drama.rollDrama(state);

  await writeState(state);

  // 旧档里记着的「short」是 300 字时代的默认值，不是玩家选的；没有显式指定时按新标准 long
  const storedVb = state.meta && state.meta.verbosity;
  const verbosity = verbosityOverride || (storedVb && storedVb !== 'short' ? storedVb : 'long');
  const isOpening = !(state.log || []).some(l => l.speaker === 'GM');
  const built = buildPrompt(pack, state, input, { playerConfirmedThreads: confirmedThreads, identityModule: idm, verbosity, isOpening });
  const system = built.system;
  let prompt = built.prompt;              // 后面还要往里追加「世界状态」等块，故用 let
  const vb = built.verbosity;
  state.meta.verbosity = vb.key; // 记住偏好，下次沿用

  // —— 把「世界本身」塞进提示词：不是一个背景板，而是这一轮写东西的硬约束 ——
  //   世界状态（24 项）/ 人力钱粮兵（守恒）/ 人物各自在做什么（他们不等玩家也在动）/
  //   谁知道什么（信息四层，第四层不得泄露）/ 史实锚点与分歧 / 回归提醒
  const arcsMod = require('./arcs');
  const worldBlocks = [
    // 篇章目标与当前一拍放最前（《设计书》§3.9：主线漂移的对策是「篇章目标写进每轮提示词的顶部」）
    arcsMod.renderArcs(state),
    // 行为能力闸门：他此刻能做什么、不能做什么（未成年/无职衔者不得被写成在理政）
    capability.renderCapability(state),
    world.renderWorld(state),
    economy.renderEconomy(state),
    agency.renderAgency(state),
    info.renderInfo(state),
    div.renderDivergence(state),
    plot.renderPlotBlock(state),
    require('./ethics').renderEthics(state),
    ({
      strict: '=== 史实宽容度：严格 ===\n真实人物、官职、地名、年月一律以检索与档案为准；查不到的写进 doubts，不得想象补足；新虚构人物须查重。',
      standard: '=== 史实宽容度：标准 ===\n大事件时点、真实人物关键事迹、官职地名须核对；日常细节允许合理想象，但不得与已知史实冲突。',
      loose: '=== 史实宽容度：宽松（本局部分架空） ===\n只守红线（不替玩家决定、不快进、不占位、不用现代词、不让死人开口），剧情优先，细节允许架空；不得把架空写成「史载」。',
    })[fm],
    // 长线：时钟、伏笔到期、关系值、回合类型、无代价计数（代码记账，模型只写成剧情）
    require('./longline').renderLongline(state, (state.npcs || []).filter(n => n.contact).map(n => n.name)),
    // 对手卡与幕后行动（§4.6）、记忆分层与旧事检索（§8.6–8.7）
    arcsMod.renderOpponents(state),
    require('./memory').renderMemory(state, input),
    renderPasses2(state),
  ].filter(Boolean).join('\n\n');
  if (worldBlocks) prompt += '\n\n' + worldBlocks;
  // —— 主角真实档案（检索核定）：写他时必须照此，不得另编一套身份/年龄/籍贯/事件 ——
  const dossierBlock = dossier.renderDossier(state);
  if (dossierBlock) prompt += '\n\n' + dossierBlock;
  // 界面没带配置过来时，用落盘保存的那份（双击启动后不必重新填 Key）
  // 注意：resolveAdapter 在 id 为空时会静默掉到 skeleton（本地骨架），
  // 那东西只返回占位符、根本不调模型——用户看到的就是「AI 没有反馈」。
  // 所以这里必须先把 aid 兜到选定适配器，跟 seedWorld 一个口径。
  const saved = await loadAdapterConfig();
  const aid = adapterId || saved.selected || 'deepseek';
  const { adapter, config } = await resolveAdapter(aid, { ...(saved.configs?.[aid] || {}), ...(adapterConfig || {}) });
  // 真掉到骨架了，要让玩家知道自己拿到的是空壳，而不是以为 AI 不干活
  if (adapter && adapter.id === 'skeleton') {
    console.warn('[turn] 未取得可用模型适配器，退回本地骨架：请检查是否已配置并选定 API Key');
  }
  // 冷记忆：满十回合就压一段小结（模型合并，代码校验有无编造；不过就用代码拼接版）。供下一轮起使用
  const __t0 = Date.now();
  try { if (adapter && adapter.id !== 'skeleton') await require('./memory').compressIfDue(state, adapter, config); } catch (_) { /* 压缩失败不阻塞 */ }

  // 联网检索：**不是可选**。凡涉及真实人物/地点/事件/官制/年号，GM 必须先 SEARCH 查证再写
  const searchSystem = system + '\n\n【联网检索指令（必须用）】本局内置实时检索（走设置里选定的检索后端，如博查；失败时自动以维基兜底）。'
    + '\n**凡本轮要写到的真实人物、真实地名、真实事件、官职制度、年号纪年、乃至某物的年代，你都必须先提出检索**，不得凭记忆直接写。每轮最多 3 条。写法：在正文 JSON 之前，一行一条：'
    + '\n· `SEARCH: <查询词>`'
    + '\n另外两条指令按需使用：'
    + '\n· `CLAIM: <地名>|<归谁控制>|<备注>`：某地易主、被占、失守时登记进地盘表（引擎永久记住）。'
    + '\n· `IDENTITY: <emperor|noble|official|warlord|commoner>|<新职衔>|<缘由>`：**仅当主角身份真的发生转变**时才用。'
    + '\n· `BATTLE: <敌军名>|<敌兵力>|<敌阵形 id>|<地形>`：**仅当剧情真的打到要开战**时才用，引擎会挂出「战阵」面板让玩家自行布阵。'
    + '\n示例：若本轮要写「王守仁在正德年间平定宁王之乱」，就先 `SEARCH: 王守仁 正德 宁王之乱`，拿到结果再落笔。'
    + '\n无需检索的只有：纯虚构的日常对话、主角的心理与身体动作。';
  // 引擎自动核查①（写前预检索）：不问模型，引擎自己从存档与输入里抽出该查的词，
  // 先用您配的检索后端（如博查）查好，作为「证据」注入提示词，让模型照着证据写。
  let preEvidence = [];
  if (autoFactCheck) {
    try {
      const qs = factcheck.planPreSearch(state, input);
      if (qs.length) {
        preEvidence = await Promise.all(qs.map(async q => {
          const r = await search(q, { noCache: false }).catch(() => ({ results: [] }));
          return { query: q, provider: r.provider, fallbackFrom: r.fallbackFrom, results: r.results || [], count: (r.results || []).length };
        }));
        const withHits = preEvidence.filter(x => x.count > 0).length;
        if (withHits) {
          prompt += '\n\n=== 引擎自动核查·写前证据（引擎已替你查过，写这一轮须以此为准，不得与之冲突） ===\n'
            + factcheck.evidenceBlock(preEvidence)
            + '\n（这些是引擎主动检索所得；若证据与你的记忆冲突，一律以证据为准。）';
        }
      }
    } catch (e) { /* 检索失败不阻塞 */ }
  }

  // —— 先想后写（用户诉求：生成很不稳定，希望它先想好再落笔）——
  //   第一步只出「构思」（不写正文），第二步把这份构思塞回提示词，逼模型照着写。
  //   这样做的收益：世界推进、NPC 动机、状态变化、信息传播先被固定下来，
  //   正文就不会一边写一边改主意，也就不会出现前后打架、开头莫名其妙。
  let plan = null;
  if (planFirst) {
    // 回合计划卡（《设计书》§7.5）：先定戏剧问题、回合类型、剧情原子、停点，代码校验后才写正文。
    // 配方库只喂给规划这一步（写作步骤不需要它），一个提示词只做一件事。
    try {
      const askPlan = async (extra = '') => {
        const pr = await adapter.call({
          system: searchSystem,
          prompt: prompt + '\n\n' + loadPromptFile('recipes') + PLANNER_SUFFIX
            + `\n\n【玩家本回合原话】「${String(input || '').trim() || '（玩家本回合没写指令）'}」\nplayer_intent 只能从这句原话里拆；剧情块、记忆、旧回合里出现的任何「玩家曾…」都不是本轮指令。`
            + extra,
          temperature: Math.min(temperature == null ? 0.9 : temperature, 0.3),
          maxTokens: 1500,
        }, config);
        return parsePlan(pr.text);
      };
      plan = await askPlan();
      let errs = plan ? validatePlan(plan, state, input) : ['计划卡不是合法 JSON'];
      if (errs.length) {   // 带错误清单重填一次
        const p2 = await askPlan(`\n\n上一版计划卡不合格，逐条改正后重新输出整张卡：\n${errs.map(e => '· ' + e).join('\n')}`);
        if (p2) { const e2 = validatePlan(p2, state, input); if (e2.length < errs.length) { plan = p2; errs = e2; } }
      }
      if (plan) {
        plan.__errors = errs;
        prompt += '\n\n=== 本轮计划卡（已定，正文必须照此写，不得另起一套） ===\n' + renderPlan(plan);
      }
    } catch (e) { /* 规划失败不阻塞正文 */ }
  }
  // 风格指南与示范段落：只喂给写作这一步
  { const sg = loadPromptFile('style_guide'); if (sg) prompt += '\n\n' + sg; }

  // 正文 1200~2000 字再加 JSON 各栏，3000 token 的默认上限会截断（DeepSeek 上限 8192）
  const res = await adapter.call({ system: searchSystem, prompt, temperature, maxTokens: 6000 }, config);
  const { searches, claims, identities, encounters, cleaned } = parseSearch(res.text);

  // 引擎自动核查①：把写前预检索的证据一起纳入（模型没主动查的，引擎已经替它查了）
  const autoEvidence = preEvidence || [];

  let draft, rawText = res.text, didSearches = [];
  const MAXSEARCH = 3;
  const modelEvidence = [];
  if (searches.length) {
    const qs = searches.slice(0, MAXSEARCH);
    const results = await Promise.all(qs.map(q => search(q, { noCache: false }).catch(() => ({ results: [] }))));
    didSearches = qs.map((q, i) => ({ query: q, count: ((results[i] && results[i].results) || []).length, provider: (results[i] || {}).provider, fallbackFrom: (results[i] || {}).fallbackFrom }));
    for (let i = 0; i < qs.length; i++) modelEvidence.push({ query: qs[i], provider: (results[i] || {}).provider, results: (results[i] || {}).results || [] });
    const block = '【实时检索结果，撰写时务必引用、不得与之冲突】\n' + qs.map((q, i) => {
      const r = results[i] || { results: [] };
      const lines = (r.results || []).slice(0, 5).map(x => `  - ${x.title}：${x.snippet}`).join('\n') || '  （无结果）';
      return `· 检索「${q}」：\n${lines}`;
    }).join('\n');
    const finalRes = await adapter.call({ system, prompt: prompt + '\n\n' + block + '\n\n请基于以上检索结果撰写本轮 JSON，严禁虚构与检索结果冲突的史实。', temperature, maxTokens: 6000 }, config);
    rawText = finalRes.text;
    draft = extractJson(rawText);
  } else {
    draft = extractJson(cleaned || res.text);
  }

  // 篇幅补救：实测 DeepSeek 在长提示词下常只写 700 字左右，远低于 1200 字下限（《设计书》§6.8）。
  // 明显不足时扩写一次：已写内容与停点不动，只把对话、阻力与变数写足；扩写后若反而多出红线问题就不用。
  if (draft && draft.scene && vb.min && String(draft.scene).length < vb.min * 0.8) {
    try {
      const orig = String(draft.scene);
      const tail = orig.replace(/\s+$/, '').slice(-24);
      const ex = await adapter.call({
        system: '你是这场戏的同一位作者。只做扩写，不改人物、不改事实、不改停点，不替主角说话或行动，不快进。只输出扩写后的完整正文。',
        prompt: `下面这段正文只有 ${orig.length} 字，要求 ${vb.hint}。请在原文基础上扩写到 ${vb.min}~${vb.max} 字：把在场人物的对话写出来回、把阻力和潜台词写足、补一个具体的物件或声音细节；原文已有的句子尽量保留；最后一段仍停在原来的停点上（原文结尾是：「${tail}」）。\n\n原文：\n${orig}`,
        temperature: 0.8, maxTokens: 6000,
      }, config);
      const longer = String((ex && ex.text) || '').trim();
      const issues = t => plot.checkText(state, t, String(input || '')).filter(i => [5, 11, 15, 17, 19, 20, 21, 22, 23].includes(i.no)).length;
      const iL = issues(longer), iO = issues(orig);
      if (longer.length >= orig.length * 1.3 && longer.length <= vb.max * 1.1 && iL <= iO) {
        draft.expandedFrom = orig.length;
        draft.scene = longer; rawText = longer;
      } else {
        draft.expandNote = `扩写未采用：原 ${orig.length} 字 → 扩写稿 ${longer.length} 字，红线问题 ${iO} → ${iL}`;
      }
    } catch (e) { draft.expandNote = '扩写调用失败：' + String((e && e.message) || e).slice(0, 80); }
  }

  // 引擎自动核查②（写后校验 + 自动订正）：从正文抽出可核验断言，自动查证后逐条判定；
  // 有矛盾就自动按证据改一遍 —— 全过程不需要玩家参与。
  let factReport = null;
  if (autoFactCheck && draft && draft.scene) {
    try {
      const allEvidence = [...autoEvidence, ...modelEvidence].filter(x => x && (x.results || []).length);
      const covered = new Set(allEvidence.map(x => String(x.query)));
      const claimsList = factcheck.extractClaims(String(draft.scene), state);
      const needQueries = [];
      for (const c of claimsList) {
        if (!c.searchable) continue;              // 泛词不单独搜（省额度、也没用）
        if (covered.has(c.text)) continue;
        if (needQueries.length >= factcheck.MAX_POST) break;
        needQueries.push(c.text);
      }
      const extra = await Promise.all(needQueries.map(async q => {
        const r = await search(q, { noCache: false }).catch(() => ({ results: [] }));
        return { query: q, provider: r.provider, results: r.results || [] };
      }));
      const evidence = [...allEvidence, ...extra];
      const v = await factcheck.verifyClaims({ scene: String(draft.scene), state, adapter, config, evidence });
      factReport = {
        rows: v.rows || [],
        contradictions: (v.contradictions || []).map(c => ({ claim: c.claim, why: c.why, fix: c.fix })),
        uncertain: (v.uncertain || []).map(c => ({ claim: c.claim, why: c.why })),
        searched: evidence.map(x => ({ query: x.query, count: (x.results || []).length })),
        error: v.error || null,
      };
      if (factReport.contradictions.length && autoRepair) {
        const fixed = await factcheck.autoRepair({ scene: String(draft.scene), contradictions: v.contradictions, adapter, config });
        if (fixed) {
          // 同上：史实返修也要留痕，把原文与改动原因一并交回，不许悄悄换掉正文
          draft.autoRepaired = true;
          draft.autoRepairReason = v.contradictions.map(c => c.claim).join('、');
          if (!draft.originalScene) draft.originalScene = String(draft.scene);
          draft.scene = fixed; rawText = fixed; factReport.repaired = true;
          // 自动修复等于又让模型改了一次正文 —— 改 A 时很可能顺手造出 B。
          // 所以修完必须**重新核一遍**史实，并把复核结果并入报告，不能再"一修了之"。
          try {
            const re = await factcheck.verifyClaims({ scene: String(fixed), state, adapter, config, evidence });
            factReport.recheck = {
              contradictions: (re.contradictions || []).map(c => ({ claim: c.claim, why: c.why, fix: c.fix })),
              uncertain: (re.uncertain || []).length,
            };
            factReport.recheckStillBad = (re.contradictions || []).length;
            // 修了还错：如实写进正文报告，交给玩家判断，不假装已经修好
            if ((re.contradictions || []).length) {
              factReport.repairedButStillWrong = (re.contradictions || []).map(c => `${c.claim}：${c.why}`);
            }
          } catch { /* 复核失败不阻塞 */ }
        }
      }
    } catch (e) { factReport = { rows: [], contradictions: [], uncertain: [], error: String(e.message || e) }; }
  }

  // —— 剧情硬伤自动返修（一次）：开局急报、未成年理政、死人开口、未传到的消息、已否定设定 ——
  //    这些是用户反复批评过的错，程序查得出来就先让模型按清单改一遍，改完再查；还错就如实挂在审计里拦下。
  // 2026-10-08：按《设计书》§7.3 改为最多重写两次；反馈只写「违反哪条、哪一句、怎么改」，不写长篇说教。
  const REPAIRABLE = [4, 5, 6, 11, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 28];
  if (autoRepair && draft && draft.scene) {
    try {
      const check = t => plot.checkText(state, String(t), String(input || '')).filter(i => REPAIRABLE.includes(i.no));
      const sentenceOf = (t, why) => {
        const q = (String(why).match(/「([^」]{2,30})」/) || [])[1];
        if (!q) return '';
        return (String(t).split(/(?<=[。！？」”])/).find(s => s.includes(q)) || '').trim().slice(0, 80);
      };
      const first = check(draft.scene);
      let cur = String(draft.scene), issues = first, tries = 0;
      while (issues.length && tries < 2) {
        tries += 1;
        const fixed = await factcheck.autoRepair({
          scene: cur,
          contradictions: issues.map(i => ({ claim: sentenceOf(cur, i.why) || i.name, why: `[红线${i.no}] ${i.why}`, fix: '只改这一句，其余一字不动' })),
          adapter, config,
        });
        if (!fixed) break;
        const after = check(fixed);
        if (after.length >= issues.length) break;   // 没变好就不采用，免得越改越坏
        cur = fixed; issues = after;
      }
      if (first.length) {
        if (cur !== String(draft.scene)) {
          // 自动改写必须留痕：让玩家知道这段正文被程序动过，且能拿到原文。
          // 不留痕就是「AI 自己会改、还不告诉你改了什么」——这是最招人反感的一类行为。
          draft.autoRepaired = true;
          draft.autoRepairReason = first.map(i => i.name).join('、');
          draft.originalScene = String(draft.scene);
          draft.scene = cur; rawText = cur;
        }
        draft.storyRepair = { tries, before: first.map(i => `[${i.no}] ${i.why}`), after: issues.map(i => `[${i.no}] ${i.why}`) };
        // 两次仍不过：带标记输出（不藏），由采纳时的审计决定拦不拦
        if (issues.length) draft.unresolved = issues.map(i => `[${i.no}] ${i.why}`);
      }
    } catch (_) { /* 返修失败不阻塞，后面的审计照样会拦 */ }
  }

  // —— 战阵（在拿到 GM 的 BATTLE 宣告之后再定）——
  // ① 玩家本轮已布阵设策（fight 面板提交）→ 推演并写成战况；② 否则若 GM 宣告开战 → 挂成「待战」，界面才出现战阵面板
  if (battleOrders && battleOrders.ourFormation) {
    const A = {
      name: battleOrders.ourName || '我军', troops: Number(battleOrders.ourTroops) || 1000,
      morale: num01(battleOrders.ourMorale, 0.6), training: num01(battleOrders.ourTraining, 0.5),
      formationId: battleOrders.ourFormation, tacticId: battleOrders.ourTactic || 'none',
      supply: battleOrders.ourSupply != null && battleOrders.ourSupply !== '' ? num01(battleOrders.ourSupply, 1) : undefined,
      navy: battleOrders.ourNavy != null ? num01(battleOrders.ourNavy, 0.2) : undefined,
    };
    const B = {
      name: battleOrders.enemyName || (state.encounter && state.encounter.enemyName) || '敌军',
      troops: Number(battleOrders.enemyTroops) || (state.encounter && state.encounter.enemyTroops) || 1000,
      morale: num01(battleOrders.enemyMorale, 0.6), training: num01(battleOrders.enemyTraining, 0.5),
      formationId: battleOrders.enemyFormation || 'yulin', tacticId: battleOrders.enemyTactic || 'none',
    };
    const outcome = battle.resolveBattle(A, B, { terrain: battleOrders.terrain || (state.encounter && state.encounter.terrain) || terrainWord(state), weather: battleOrders.weather || '', seed: `${saveId}|${state.turn}|battle`,
      month: Number(state.clock && state.clock.month) || undefined,
      crossing: battleOrders.crossing || undefined, walls: Number(battleOrders.walls) || 0 });
    state.pendingBattle = {
      ourFormation: fname(A.formationId), ourTactic: tname(A.tacticId),
      enemyFormation: fname(B.formationId), enemyTactic: tname(B.tacticId),
      ourTroops: A.troops, enemyTroops: B.troops,
      terrain: battleOrders.terrain || (state.encounter && state.encounter.terrain) || terrainWord(state), weather: battleOrders.weather || '',
      outcome,
    };
    state.battleLog = state.battleLog || [];
    state.battleLog.push({ turn: state.turn, at: `${state.clock.yearLabel}${state.clock.month}月`, ...state.pendingBattle });
    state.encounter = null;      // 打完就不再有「待战」
  } else {
    if (encounters.length) {
      const e = encounters[0];
      const prev = state.encounter || {};
      state.encounter = {
        enemyName: e.enemyName || prev.enemyName || '敌军',
        enemyTroops: Number(e.enemyTroops) || prev.enemyTroops || 1000,
        enemyFormation: e.enemyFormation || prev.enemyFormation || '',
        terrain: e.terrain || prev.terrain || terrainWord(state),
        ourTroops: prev.ourTroops || 1000,
        at: `${state.clock.yearLabel}${state.clock.month}月`,
      };
    }
    state.pendingBattle = null;
  }
  await writeState(state);

  // 身份转变：身份真的变了才落账（换视角 + 记进身份沿革 + 写日志）
  const changedIdentities = [];
  for (const c of identities.slice(0, 1)) {
    if (!IDM_LABEL_ALL[c.identityModule]) continue;
    const from = state.identityModule || 'official';
    if (from === c.identityModule) continue;
    state.identityModule = c.identityModule;
    if (c.role) state.protagonist.role = c.role;
    state.identityHistory = state.identityHistory || [];
    state.identityHistory.push({
      turn: state.turn, from, to: c.identityModule,
      fromLabel: IDM_LABEL_ALL[from], toLabel: IDM_LABEL_ALL[c.identityModule],
      role: state.protagonist.role, reason: c.reason || '', at: `${state.clock.yearLabel}${state.clock.month}月`,
    });
    if (c.identityModule === 'emperor') {
      state.reigningSovereign = null;
      state.location.controller = `${state.protagonist.name}（自立）`;
    }
    state.log.push({
      turn: state.turn, time: `${state.clock.month}月${state.clock.day}日`, speaker: '身份转变',
      text: `你由「${IDM_LABEL_ALL[from]}」变为「${IDM_LABEL_ALL[c.identityModule]}」${c.role ? '（' + c.role + '）' : ''}。${c.reason || ''}`,
    });
    changedIdentities.push({ from, fromLabel: IDM_LABEL_ALL[from], to: c.identityModule, toLabel: IDM_LABEL_ALL[c.identityModule], role: c.role, reason: c.reason });
  }

  // 地盘变更：把 GM 的 CLAIM 落到地盘表并持久化
  const changedTerritory = applyClaims(state, claims, state.turn + 1);
  if (changedTerritory.length || changedIdentities.length) await writeState(state);

  const report = audit({ pack, state, draft, raw: rawText, adapterId: adapter.id, input, verbosity: vb, prevViolations: state.lastViolations || [] });

  // —— 纳米级剧情审计：P0–P9 十遍扫描 ——
  const prevHistory = Array.isArray(state.passHistory) ? state.passHistory.slice(-12) : [];
  const pr = runPasses({ state, draft, input, prevHistory });
  report.passes = pr;
  // 十遍扫描里的致命项（S0）与三层审查的必过项同等对待：任一命中 → 整轮作废
  if (pr.blocking) {
    report.failed = true;
    for (const b of pr.blockingIssues) {
      report.blockingFailed.push({ id: b.code, name: `十遍扫描 ${b.code} · ${b.title}`, detail: b.detail + (b.fix ? `　改法：${b.fix}` : '') });
    }
  }
  // —— 第二组扫描 P10–P15：世界跑起来对不对（历史 / 资源 / 信息 / NPC / 因果 / 回归）——
  const p2 = runPasses2({ state, draft, input, prevHistory });
  report.passes2 = p2;
  if (p2.blocking) {
    report.failed = true;
    for (const b of p2.blockingIssues) {
      report.blockingFailed.push({ id: b.code, name: `世界扫描 ${b.code} · ${b.title}`, detail: b.detail + (b.fix ? `　改法：${b.fix}` : '') });
    }
  }
  // 留痕：P10–P15 单独记一条，供快照模块定位「最早错误」
  state.auditHistory = (state.auditHistory || []).concat([{ turn: state.turn, codes: p2.codes, at: `${state.clock && state.clock.yearLabel}${state.clock && state.clock.month}月` }]).slice(-20);

  // 历史留痕，供下一轮做「复发/回归」比对
  state.passHistory = (state.passHistory || []).concat([{ turn: state.turn, codes: pr.codes, at: `${state.clock && state.clock.yearLabel}${state.clock && state.clock.month}月` }]).slice(-20);

  // 记下本轮的必过项违规，供下一轮「纠正记录对照」比对
  state.lastViolations = (report.blockingFailed || []).map(x => x.id);
  // 违规计数：同类错误重复出现则升级
  for (const x of (report.blockingFailed || [])) {
    const key = ({ placeholder: 'placeholder', timeleap: 'time_leap', decision: 'silent_action' })[x.id] || 'repeat_after_correction';
    corrections.bumpCount(state, key);
  }
  await writeState(state);

  // 可选：对新增虚构人物自动走重名检索。结果并入审查面板，不做任何"自动改名"动作。
  let verifications = [];
  if (autoVerifyNpcs && (draft.newNpcs || []).length) {
    verifications = await Promise.all(
      draft.newNpcs.filter(n => n.name).map(n =>
        verifyNpcName({ name: n.name, era: state.clock.yearLabel, eraWords: [state.location.polity] })
      )
    );
    for (const v of verifications) {
      report.rows.push({
        id: `npcname:${v.name}`,
        name: `虚构人物重名核对 · ${v.name}`,
        state: v.verdict.state,
        detail: v.verdict.reason,
        evidence: v.evidence,
      });
    }
  }

  // 草稿版本戳：记录这份草稿是**基于第几轮的世界**生成的。
  // applyDraft 凭它拒绝「旧草稿覆盖新世界」——否则连点两次采纳、或多线程各出一份草稿，
  // 后采纳的那份会把先推进的世界悄悄退回去（长局崩坏的经典原因）。
  // —— 剧情质量审计（第十一节 14 项）：正文写完后立刻查 ——
  // 内部日志与玩家正文分离：审计结果只进后台，绝不当成叙事写进正文。
  let plotAudit = null;
  try {
    plotAudit = plot.auditText(state, String(draft.scene || ''), (draft.touchedArcs || []).length ? draft.touchedArcs : null);
    draft.plotAudit = {
      count: plotAudit.count,
      blocking: plotAudit.blocking.map(i => `[${i.no}] ${i.name}：${i.why}`),
      warnings: plotAudit.warnings.map(i => `[${i.no}] ${i.name}：${i.why}`),
    };
    draft.plotArcs = (state.plot.arcs || [])
      .filter(a => !['resolved', 'terminated', 'latent'].includes(a.status))
      .map(a => ({ id: a.id, title: a.title, status: a.status, scale: a.scale, basis: a.basis }));
    draft.plotPlan = { newArcs: plotPlan.newArcs, skipped: plotPlan.skipped, blocked: plotPlan.blocked };
  } catch (e) { /* 审计失败不阻塞 */ }

  draft.baseTurn = state.turn;
  draft.stateVersion = state.version || 0;
  // —— 剥离内部标记：规则包要求模型以「用户决定」四个字收尾，那是给程序看的结束符，
  //    不是正文的一部分。旧链路无处剥离，于是它原样印在正文末尾，玩家看着莫名其妙。
  //    这里把它摘出来放进 pendingDecision，正文里留一个自然的停顿。
  if (draft) {
    // 模型有时把它写在正文末尾，有时写在 pendingDecision 里——两处都要摘。
    // 「用户决定」是给程序看的结束符，玩家正文里不该出现它——无论模型放在末尾还是文中，
    // 一律摘掉（只摘这个标记本身，不动其余文字）。
    const strip = s => String(s || '')
      .replace(/[　\s]*用户决定[　\s。]*/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
    if (typeof draft.scene === 'string') {
      const cleaned = strip(draft.scene).replace(/\n{3,}/g, '\n\n');
      if (cleaned !== draft.scene) { draft.scene = cleaned; draft.decisionMarkerStripped = true; }
    }
    if (typeof draft.pendingDecision === 'string') {
      const pd = strip(draft.pendingDecision);
      if (pd !== draft.pendingDecision) {
        draft.pendingDecision = pd || '等你决断';
        draft.decisionMarkerStripped = true;
      }
    }
    // 摘完若什么都没留下，补一句中性的，界面不至于空着
    if (!String(draft.pendingDecision || '').trim()) draft.pendingDecision = '等你决断';
  }

  // GM 规范第六章的固定栏目：能由引擎算准的（时间、地点、年龄、实际检索）由引擎填，不让模型自报
  try { draft.gmPanels = gmPanels(state, draft, { preEvidence, didSearches }); } catch (_) { /* 栏目生成失败不阻塞 */ }
  // 调用日志（§8.12）：不记 Key、不记整段提示词
  try {
    require('./telemetry').logTurn(state.meta.id, {
      turn: (state.turn || 0) + 1, input: String(input || '').slice(0, 60),
      chars: String(draft.scene || '').length, secs: Math.round((Date.now() - __t0) / 1000),
      planErrors: (plan && plan.__errors) || [], turnType: plan && plan.turn_type,
      redlines: ((draft.storyRepair && draft.storyRepair.before) || []).map(s => s.slice(0, s.indexOf(']') + 1)),
      rewrites: (draft.storyRepair && draft.storyRepair.tries) || 0, unresolved: draft.unresolved || [],
      providers: [...(preEvidence || []), ...(didSearches || [])].map(x => (x.provider || '?') + (x.fallbackFrom ? '·兜底' : '')),
      promptChars: String(prompt || '').length, adapter: adapter && adapter.id,
    });
  } catch (_) { /* 日志失败不影响游戏 */ }

  return { draft, report, plan, system, prompt, adapterId: adapter.id, adapterMeta: res.meta, parseFailed: !!draft.parseFailed, verifications, searches: didSearches, claims: changedTerritory, identityChanges: changedIdentities, event: evt, battle: state.pendingBattle, factCheck: factReport, baseTurn: state.turn, stateVersion: state.version || 0 };
}

/* 年龄按史实重算：有生年者用「公元年 − 生年 + 1」精确推算，无生年者按跨年数递增。
   真人（主角与历史人物）优先走精确路径，避免年龄与史实脱节或跨年后不更新。 */
function recomputeAges(state, yearsPassed) {
  const gy = state.clock.gregorianYear || 0;
  const gyOld = gy - yearsPassed;
  const fix = obj => {
    if (!obj || obj.age == null) return;
    if (!obj.birthYear && gyOld) obj.birthYear = gyOld - obj.age + 1;
    if (obj.birthYear) obj.age = gy - obj.birthYear + 1;
    else obj.age += yearsPassed;
  };
  fix(state.protagonist);
  (state.npcs || []).forEach(fix);
  ((state.household && state.household.members) || []).forEach(fix);
}

/**
 * 采纳草稿：此时才推进世界。
 * edits 里玩家可以删改 NPC、勾选要保留为「继续追查」的线索。
 */
async function applyDraft({ saveId, draft, input, advanceDays, edits, force }) {
  const state = await loadState(saveId);

  // —— ① 版本锁：旧草稿不得覆盖新世界（长局稳定性 · 第二批指令第 11 项）——
  // 草稿带着它是基于第几轮生成的（baseTurn）。若世界已经往前走了，
  // 说明这份草稿是过期的，采纳它会把世界悄悄退回过去，且无从察觉。
  const base = (draft && draft.baseTurn != null) ? Number(draft.baseTurn) : null;
  if (base !== null && Number.isFinite(base) && base !== Number(state.turn || 0)) {
    if (!force) {
      return {
        ok: false, stale: true,
        why: `这份草稿是第 ${base} 轮出的，而世界已经走到第 ${state.turn || 0} 轮。` +
             `旧草稿已作废（直接采纳会把世界退回过去），请重新生成本轮内容。`,
        baseTurn: base, currentTurn: Number(state.turn || 0),
      };
    }
  }

  // —— ② 反迎合 / 反剧情作弊（第二批指令 · 高级机制 B）——
  // 在写状态**之前**查：命中硬规则一律拒绝采纳，不让「围着玩家改规则」混进存档。
  let antiCheat = [];
  try {
    antiCheat = anticheat.check({ state, draft, scene: String((draft && (draft.scene || draft.text)) || '') });
  } catch { /* 校验本身出错不阻断游戏，但会留痕 */ }
  const blockers = anticheat.blocking(antiCheat);
  if (blockers.length && !force) {
    return {
      ok: false, antiCheat: true,
      why: '这一轮有 ' + blockers.length + ' 处「围着玩家改规则」的写法，已拦下：\n' + anticheat.render(blockers),
      violations: blockers, warnings: antiCheat.filter(x => !blockers.includes(x)),
    };
  }

  // —— ③ 剧情质量审计（第十一节 14 项）：阻断项必须在写状态前拦下 ——
  // 与反作弊不同，这里查的是「剧情本身成不成立」：
  // 有没有起因、人物能不能做这件事、消息到没到、是不是旧剧情换了名字。
  plot.ensurePlot(state);
  let plotAudit = null;
  try {
    plotAudit = plot.auditText(state, String((draft && (draft.scene || draft.text)) || ''), (draft && draft.plotArcs) ? draft.plotArcs.map(a => a.id) : null);
  } catch (_) { /* 审计出错不阻断 */ }
  if (plotAudit && plotAudit.blocking.length && !force) {
    return {
      ok: false, plotAudit: true,
      why: '这一轮的剧情过不了质量审计（' + plotAudit.blocking.length + ' 处硬伤），已拦下：\n'
        + plotAudit.blocking.map(i => `· [${i.no}] ${i.name}：${i.why}`).join('\n'),
      blocking: plotAudit.blocking, warnings: plotAudit.warnings,
    };
  }

  const e = edits || {};
  plot.commitPending(state);   // 采纳了，本回合规划的剧情线才转正
  // 长线落账：先收模型的变更申请（关系值、伏笔、回合类型），再由代码推进时钟与无代价计数
  try {
    const ll = require('./longline');
    const pr = ll.applyPatch(state, draft || {});
    const ev = ll.advanceWorld(state, input, draft || {});
    state.longlineLast = { turn: state.turn, rejected: pr.rejected, events: ev };
  } catch (_) { /* 长线落账失败不阻断采纳 */ }
  // 篇章、路线分、对手幕后行动、回合摘要（都在 state.turn 自增之前记账）
  try {
    const ar = require('./arcs');
    const ra = ar.onAccept(state, draft || {});
    ar.onAcceptOpponents(state, draft || {});
    require('./memory').onAccept(state, draft || {}, input);
    if (ra.rejected.length || ra.bill || ra.checkpoint) state.arcsLast = { turn: state.turn, ...ra };
  } catch (_) { /* 长线落账失败不阻断采纳 */ }
  state.turn += 1;
  state.version = (state.version || 0) + 1;

  if (typeof advanceDays === 'number' && advanceDays > 0) {
    let y = state.clock.gregorianYear || 0;
    let m = state.clock.month || 1;
    let d = (state.clock.day || 1) + advanceDays;
    // 简易进位（30 天一月）：超出即逐级进位，跨年时按史实重算所有人年龄
    while (d > 30) { d -= 30; m += 1; if (m > 12) { m = 1; y += 1; } }
    const yearsPassed = Math.max(0, y - (state.clock.gregorianYear || 0));
    state.clock.day = d; state.clock.month = m; state.clock.gregorianYear = y;
    // 季节随月份走（旧版开局写「冬」就永远是冬）：正二三春、四五六夏、七八九秋、十冬腊冬
    state.clock.season = ['春', '春', '春', '夏', '夏', '夏', '秋', '秋', '秋', '冬', '冬', '冬'][(m - 1) % 12];
    if (yearsPassed > 0) {
      const oldY = (state.clock.gregorianYear || 0) - yearsPassed;
      recomputeAges(state, yearsPassed);
      // 旧实现往年号后面追加「（已跨年，年号需人工校正）」，再跨年就再追加一次，
      // 最后变成「大中十四年（已跨年…）（已跨年…）」—— 纯属污染。
      // 改为按新公元年反查年号；查不到就只标一个待核，不动年号本身。
      const nl = reignLabelFor(y);
      if (nl) { state.clock.yearLabel = nl; state.clock.reignNeedsCheck = false; }
      else { state.clock.reignNeedsCheck = true; }

      // 长线核实：所有真实人物（主角 + 历史 NPC）随年份推进
      // 用户原话：「我选择的所有人物都要有合理的搜索和开局以及不断的历史核实，
      //            你目前长线不行，跟不上历史变化」。
      // 只改年龄是不够的——跑到 552 年萧纪已经称帝、554 年已被杀，
      // 若存档还写着「益州刺史」「在世」，后面的派系/地盘/剧情全都建在错的人身上。
      const figChanges = advanceAllFigures(state, oldY, y);
      if (figChanges.length) {
        state.figureLog = (state.figureLog || [])
          .concat(figChanges.map(c => ({ ...c, turn: state.turn, year: y })))
          .slice(-200);
      }
      // 主角若已到卒年，明确立碑，让后续叙事知道「此人已不在」
      if (state.protagonist && state.protagonist.status === '已故') {
        state.protagonistDead = { name: state.protagonist.name, year: y, note: (figure.dossierAt(state.protagonist.name, y) || {}).deathNote || '' };
      }
      // 已确认的史实（如台城陷落）随年份自动结算，不必等玩家问
      try {
        const tl = require('./timeline');
        const polity = (state.location && state.location.polity) || null;
        const done = tl.eventsBefore(polity, y, state.clock.month, state.clock.day)
          .filter(e => !(state.settledEvents || []).includes(e.id));
        if (done.length) {
          state.settledEvents = (state.settledEvents || []).concat(done.map(e => e.id));
          state.figureLog = (state.figureLog || []).concat(done.map(e => ({
            name: e.id, kind: 'event', turn: state.turn, year: y,
            text: `${e.y}年${e.m ? `${e.m}月` : ''}：${e.text}（已发生，世界状态据此结算；${e.src}）`,
          }))).slice(-200);
        }
      } catch (_) { /* timeline 不可用时不影响推进 */ }
    }
    // —— 每次推进都要做的（不只跨年）——
    // ① 天下大势按「此时此地已传到的消息」重算：旧版只在开局切一次，
    //    之后哪怕走到 553 年，提示词里的「天下大势」还停在 548 年。
    try { worldgen.refreshEraEvents(state); } catch (_) { /* 无年表不影响推进 */ }
    // ② 主角卒月判定：萧纪卒于 553 年 7 月，年内推进到 8 月也必须立碑，不能等到跨年
    try {
      const pst = state.protagonist && figure.statusAt(state.protagonist.name, y, m);
      if (pst && !pst.alive && !state.protagonistDead) {
        state.protagonist.status = '已故'; state.protagonist.alive = false;
        state.protagonistDead = { name: state.protagonist.name, year: y, month: m, note: pst.deathNote || '' };
      }
    } catch (_) { /* 无档案不判 */ }
  }

  // dropNpcs 的语义是「删掉这些 NPC」：过去只拿来过滤新登场的，
  // 已有的人删不掉（点了删除却还在），是实打实的功能 bug。现真正从名籍里除名。
  const dropNpcs = (e.dropNpcs || []).filter(Boolean);
  if (dropNpcs.length) {
    state.npcs = (state.npcs || []).filter(n => !dropNpcs.includes(n.name));
  }
  const incoming = (draft.newNpcs || []).filter(n => !dropNpcs.includes(n.name));
  for (const n of incoming) {
    // 本轮 GM 让他登场 = 与主角产生了交集，从此才谈得上态度与动机
    const i = state.npcs.findIndex(x => x.name === n.name);
    if (i >= 0) state.npcs[i] = { ...state.npcs[i], ...n, contact: true };
    else state.npcs.push({ ...n, contact: true, firstSeenTurn: state.turn });
  }
  // 正文里若出现了此前「无交集」的同代真人，也认定为已打过交道
  const scene = String(draft.scene || '');
  if (scene) {
    for (const n of state.npcs) {
      if (!npcHasContact(n) && n.name && scene.includes(n.name)) n.contact = true;
    }
  }

  for (const t of draft.touchedThreads || []) {
    const th = state.threads.find(x => x.title === t);
    if (th) { th.lastTouchedTurn = state.turn; th.note = `第${state.turn}轮触及`; }
    else state.threads.push({ id: `t${Date.now().toString(36)}`, title: t, status: 'open', lastTouchedTurn: state.turn, note: '由本轮叙事产生' });
  }
  for (const c of e.closeThreads || []) {
    const th = state.threads.find(x => x.title === c);
    if (th) { th.status = 'dropped'; th.lastTouchedTurn = state.turn; th.note = '玩家主动搁置'; }
  }
  for (const c of e.resolveThreads || []) {
    const th = state.threads.find(x => x.title === c);
    if (th) { th.status = 'resolved'; th.lastTouchedTurn = state.turn; }
  }

  // —— 世界自行推进：玩家不动，世界也在动（NPC 自己排队做事 / 消息往外传 / 分歧扩散 / 经济与季节）——
  const advDays = (typeof advanceDays === 'number' && advanceDays > 0) ? advanceDays : 0;
  const worldChanges = world.tickWorld(state, advDays);      // 季节/天气/交通/经济/疫病/宏观/秩序
  const npcActions = agency.tickNpcs(state, advDays);        // NPC 独立行动队列
  const rumors = info.spread(state, advDays);                // 信息传播：延迟/遗漏/误传/谣言
  const ripples = div.propagate(state, advDays);             // 历史分歧一级一级往外走
  state.worldChanges = [].concat(worldChanges || [], ripples || []);
  state.npcActions = npcActions || [];
  state.rumors = rumors || [];

  if (input) state.log.push({ turn: state.turn, time: `${state.clock.month}月${state.clock.day}日`, speaker: '玩家', text: input });
  state.log.push({ turn: state.turn, time: `${state.clock.month}月${state.clock.day}日`, speaker: 'GM', text: draft.scene || '' });
  if (draft.worldNote) state.log.push({ turn: state.turn, time: '', speaker: '世界大事', text: draft.worldNote });

  // 每轮结束存一份档案卡快照（版本化，便于换对话或回查）
  await snapshotCard(state);

  // —— 完整状态快照（可回滚）：每 5 轮一份；地盘易主 / 有人死 / 身份变更 / 开战后强制一份 ——
  const major = (draft.touchedThreads || []).length > 2 || !!state.pendingBattle
    || /易主|失守|攻克|身亡|被杀|斩|抄家|举兵/.test(String(draft.scene || ''));
  snapshot.snapshot(state, { every: 5, force: major, label: major ? '重大事件后' : '' });

  // —— 剧情结算：状态机推进 + 世界状态变化入账（第六层）——
  // 正文已经写了，这里落实「实际发生了什么」。没有实际变化就记「无成果」，不许虚构后果。
  let plotSettle = null;
  try {
    plotSettle = plot.settleArcs(state, {
      touched: (draft && draft.touchedArcs) || [],
      effects: (draft && draft.plotEffects) || [],
      noResult: (draft && draft.plotNoResult) || [],
    });
    state.plotSettle = plotSettle;
  } catch (_) { /* 结算失败不影响推进 */ }

  // —— 每轮名籍体检：不是开局核一次就完事（用户原话「不断的历史核实」）——
  // 人物会随年份死、会称帝、会易主；每轮都重查一遍，问题明摆在 state.figureIssues。
  try {
    const a = figure.auditAll(state);
    state.figureIssues = a.issues;
    state.figureAudit = Object.assign({}, state.figureAudit || {}, { lastAuditTurn: state.turn, lastAuditYear: a.year, issues: a.issues });
  } catch (_) { /* 体检失败不影响推进 */ }

  // GM 规范第十章：每回合采纳后静默更新本地档案卡 / 人物表 / 速查表（历史RPG存档/<存档名>/）
  try { require('./gmCard').writeCards(state); } catch (_) { /* 写卡失败不影响推进 */ }

  await writeState(state);
  return state;
}

/**
 * 玩家一键标记（《设计书》§7.6）：好看 / 出戏 / 错史 / 无聊，可附一句话。
 * 「出戏」「错史」同时进纠正库（下一轮提示词里逐条对照；写成「错→对」的还会被程序比对，红线 R10）。
 */
async function flagTurn({ saveId, turn, flag, note } = {}) {
  const FLAGS = ['好看', '出戏', '错史', '无聊'];
  if (!FLAGS.includes(flag)) throw new Error(`标记只能是：${FLAGS.join('、')}`);
  const state = await loadState(saveId);
  state.playerFlags = (state.playerFlags || []).concat([{ turn: turn != null ? turn : state.turn, flag, note: String(note || '').slice(0, 200), at: new Date().toISOString() }]).slice(-300);
  if ((flag === '出戏' || flag === '错史') && String(note || '').trim()) {
    corrections.addCorrection(state, { text: String(note).trim(), key: flag === '错史' ? 'missed_ripple' : 'repeat_after_correction', turn: turn != null ? turn : state.turn });
  }
  await writeState(state);
  return { ok: true, stats: flagStats(state) };
}
function flagStats(state) {
  const f = state.playerFlags || [];
  const by = {}; for (const x of f) by[x.flag] = (by[x.flag] || 0) + 1;
  const recent = f.slice(-10);
  const rb = {}; for (const x of recent) rb[x.flag] = (rb[x.flag] || 0) + 1;
  return { total: f.length, by, last10: rb, notes: f.filter(x => x.note).slice(-5).map(x => `第${x.turn}轮〔${x.flag}〕${x.note}`) };
}

/** 统计面板（§8.12）：每十回合红线命中率、重写率、未解决率、玩家标记分布 */
async function getStats(saveId) {
  const state = await loadState(saveId);
  const tm = require('./telemetry');
  const s = tm.stats(saveId, state);
  let arcs = null;
  try { const ar = require('./arcs'); const A = ar.ensureArcs(state); arcs = { 章: A.chapters.length, 路线分: A.routeScores, 账单: A.bills.slice(-3), 检查点: A.checkpoints }; } catch (_) { /* 无 */ }
  return { ...s, arcs, text: tm.renderStats(s) };
}

/** 玩家指令「档案卡」「速查表」：现生成并写盘，返回三份内容与所在文件夹 */
async function getGmCards(saveId) {
  const state = await loadState(saveId);
  try { economy.eco(state); worldgen.refreshEraEvents(state); } catch (_) { /* 旧档修复失败也照常出卡 */ }
  return require('./gmCard').writeCards(state);
}

/* ================= 版本化档案卡：每轮结束存一份快照 =================
   作用：换新对话、或想回头查「当时是什么状态」时，直接取那一轮的卡。 */
async function snapshotCard(state) {
  state.cards = state.cards || [];
  const card = archiveCard(state);
  state.cards.push({ turn: state.turn, at: `${state.clock.yearLabel}${state.clock.month}月${state.clock.day}日`, card });
  if (state.cards.length > 200) state.cards = state.cards.slice(-200);
  return card;
}
async function listCards(saveId) {
  const s = await loadState(saveId);
  return { count: (s.cards || []).length, cards: (s.cards || []).slice(-30) };
}

/* ================= 纠正记录库的读写 ================= */
async function addCorrection({ saveId, text, key }) {
  const s = await loadState(saveId);
  corrections.addCorrection(s, { text, key, turn: s.turn });
  await writeState(s);
  return { ledger: corrections.getLedger(s), escalated: corrections.escalated(s) };
}
async function getCorrections(saveId) {
  const s = await loadState(saveId);
  return { ledger: corrections.getLedger(s), escalated: corrections.escalated(s), presets: corrections.PRESET_PITFALLS };
}

/* ================= 人判断打勾（由用户填，系统不自评） ================= */
/* 人判断层：不是摆设。
   你判「有问题」的项会**立刻写进纠正记录库**并计入该失误类型的次数，
   于是下一轮的提示词（纠正记录库一节）会把它列出来，要求 GM 逐条对照；
   同一类型累计够多还会自动升级为「反复出现的失误」。
   判「没问题」只作留痕，不进纠正记录。 */
const HUMAN_KEY_MAP = {
  drama: 'summary_style', scene: 'summary_style', manners: 'summary_style',
  era: 'modern_terms', omniscient: 'omniscient', history: 'claim_checked',
  numbers: 'number_drift', fairness: 'silent_action',
};
const HUMAN_LABEL = {
  drama: '剧情是否有戏剧性、张力', scene: '是否写出了具体场景',
  manners: '人情世故是否对', era: '语域是否匹配身份',
  history: '史实对不对', numbers: '具体数字是否合理',
  fairness: '是否保留了真实挫折与代价', omniscient: '有没有未卜先知 / 上帝视角',
};
async function setHumanChecks({ saveId, turn, checks }) {
  const s = await loadState(saveId);
  const t = turn != null ? turn : s.turn;
  s.humanChecks = s.humanChecks || {};
  const prev = s.humanChecks[t] || {};
  const next = { ...prev, ...(checks || {}) };
  s.humanChecks[t] = next;
  const added = [];
  for (const [k, v] of Object.entries(checks || {})) {
    if (v !== 'bad' || prev[k] === 'bad') continue;   // 只在新判为「有问题」时记一笔，避免重复堆
    const label = HUMAN_LABEL[k] || k;
    const text = `第${t}轮：你判定「${label}」有问题`;
    corrections.addCorrection(s, { text, key: HUMAN_KEY_MAP[k] || 'repeat_after_correction', turn: t });
    corrections.bumpCount(s, HUMAN_KEY_MAP[k] || 'repeat_after_correction');
    added.push(label);
  }
  await writeState(s);
  return { turn: t, checks: next, addedToLedger: added, escalated: corrections.escalated(s) };
}

async function updateThread({ saveId, title, action }) {
  const state = await loadState(saveId);
  const th = state.threads.find(t => t.title === title);
  // 找不到时如实告知，别抛异常让界面显示 undefined（「很多功能用不了」的成因之一）
  if (!th) return { ok: false, why: `线索不存在：${title}。当前在册：${(state.threads || []).map(t => t.title).slice(0, 5).join('、') || '（无）'}` };
  th.status = action;
  th.lastTouchedTurn = state.turn;
  await writeState(state);
  return state;
}

async function updateNpc({ saveId, name, patch, fields }) {
  const state = await loadState(saveId);
  const n = (state.npcs || []).find(x => x.name === name);
  if (!n) return { ok: false, why: `人物不存在：${name}。当前在册：${(state.npcs || []).map(x => x.name).slice(0, 5).join('、') || '（无）'}` };
  Object.assign(n, patch || fields || {});
  await writeState(state);
  return state;
}

/* 战阵辅助 */
const num01 = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d; };
const fname = id => (battle.FORMATIONS.find(f => f.id === id) || {}).name || '';
const tname = id => (battle.TACTICS.find(t => t.id === id) || {}).name || '';
function terrainWord(state) {
  const g = state.geography || {};
  const blob = [g['地形'], state.location && state.location.full].filter(Boolean).join(' ');
  if (/山|丘|岭/.test(blob)) return '丘陵';
  if (/水|江|河|湖|泽|海/.test(blob)) return '水乡';
  return '平原';
}

/**
 * 身份转变：中途从百姓变官员、变军阀、甚至称帝。
 * 引擎只负责「记账 + 换视角」，并把转变写进日志，让叙事接得上；
 * 具体怎么变的（投军、科举、起兵、被拥立）由当轮剧情交代。
 */
const IDM_LABEL_ALL = { emperor: '皇帝', noble: '宗室/贵族', official: '官员', warlord: '军阀/独立领主', commoner: '平民' };
async function changeIdentity({ saveId, identityModule, role, reason, controller }) {
  const state = await loadState(saveId);
  const from = state.identityModule || 'official';
  const to = identityModule || from;
  if (!IDM_LABEL_ALL[to]) throw new Error('未知身份类型：' + to);
  state.identityModule = to;
  if (role) state.protagonist.role = role;
  state.identityHistory = state.identityHistory || [];
  state.identityHistory.push({
    turn: state.turn,
    from, to,
    fromLabel: IDM_LABEL_ALL[from], toLabel: IDM_LABEL_ALL[to],
    role: state.protagonist.role,
    reason: reason || '',
    at: `${state.clock.yearLabel}${state.clock.month}月`,
  });
  // 称帝/自立：你自己就是当朝天子，不再是「非人主」；所在地控制者也应随之改变
  if (to === 'emperor') {
    state.reigningSovereign = null;
    state.location.controller = controller || `${state.protagonist.name}（自立）`;
  } else if (controller) {
    state.location.controller = controller;
  }
  // 落入某个身份该有的资源位（避免换身份后还是旧的一栏）
  state.resources = ({ ...(state.resources || {}) });
  state.log.push({
    turn: state.turn, time: `${state.clock.month}月${state.clock.day}日`, speaker: '身份转变',
    text: `你由「${IDM_LABEL_ALL[from]}」变为「${IDM_LABEL_ALL[to]}」${role ? '（' + role + '）' : ''}。${reason || ''}`,
  });
  await writeState(state);
  return state;
}

/** 档案卡：下一次对话只要喂这张卡就能续档 */
function archiveCard(state) {
  const openThreads = (state.threads || []).filter(t => t.status === 'open');
  return [
    `【档案简明卡】${state.meta.title}`,
    `规则包：${state.meta.ruleset} | 第 ${state.turn} 轮`,
    `人：${state.protagonist.name}，${state.protagonist.age != null ? state.protagonist.age : '?'} 岁，${state.protagonist.role}`,
    `时：${state.clock.yearLabel}（公元 ${state.clock.gregorianYear} 年）${state.clock.month}月${state.clock.day}日 ${state.clock.season}`,
    `地：${state.location.full} | 隶属 ${state.location.polity} | 控制者 ${state.location.controller}`,
    `资源：${Object.entries(state.resources || {}).map(([k, v]) => `${k}=${v}`).join('、') || '未登记'}`,
    `有交集的人物：${(() => {
      const c = (state.npcs || []).filter(n => npcHasContact(n)).slice(0, 8)
        .map(n => `${n.name}(${n.age}岁) ${n.role}${n.attitude ? '，态度：' + n.attitude : ''}`);
      return c.join('；') || '无';
    })()}`,
    ...(state.identityHistory && state.identityHistory.length
      ? [`身份沿革：${[IDM_LABEL_ALL[state.identityHistory[0].from] || state.identityHistory[0].fromLabel, ...state.identityHistory.map(h => h.toLabel)].join(' → ')}`]
      : []),
    `紧迫问题：${openThreads.slice(0, 5).map(t => t.title).join('；') || '无'}`,
    `末轮摘要：${(() => { const l = (state.log || []).filter(x => x.speaker === 'GM').slice(-1)[0]; return l ? l.text.slice(0, 120) + '…' : '（无）'; })()}`,
    `性格倾向：${state.protagonist.disposition || '未登记'}`,
  ].join('\n');
}

/* ================= 世界运行六模块的对外接口 ================= */

/* 快照列表 / 回滚 / 最早错误定位 / 修复计划 */
async function getSnapshots(saveId) {
  const s = await loadState(saveId);
  return { list: snapshot.listSnapshots(s), rolledBackFrom: s.rolledBackFrom || null };
}
async function rollbackSave({ saveId, to }) {
  const state = await loadState(saveId);
  const r = snapshot.rollback(state, to);
  if (!r.ok) return r;
  const st = r.state;
  st.log = (st.log || []).concat([{
    turn: st.turn, time: `${st.clock.month}月${st.clock.day}日`, speaker: '回滚',
    text: `已回滚到 ${r.snap.id}（第 ${r.snap.turn} 轮，${r.snap.at}）。${r.rolledBackFrom ? `原进度：第 ${r.rolledBackFrom.turn} 轮。` : ''}`,
  }]);
  await writeState(st);
  return { ok: true, snap: r.snap, turn: st.turn };
}
async function snapshotNow(saveId) {
  const s = await loadState(saveId);
  const r = snapshot.snapshot(s, { force: true, label: '手动' });
  await writeState(s);
  return { ok: !!r, snap: r };
}
async function getRepairPlan(saveId) {
  const s = await loadState(saveId);
  return snapshot.repairPlan(s);
}
async function getImpact(saveId, code) {
  const s = await loadState(saveId);
  return snapshot.impacted(s, code);
}

/* 历史锚点 / 因果链 / 反事实检验 */
async function addHistoryAnchor({ saveId, year, text, must = [], mustNot = [], source = '', hard = true }) {
  const s = await loadState(saveId);
  const a = div.addAnchor(s, { year, text, must, mustNot, source, hard });
  await writeState(s);
  return a;
}
async function addCausal({ saveId, cause, causeScale, causeRadius, effect, effectScale, effectRadius, lagDays, via = [], evidence = '' }) {
  const s = await loadState(saveId);
  const c = div.registerCausal(s, { cause, causeScale, causeRadius, effect, effectScale, effectRadius, lagDays, via, evidence });
  await writeState(s);
  return c;
}
async function runCounterfactual({ saveId, chainId, replaceWith }) {
  const s = await loadState(saveId);
  const r = div.counterfactual(s, { removeChainId: chainId, replaceWith });
  await writeState(s);
  return r;
}

/* NPC 决策：玩家提要求时，引擎按「利益+风险+信息+关系+资源+性格」算他答不答应 */
async function npcDecide({ saveId, npcName, request }) {
  const s = await loadState(saveId);
  const r = agency.decide(s, npcName, request || {});
  if (!r) return { ok: false, why: `没有这个人物：${npcName}` };
  await writeState(s);
  return { ok: true, ...r };
}

/* 世界面板：24 项状态 + 经济 + 信息矩阵 + 人物动向 + 分歧 */
/**
 * 世界面板：**只读**。
 * 过去它会 ensure* 一堆结构再 writeState —— 于是「只是打开面板看看」也会改存档。
 * 现在在副本上初始化、只渲染、绝不落盘。
 */
async function getWorld(saveId) {
  const loaded = await loadState(saveId);
  const s = typeof structuredClone === 'function' ? structuredClone(loaded) : JSON.parse(JSON.stringify(loaded));
  world.ensureWorld(s); economy.eco(s); info.ensureFacts(s); agency.ensureAgency(s); div.ensureDiv(s);
  return {
    worldText: world.renderWorld(s),
    economyText: economy.renderEconomy(s),
    agencyText: agency.renderAgency(s),
    infoText: info.renderInfo(s),
    divergenceText: div.renderDivergence(s),
    sections: world.SECTIONS.map(([k, f]) => ({ 项: k, 值: f(s) })).filter(x => x.值 != null && x.值 !== ''),
    matrix: info.infoMatrix(s),
    npcActions: s.npcActions || [],
    rumors: s.rumors || [],
    worldChanges: s.worldChanges || [],
    anchors: (s.divergence && s.divergence.anchors) || [],
    chain: (s.divergence && s.divergence.chain) || [],
    ripples: (s.divergence && s.divergence.ripples) || [],
    // 旧档体检：开局剧情是否还是「随机模板池」年代的产物（前端据此提示重算）
    plotStale: worldgen.needsPlotRebuild(s),
    // 人物长线核实：体检结果 / 逐年结算流水 / 身份待确认（前端据此提示玩家）
    // 剧情系统：给玩家看的是「可观察层」，后台日志另走 /api/plot/audit，两者不混
    plot: {
      summary: plot.summarize(s),
      visible: plot.renderPlotBlock(s),
    },
    plotAudit: (s.plot && s.plot.auditLog) ? s.plot.auditLog.slice(-3) : [],
    figureIssues: s.figureIssues || ((s.figureAudit && s.figureAudit.issues) || []),
    figureLog: (s.figureLog || []).slice(-30),
    identityIssue: s.identityIssue || null,
    protagonistDead: s.protagonistDead || null,
    seedVerify: s.seedVerify || null,
    figureGen: s.figureGen || null,
  };
}

/* —— 旧档剧情重算：把「随机模板池」年代生成的开局剧情，换成历史驱动版 ——
   历史依据：旧档的开局是「父亲临终半句话」「井里死了人」「陇西的马场」这类通用狗血，
   与该年真实发生的事毫无关系（南朝梁太清二年，梁武帝正被侯景围在台城）。
   此接口只重算引擎生成的 threads/opening/factions，不动玩家手填的档案与人物。 */
async function replotSave({ saveId } = {}) {
  const state = await loadState(saveId);
  if (!worldgen.needsPlotRebuild(state)) {
    return { ok: true, rebuilt: false, note: '该档的开局已是历史驱动版，无需重算' };
  }
  const diff = worldgen.rebuildPlot(state);
  await writeState(state);
  return { ok: true, rebuilt: true, diff };
}

/* —— 档案核定：按搜索结果（重新）核定主角真实身份，并写档 —— */
async function identifyDossier({ name, year, polity } = {}) {
  return dossier.identify(name, Number(year) || 0, polity || '');
}

async function applyDossierToSave({ saveId, name, year, polity, force } = {}) {
  const state = await loadState(saveId);
  const nm = name || (state.protagonist && state.protagonist.name) || '';
  const gy = Number(year) || (state.clock && state.clock.gregorianYear) || 0;
  const d = await dossier.identify(nm, gy, polity || (state.location && state.location.polity) || '');
  const out = { ok: false, dossier: d, changes: [], corrected: null };
  if (!d.found) { out.dossier = d; return out; }
  // 原为 `force: !!force || true` —— 该式恒为真，force 参数形同虚设
  const ch = dossier.applyToState(state, d, { force: force !== false });
  out.changes = ch.changed;
  // 同样的「皇帝错选」纠正也在这里生效：重新核定后若身份非君主却标着皇帝，纠正之
  const isRuler = dossier.roleIsRuler(d.role);
  if (state.identityModule === 'emperor' && !isRuler) {
    const to = dossier.classifyIdentity(d.role);
    state.identityCorrected = {
      from: 'emperor', to,
      note: `重新核定后更正：你勾选了「皇帝」，但「${d.name}」的真实身份是「${d.role}」，并非君主。已按真实身份更正为「${IDM_LABEL_ALL[to]}」。`,
    };
    state.identityModule = to;
    out.corrected = state.identityCorrected;
  }
  state.dossier = mergeDossier(state.dossier, d);
  state.dossierError = null;
  await writeState(state);
  out.ok = true;
  return out;
}

async function getDossier({ saveId } = {}) {
  const state = await loadState(saveId);
  return {
    dossier: state.dossier || null,
    dossierError: state.dossierError || null,
    identityCorrected: state.identityCorrected || null,
    dossierChanges: state.dossierChanges || null,
  };
}

module.exports = {
  generateFigure, getGmCards, flagTurn, getStats,
  ensureDirs, listSaves, loadState, writeState, listRulepacks, loadPack, createSave, createCustomSave, deleteSave, sweepArchives,
  listLore, loadLore, saveLore, runTurn, applyDraft, updateThread, updateNpc, archiveCard, seedWorld, parseSearch,
  applyClaims, changeIdentity, IDM_LABEL_ALL, snapshotCard, listCards, addCorrection, getCorrections, setHumanChecks,
  identifyDossier, applyDossierToSave, getDossier,
  getSnapshots, snapshotNow, rollbackSave, getRepairPlan, getImpact,
  addHistoryAnchor, addCausal, runCounterfactual, npcDecide, getWorld, getArchive, replotSave, verifyProtagonistOnSeed,
  verifyFiguresOnSeed, advanceAllFigures, auditFigures, checkInit,
  getPlot, getPlotAudit, recordPlotEffect,
  // 纯函数导出以便自测（JSON 解析 / 年号反查）
  extractJson, reignLabelFor,
};
