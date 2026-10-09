'use strict';
/**
 * 诚实审查器（对应 v4.0 方案B）
 *
 * 原则：只报告它能机械验证的项目。每一条给出三态之一：
 *   通过 / 存疑 / 信息缺口
 * 凡是它验证不了的东西（史实正误、语域、推理断层），一律标「信息缺口」，
 * 绝不在看不到证据的情况下打勾。
 */
const BUILTIN_VAGUE = ["某某某某", "某某人", "某人"];
const { modernHitsIn } = require('./eraVocab');
const { checkNumbers } = require('./numeric');
const { getLedger, escalated } = require('./corrections');

/* ============================================================
   三层分级的检查项（对应需求清单）：
     machine —— 机械可查：字数、关键词、格式、占位符、数字区间
     table   —— 要对照表：年龄、官职、NPC关系、已关闭线索
     human   —— 只能人判断：戏剧性、人情世故（系统只列，由用户打勾）
   blocking —— 必过项：决定权、快进、占位符、重名。任一不过 → 整轮作废。
   ============================================================ */
function row(id, name, tier, state, detail, opts = {}) {
  return { id, name, tier, state, detail, blocking: !!opts.blocking, evidence: opts.evidence, human: tier === 'human' };
}

function vaguePatterns(pack) {
  const fromPack = (pack.vagueReferencePatterns || []).map(p => new RegExp(p, 'g'));
  const builtin = BUILTIN_VAGUE.map(t => new RegExp(t, 'g'));
  return [...fromPack, ...builtin];
}

function scanPlaceholders(text, pack) {
  const hits = [];
  for (const t of pack.bannedTokens || []) {
    if (text.includes(t)) hits.push(`禁用词「${t}」`);
  }
  for (const re of vaguePatterns(pack)) {
    const m = text.match(re);
    if (m) hits.push(...m.map(x => `模糊指代「${x}」`));
  }
  return hits;
}

function scanTimeLeaps(text, pack) {
  const hits = [];
  for (const p of pack.timeLeapPatterns || []) {
    const re = new RegExp(p, 'g');
    const m = text.match(re);
    if (m) hits.push(...m);
  }
  return [...new Set(hits)];
}

function checkNpcs(newNpcs, pack) {
  const problems = [];
  (newNpcs || []).forEach((n, i) => {
    const missing = (pack.npcRequiredFields || []).filter(f => !n[f]);
    const missingAuto = (pack.npcAutonomyFields || []).filter(f => !n[f]);
    if (missing.length) problems.push(`新人物[${i}]「${n.name || '未命名'}」缺字段：${missing.join('、')}`);
    if (missingAuto.length) problems.push(`新人物「${n.name || '未命名'}」缺自主性三件：${missingAuto.join('、')}`);
  });
  return problems;
}

function checkThreads(touched, state) {
  const titles = new Set((state.threads || []).map(t => t.title));
  const unknown = (touched || []).filter(t => !titles.has(t));
  return unknown;
}

function unresolvedGaps(state) {
  const gaps = [];
  (state.npcs || []).forEach(n => {
    // 真实历史人物的目标/风险/背叛条件按设计**故意留空**（规则第10条：不编造真人的私心），
    // 所以不把他们计入「遗留缺口」，否则侧栏会刷出一长串莫名其妙的缺口。
    if (n.source === 'historical') return;
    if (!n.goal || !n.risk || !n.defectionCondition) gaps.push(`「${n.name}」未登记目标/风险/背叛条件`);
  });
  return gaps;
}

/* 真实人物的年代一致性：列出档案里已卒于当前年份的人（不该再出场）。 */
function staleRealPeople(state) {
  const y = state.clock && state.clock.gregorianYear;
  if (!y) return [];
  const out = [];
  (state.npcs || []).forEach(n => {
    if (n.source !== 'historical') return;
    const died = n.died != null ? n.died : (n.anchors && n.anchors.died);
    if (died != null && died < y) out.push(`${n.name}（卒于 ${died} 年）`);
  });
  return out;
}

/* 越权代行：玩家已给出指令时，扫描 GM 是否替他拍了板（决定/答应/拒绝/下令…）。
   只抓「决定类」动词，不抓普通动作，以免把玩家自己写的行动误判。 */
const PLAYER_DECISION_VERBS = ['决定', '选择', '答应', '应允', '允诺', '同意', '拒绝', '下令', '吩咐', '命令', '拍板', '默许', '点头', '颔首', '允了', '应下'];
function scanAgency(scene, input) {
  if (!input || !String(input).trim()) return [];
  const inp = String(input);
  const hits = [];
  for (const v of PLAYER_DECISION_VERBS) {
    // 匹配「你（便/遂/于是/当下）…动词」结构
    const re = new RegExp(`你(?:便|遂|于是|当下|随即|也就|终究|终究是)?[^。！？\\n]{0,6}${v}`, 'g');
    const m = scene.match(re);
    if (m && !inp.includes(v)) hits.push(...m.map(x => `「${x}」`));
  }
  return [...new Set(hits)];
}

/* 性别常识：女性不得被写成在朝官吏（后妃/命妇/闺秀/女冠 ≠ 朝廷命官）。 */
function scanGenderNonsense(scene) {
  const hits = [];
  const TITLES = '知县|知府|县令|太守|刺史|尚书|侍郎|御史|布政使|按察使|巡抚|总督|将军|节度使|总兵|提督|校尉|司马|宰相|丞相|大学士|参军|主簿|县丞|典史|同知|通判|给事中|翰林|员外郎|郎中|节度|太守';
  // 女性标记（女/妇/妾/婢/尼/姑/后妃等）后近距离出现官衔，视为疑似违常
  const re = new RegExp(`(?:后妃|妃嫔|女官|命妇|女子|妇人|妾室|婢女|女冠|尼姑|妇|妾|婢|尼|姑)[^。！？\\n]{0,6}(?:${TITLES})`, 'g');
  let m;
  while ((m = re.exec(scene))) hits.push(`「${m[0]}」`);
  return [...new Set(hits)];
}

/* 真实人物「穿越相认」：两个真人同时出场，但其中一个卒时另一个尚未出生 —— 不可能相识。
   这是最典型的史实硬错（异代相认），机械可查。 */
function scanAnachronism(scene, state) {
  const real = (state.npcs || []).filter(n => n.source === 'historical' && n.name);
  const present = real.filter(n => scene.includes(n.name));
  const hits = [];
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const a = present[i], b = present[j];
      const aBirth = a.born ?? (a.birthYear ?? null), aDeath = a.died ?? null;
      const bBirth = b.born ?? (b.birthYear ?? null), bDeath = b.died ?? null;
      // 一方卒于另一方出生之前 → 绝无可能相识
      if (aDeath != null && bBirth != null && aDeath < bBirth) hits.push(`${a.name}（卒 ${aDeath}）与 ${b.name}（生 ${bBirth}）相隔，不可能相识`);
      else if (bDeath != null && aBirth != null && bDeath < aBirth) hits.push(`${b.name}（卒 ${bDeath}）与 ${a.name}（生 ${aBirth}）相隔，不可能相识`);
    }
  }
  return [...new Set(hits)];
}

function audit({ pack, state, draft, raw, adapterId, input, verbosity, prevViolations }) {
  const scene = String(draft?.scene || '');
  const rows = [];

  // 1. 占位符与后世词汇
  const ph = scanPlaceholders(scene, pack);
  rows.push({
    id: 'placeholder',
    name: '占位符 / 后世词汇',
    state: ph.length ? '存疑' : '通过',
    detail: ph.length ? '命中：' + [...new Set(ph)].slice(0, 8).join('，') : '全文未命中 bannedTokens 与模糊指代正则。注意：这只覆盖词表内的禁用词，词表外的时代错误仍可能存在。'
  });

  // 2. 时间跳跃
  const leaps = scanTimeLeaps(scene, pack);
  rows.push({
    id: 'timeleap',
    name: '时间锁（禁止快进）',
    state: leaps.length ? '存疑' : '通过',
    detail: leaps.length ? '疑似快进表述：' + leaps.join('，') : '未命中快进正则。但「一步步写满三个月」这类逐句推进无法被正则发现，需你人工确认。'
  });

  // 2b. 现代词汇 / 现代观念
  const modern = modernHitsIn(scene);
  rows.push({
    id: 'modern',
    name: '现代词汇 / 观念',
    state: modern.length ? '存疑' : '通过',
    detail: modern.length
      ? '正文里出现了现代说法：' + modern.slice(0, 8).map(x => `「${x.modern}」→应作「${x.ancient}」`).join('；') + '。这是穿帮，须改成当时的说法与行为。'
      : '未命中现代词汇表（146 条）。注意：表外的现代观念、以及人物用现代逻辑行事，这项验不了，需你人工判断。'
  });

  // 3. 决定权（容忍模型不加书名号的写法）
  const marker = pack.outputContract.requireDecisionMarker;
  const norm = s => String(s || '').replace(/[「」『』\s]/g, '');
  const hasMarker = norm(scene).includes(norm(marker)) || norm(draft?.pendingDecision).includes(norm(marker));
  rows.push({
    id: 'decision',
    name: '决定权归还玩家',
    state: hasMarker ? '通过' : '存疑',
    detail: hasMarker ? '找到「用户决定」标记。' : '未找到标记，正文可能替玩家做了决定或替他收尾了线索。'
  });

  // 4. 玩家代行（GM 是否替玩家拍了板）
  const agency = scanAgency(scene, input);
  rows.push({
    id: 'agency',
    name: '玩家代行扫描',
    state: agency.length ? '存疑' : (input && String(input).trim() ? '通过' : '信息缺口'),
    detail: agency.length
      ? `正文里出现疑似替玩家拍板的措辞：${agency.slice(0, 6).join('，')}。请核对玩家本回合并未写过这些决定；若是 GM 替他做的，就是越权代行。`
      : (input && String(input).trim()
        ? '未发现「你决定/你答应/你下令」这类由 GM 代玩家拍板的措辞。注意：这只抓决定类动词，GM 换种说法替他行动仍可能漏网。'
        : '本回合玩家未写具体指令，无从比对。')
  });

  // 5. 性别与常识
  const gen = scanGenderNonsense(scene);
  rows.push({
    id: 'gender',
    name: '性别与常识',
    state: gen.length ? '存疑' : '通过',
    detail: gen.length
      ? `疑似把女性写成了在朝官吏：${gen.slice(0, 6).join('，')}。后妃、命妇、闺秀、女冠不是朝廷命官，请核对。`
      : '未发现「女性＋官衔」这类明显违常的措辞。注意：性别前后矛盾、内宅嫡庶这类深层常识，本项也验不了。'
  });

  // 6. NPC 完整性
  const np = checkNpcs(draft?.newNpcs, pack);
  rows.push({
    id: 'npc',
    name: 'NPC 字段与自主性',
    state: np.length ? '存疑' : ((draft?.newNpcs || []).length ? '通过' : '信息缺口'),
    detail: np.length ? np.join('；')
      : (draft?.newNpcs || []).length
        ? `新登记 ${draft.newNpcs.length} 人，字段与自主性三件齐全。是否与其他人物重名、是否有同名真实历史人物，本引擎无法离线验证。`
        : '本轮未登记新人物，无数据可查。'
  });

  // 7. 线索一致性
  const unknown = checkThreads(draft?.touchedThreads, state);
  rows.push({
    id: 'thread',
    name: '线索表一致性',
    state: unknown.length ? '存疑' : '通过',
    detail: unknown.length ? `引用了存档中不存在的线索：${unknown.join('、')}。线索的推进与你确认的范围是否一致，需你确认。`
      : `本轮触及 ${(draft?.touchedThreads || []).length} 条线索，均在档案内。`
  });

  // 7. 正文长度（上限同样要管，治「太长玩不了」）
  const len = scene.replace(/\s/g, '').length;
  const vb = verbosity || {};
  const min = vb.min != null ? vb.min : (pack.outputContract.minSceneChars || 260);
  const max = vb.max != null ? vb.max : (pack.outputContract.maxSceneChars || 700);
  if (adapterId === 'skeleton') {
    rows.push({ id: 'length', name: '正文长度', state: '信息缺口', detail: '当前为离线骨架适配器，不产生真实正文，长度不参与判定。' });
  } else if (max && len > max) {
    rows.push({
      id: 'length',
      name: '正文长度',
      state: '存疑',
      detail: `实际 ${len} 字，超过上限 ${max} 字 —— 这一轮写得太长、不好读。点「这段不行，重来」，或在设置里把篇幅调成「精简」。`,
    });
  } else if (min && len < min) {
    rows.push({
      id: 'length',
      name: '正文长度',
      state: '存疑',
      detail: `实际 ${len} 字，低于下限 ${min} 字，可能没把玩家的动作演完。`,
    });
  } else {
    rows.push({ id: 'length', name: '正文长度', state: max ? '通过' : '信息缺口', detail: max ? `实际 ${len} 字，在 ${min}~${max} 字区间内。` : `实际 ${len} 字（未设上限）。` });
  }

  // 7. 引擎验证不了的部分 —— 显式声明，不打勾
  rows.push({
    id: 'unverifiable',
    name: '引擎无法验证的部分',
    state: '信息缺口',
    detail: '史实正确性（生卒年/官职/地名/控制者）、对话语域是否合身份、事件因果是否有逻辑断层、是否有隐性未卜先知 —— 这些本引擎没有知识源，必须由你人工核对，或挂一个带检索能力的外部框架进来。'
  });

  const gaps = unresolvedGaps(state);
  if (gaps.length) {
    rows.push({ id: 'stalegap', name: '档案遗留缺口', state: '信息缺口', detail: gaps.join('；') });
  }

  // 7b. 同代真人是否已卒（真人局的时代一致性核查）
  const stale = staleRealPeople(state);
  const realCount = (state.npcs || []).filter(n => n.source === 'historical').length;
  if (realCount) {
    rows.push({
      id: 'realnpc',
      name: '同代真人年代核查',
      state: stale.length ? '存疑' : '通过',
      detail: stale.length
        ? `档案里有已卒于 ${state.clock.gregorianYear} 年之前的人，本轮不该再让他出场：${stale.slice(0, 8).join('、')}。可点「重新生成世界」刷新同代人物。`
        : `档案内有 ${realCount} 位真实同代人物，均在当前年份仍在世。注意：这只能核对卒年，人物的官职、立场是否合史实需你人工把关。`,
    });
  }

  // 7c. 异代相认（真人之间的穿越会面）
  const ana = scanAnachronism(scene, state);
  if (realCount >= 2) {
    rows.push({
      id: 'anachronism',
      name: '真人不得异代相认',
      state: ana.length ? '存疑' : '通过',
      detail: ana.length
        ? `本轮正文里出现了不可能相识的真人：${ana.join('；')}。请删掉他们的会面，或改成各在一方。`
        : '本轮同场出现的真人，生卒年彼此有重叠，未发现「异代相认」。注意：这只查生卒年硬冲突，两人是否真的相识、有无史料可据，需你人工核对。',
    });
  }

  // 8. 真人模式：史实锚点一致性（机械比对，只报冲突，不判真伪）
  const a = state.anchors;
  if (a) {
    const hits = [];
    if (a.died && state.clock.gregorianYear && state.clock.gregorianYear > a.died)
      hits.push(`当前年份 ${state.clock.gregorianYear} 已超过其卒年 ${a.died}`);
    if (a.born && state.clock.gregorianYear && state.clock.gregorianYear < a.born)
      hits.push(`当前年份 ${state.clock.gregorianYear} 早于其生年 ${a.born}，此人此时尚未出生`);
    if (a.born && state.protagonist?.age && a.born) {
      const impliedBirth = state.clock.gregorianYear - state.protagonist.age + 1;
      if (Math.abs(impliedBirth - a.born) > 2)
        hits.push(`档案里的年龄推出生年约 ${impliedBirth}，与锚点生年 ${a.born} 差 ${Math.abs(impliedBirth - a.born)} 年`);
    }
    const dead = (state.household?.members || []).filter(m => m.status === '已故').map(m => m.name);
    const appears = dead.filter(n => scene.includes(n));
    if (appears.length) hits.push(`正文里出现了已标记「已故」的家人：${appears.join('、')}`);
    if (state.realDateUnknown) hits.push('此真人没有生卒年记录，引擎无法核验他是否真活在这一年 —— 请自行确认');
    rows.push({
      id: 'anchor',
      name: '史实锚点一致性（真人模式）',
      state: hits.length ? '存疑' : '通过',
      detail: hits.length ? hits.join('；') : '与锚点表未发现冲突。注意：这只比对生卒年、推算年龄和已故家人名单这类可机械验的项，具体言行是否合史实它验不了。',
    });
  }

  // 9. 家庭与地理缺失提醒（真人局家族刻意留空，不算缺口）
  const realFamily = !!state.household?.realMode;
  const noFamily = !realFamily && !(state.household?.members || []).length && !state.household?.clan;
  if (noFamily || !state.geography) {
    rows.push({
      id: 'worldgap',
      name: '家庭 / 地理资料',
      state: '信息缺口',
      detail: [
        noFamily ? '还没登记家庭成员与宗族 —— GM 若本轮要写家事，只能凭空编。' : '',
        state.geography ? '' : '还没登记地理 —— 涉及路程、行军、运粮、传信时会失真。',
        '可以在档案页里补，或让 AI 先按史实拟一份再自己核实。',
      ].filter(Boolean).join(''),
    });
  } else if (realFamily && !(state.household?.members || []).length) {
    rows.push({
      id: 'worldgap',
      name: '家庭 / 地理资料',
      state: '信息缺口',
      detail: '真人局：配偶、子女、后妃按设计须依史实补录，引擎不虚构 —— 所以这里是空的，属正常。要写家事时，请先确认史料或用「让 AI 拟一份」再核实。',
    });
  }

  // ================= 新增：对照表层的检查 =================

  // 10. 数字量级（户口/兵数/钱粮/里程）
  const numHits = checkNumbers(scene, state);
  rows.push(row('numbers', '数字量级（先算再写）', 'table',
    numHits.length ? '存疑' : (scene ? '通过' : '信息缺口'),
    numHits.length
      ? '超出合理量级：' + numHits.slice(0, 6).map(h => `${h.text}（${h.why}）`).join('；')
      : '正文中的数目未超出该时代该级别的常规量级。注意：只查量级上限，具体数字对不对仍要你核对。'));
  if (numHits.length) rows[rows.length - 1].evidence = numHits.map(h => ({ label: h.kind, provider: 'numeric', query: h.text, results: [{ title: h.why, url: '', snippet: '' }] }));

  // 11. 已关闭线索不得再提（用户标记「不再追查」的，出现即报警）
  const closed = (state.threads || []).filter(t => t.status === 'resolved' || t.status === 'dropped' || t.noMore);
  const revived = closed.filter(t => t.title && scene.includes(t.title)).map(t => t.title);
  rows.push(row('closedthread', '已关闭线索（不得再提）', 'table',
    revived.length ? '存疑' : '通过',
    revived.length
      ? `这些线索你已了结/搁置，本轮却又被提起：${revived.join('、')}。若确需重开，请你在线索表里手动恢复。`
      : (closed.length ? `已关闭 ${closed.length} 条线索，本轮均未被重新提起。` : '本局还没有已关闭的线索。')));

  // 12. 年龄随时间递增（对照表）
  const gy = (state.clock && state.clock.gregorianYear) || 0;
  const ageIssues = [];
  const checkAge = (obj, who) => {
    if (!obj || !obj.birthYear || !gy) return;
    const expect = gy - obj.birthYear + 1;
    if (obj.age != null && Math.abs(obj.age - expect) > 1) ageIssues.push(`${who} 应为此年 ${expect} 岁，档案写的是 ${obj.age} 岁`);
  };
  checkAge(state.protagonist, state.protagonist && state.protagonist.name || '主角');
  (state.npcs || []).forEach(n => checkAge(n, n.name));
  if (state.anchors && state.anchors.born === null) { /* 生年未知，跳过 */ }
  rows.push(row('ages', '年龄随时间递增', 'table',
    ageIssues.length ? '存疑' : '通过',
    ageIssues.length ? ageIssues.slice(0, 6).join('；') : '档案内人物的年龄与其生年、当前年份自洽（有生年者逐人核算）。'));

  // 13. 关系一致性（对照表）：新登场人物的关系不得与登记表冲突
  const relIssues = [];
  for (const n of (draft?.newNpcs || [])) {
    const old = (state.npcs || []).find(x => x.name === n.name);
    if (old && old.tie && n.tie && old.tie !== n.tie) relIssues.push(`「${n.name}」的关系由「${old.tie}」改成了「${n.tie}」`);
    if (old && old.age != null && n.age != null && Math.abs(old.age - n.age) > 1) relIssues.push(`「${n.name}」的年龄由 ${old.age} 变成 ${n.age}`);
  }
  rows.push(row('relations', '人物关系 / 年龄一致', 'table',
    relIssues.length ? '存疑' : '通过',
    relIssues.length ? relIssues.join('；') : '本轮新登人物的关系与年龄，与登记表未发现冲突。'));
  rows[rows.length - 1].evidence = undefined;

  // 14. 纠正记录复发（对照表）：本轮是否又犯了用户纠正过的类型
  const esc = escalated(state);
  const ledger = getLedger(state);
  const repeatHot = [];
  if (prevViolations && prevViolations.length) {
    // 上一轮被判过的项，本轮若再次不过，即视为复发
    const nowBad = new Set(rows.filter(r => (r.state === '存疑' || r.state === '信息缺口') && r.blocking).map(r => r.id));
    for (const v of prevViolations) if (nowBad.has(v)) repeatHot.push(v);
  }
  rows.push(row('ledger', '纠正记录对照', 'table',
    repeatHot.length ? '存疑' : '通过',
    (repeatHot.length
      ? `上一轮已被判不过的项（${repeatHot.join('、')}），本轮又犯。`
      : '本轮未重复上一轮被判不过的必过项。')
    + (esc.length ? `。本局累计反复出现的失误：${esc.map(e => `${e.label}×${e.count}`).join('；')}` : '')
    + (ledger.corrections.length ? `。用户共纠正过 ${ledger.corrections.length} 次，详见提示词中的「纠正记录库」` : '')));

  // ================= 人判断层（只列，由用户打勾） =================
  const HUMAN_LIST = [
    ['drama', '剧情是否有戏剧性、张力，不是流水账'],
    ['manners', '人情世故是否对（恩威并施、给面子、兵卒看得懂）'],
    ['scene', '是否写出了具体场景（对话、表情、语气），不是摘要'],
    ['era', '语域是否匹配身份（士大夫/兵卒/农人说话不同）'],
    ['history', '史实对不对（人名、地名、官职、年号、日期）'],
    ['numbers', '具体数字是否合理（软件只查量级，细数要你把关）'],
    ['fairness', '是否保留了真实挫折与代价（不是想要什么就有什么）'],
    ['omniscient', '有没有未卜先知 / 上帝视角'],
  ];
  for (const [k, label] of HUMAN_LIST) {
    rows.push(row('human:' + k, label, 'human', '待你判断', '只能由你判断，系统不自评。'));
  }

  // ================= 汇总：分层 + 必过项 =================
  // 必过项（不过则整轮作废）：决定权、快进、占位符、重名
  const BLOCKING = { decision: 1, timeleap: 1, placeholder: 1, npcname: 1 };
  // 三层归属
  const TIER = {
    placeholder: 'machine', timeleap: 'machine', decision: 'machine', agency: 'machine',
    modern: 'machine', gender: 'machine', npc: 'machine', thread: 'machine', length: 'machine',
    numbers: 'table', closedthread: 'table', ages: 'table', relations: 'table', ledger: 'table',
    realnpc: 'table', anachronism: 'table', anchor: 'table',
    stalegap: 'table', worldgap: 'table', unverifiable: 'human',
  };
  for (const r of rows) {
    if (!r.tier) r.tier = TIER[r.id] || 'machine';
    if (BLOCKING[r.id]) r.blocking = true;
    if (r.id && r.id.startsWith('npcname:')) { r.blocking = true; r.tier = 'machine'; }
  }

  const blocking = rows.filter(r => r.blocking);
  const blockingFailed = blocking.filter(r => r.state !== '通过' && r.state !== '信息缺口');
  const failed = blockingFailed.length > 0;

  return {
    rows,
    raw: String(raw || '').slice(0, 2000),
    failed,
    blockingFailed: blockingFailed.map(r => ({ id: r.id, name: r.name, detail: r.detail })),
    tiers: {
      machine: rows.filter(r => r.tier === 'machine').map(r => r.id),
      table: rows.filter(r => r.tier === 'table').map(r => r.id),
      human: rows.filter(r => r.tier === 'human').map(r => r.id),
    },
  };
}

module.exports = { audit };

