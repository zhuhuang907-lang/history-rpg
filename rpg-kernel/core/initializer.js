'use strict';
/**
 * 开局初始化检查器（总指令 §3.2 ScenarioInitializer / 规格第五部分）
 *
 * 核心立场：
 *   **生成开局之前，先执行初始化检查。未通过关键检查时，不得进入正式开局生成。**
 *   旧流程是「先编人物、库存和危机，再给它们补上看似合理的理由」——
 *   检查器就是要把顺序倒过来：先确定什么是真的，再决定开局怎么写。
 *
 * 五类检查（规格 §5.2~§5.5）：
 *   时间 / 地点 / 人物 / 资源 / 初始化结果。
 * 状态值只允许：通过 / 存在矛盾 / 证据不足 / 架空设定 / 不适用。
 * 「搜索不到」不等于「不存在」，「没查到」不等于「错误」——
 * 无法确认的一律落「证据不足」，绝不默认通过。
 */
const reign = require('./reign');
const figure = require('./figure-data');
const timeline = require('./timeline');

/** 检查结果允许的状态（规格 §5：不得把「通过」当默认值） */
const STATUS = { PASS: '通过', CONFLICT: '存在矛盾', UNCERTAIN: '证据不足', DIVERGENCE: '架空设定', NA: '不适用' };

/* 五代十国政权年段（figure-data.DYNASTY_SPAN 只到「五代」一级，这里细分到政权） */
const POLITY_SPAN = {
  后梁: [[907, 923]], 后唐: [[923, 936]], 后晋: [[936, 947]], 后汉: [[947, 950]], 后周: [[951, 960]],
  楚: [[907, 951]], 吴: [[902, 937]], 前蜀: [[907, 925]], 后蜀: [[934, 965]],
  吴越: [[907, 978]], 闽: [[909, 945]], 南汉: [[917, 971]], 荆南: [[924, 963]], 南唐: [[937, 975]], 北汉: [[951, 979]],
};

function chk(item, claim, status, opts = {}) {
  return { 项: item, 主张: claim, 结果: status, 依据: opts.依据 || '', 不确定性: opts.不确定性 || '', 对开局的影响: opts.影响 || '', 建议: opts.建议 || '', blocking: !!opts.blocking };
}

/** 该政权在 year 年是否存在（细分到五代十国政权；查不到归「证据不足」，不硬判） */
function polityAlive(polity, year) {
  const p = String(polity || '').trim();
  if (!p || !year) return null;
  const sp = POLITY_SPAN[p] || (figure.dynastySpans(p, year) === 'ok' ? [[-9999, 9999]] : null);
  if (sp) return sp.some(([a, b]) => year >= a && year <= b) ? 'ok' : 'out';
  const r = figure.dynastySpans(p, year);
  if (r === 'ok') return 'ok';
  if (r === 'out') return 'out';
  return null; // 查不到 → 不硬判
}

/* ============================ 5.2 时间验证 ============================ */
function checkTime(state, online) {
  const out = [];
  const c = state.clock || {};
  const y = Number(c.gregorianYear) || 0;
  const label = String(c.yearLabel || '');

  // ① 年号与公元年份是否一致
  if (label && y) {
    const r = reign.resolveGregorian(label, (state.location && state.location.polity) || '');
    if (r && r.year != null) {
      out.push(r.year === y
        ? chk('年号↔公元年', `${label} = ${y}`, STATUS.PASS, { 依据: 'reign.resolveGregorian' })
        : chk('年号↔公元年', `${label} ≠ ${y}`, STATUS.CONFLICT, {
          依据: `「${label}」按年号表应折合 ${r.year} 年`, 影响: '开局年代整个错位',
          建议: `改用公元 ${r.year} 年，或改用 ${y} 年的真实年号`, blocking: true,
        }));
    } else {
      out.push(chk('年号↔公元年', `${label} = ${y}`, STATUS.UNCERTAIN, {
        依据: '', 不确定性: `年号表里没有「${label}」，无法核对；按玩家指定处理，但未核验`,
        建议: '如需核验，请补该年号的出处',
      }));
    }
  } else if (!y) {
    out.push(chk('公元年份', '未指定', STATUS.CONFLICT, { 影响: '没有公元年，一切人物/事件核定都无从谈起', 建议: '必须给出公元年', blocking: true }));
  }

  // ② 季节与月份是否一致
  const m = Number(c.month) || 0;
  const season = String(c.season || '');
  if (m && season) {
    const expect = m <= 3 ? '春' : m <= 6 ? '夏' : m <= 9 ? '秋' : '冬';
    out.push(expect === season
      ? chk('季节↔月份', `${m}月属${season}`, STATUS.PASS)
      : chk('季节↔月份', `${m}月写「${season}」`, STATUS.CONFLICT, {
        依据: `${m}月应属${expect}`, 建议: `改为「${expect}」或改月份`,
      }));
  }

  // ③ 政权在该年是否存在
  const polity = (state.location && state.location.polity) || '';
  if (polity && y) {
    const r = polityAlive(polity, y);
    if (r === 'ok') out.push(chk('政权存在', `${polity}在${y}年存在`, STATUS.PASS, { 依据: '政权年段表' }));
    else if (r === 'out') out.push(chk('政权存在', `${polity}在${y}年`, STATUS.CONFLICT, {
      依据: `${polity}的存在年段不含 ${y} 年`, 影响: '整个开局的政治框架是错的', 建议: '核对政权或年份', blocking: true,
    }));
    else out.push(chk('政权存在', `${polity}在${y}年`, STATUS.UNCERTAIN, { 不确定性: '政权年段表未收录该政权，未核验' }));
  }

  // ④ 历史人物在目标时间是否存活 / 年龄是否合理（虚岁口径）
  const proto = state.protagonist || {};
  const name = String(proto.name || '').trim();
  if (name && y) {
    const d = figure.dossierAt(name, y);
    const born = (d && d.born) ?? proto.born ?? proto.birthYear ?? (online && online.born) ?? null;
    const died = (d && d.died) ?? proto.died ?? (online && online.died) ?? null;
    if (died != null && y > died) {
      out.push(chk('人物存活', `${name}在${y}年`, STATUS.CONFLICT, {
        依据: `${name}卒于${died}年（${d ? '本地档案' : '联网核定'}）`, 影响: '死人不能当主角',
        建议: '改到其生前的年份', blocking: true,
      }));
    } else if (born != null && y < born) {
      out.push(chk('人物存活', `${name}在${y}年`, STATUS.CONFLICT, {
        依据: `${name}生于${born}年，${y}年尚未出生`, 影响: '开局之年此人不存在',
        建议: '改到其出生之后', blocking: true,
      }));
    }
    // 年龄：不得擅自把玩家年龄改成另一个精确数字（规格 §A：保留不确定性）
    if (born != null && proto.age != null) {
      const expect = y - born + 1; // 虚岁
      const diff = Math.abs(expect - Number(proto.age));
      if (diff === 0) {
        out.push(chk('年龄口径', `${name} ${y} 年虚岁 ${expect}`, STATUS.PASS, { 依据: `生于${born}年` }));
      } else if (diff === 1) {
        out.push(chk('年龄口径', `玩家填 ${proto.age} 岁 / 按生年应 ${expect} 岁`, STATUS.UNCERTAIN, {
          依据: `生于${born}年`, 不确定性: '虚岁与周岁差一年，或生日未明，无法判定孰是',
          建议: '保留玩家数值，标注口径未核验；不得静默改成精确数字',
        }));
      } else {
        out.push(chk('年龄口径', `玩家填 ${proto.age} 岁 / 按生年应 ${expect} 岁`, STATUS.CONFLICT, {
          依据: `生于${born}年（${d ? '本地档案' : '联网核定'}）`, 影响: '年龄决定其能做与不能做的事',
          建议: `若是玩家指定的架空条件请明确标注「架空」；否则建议改为 ${expect} 岁`,
        }));
      }
    } else if (proto.age == null && born == null) {
      out.push(chk('年龄口径', '年龄与生年均未给出', STATUS.UNCERTAIN, { 不确定性: '年龄与生年均无据，开局后不得据此推算精确年龄' }));
    }
    // ⑤ 身份/官职的时代合法性（时代错置体检）
    const idIssues = figure.auditFigure({
      name, year: y, polity,
      role: proto.role || '', born, died,
      identityModule: state.identityModule || '',
    });
    for (const i of idIssues) {
      out.push(chk('身份/官职', i.text, STATUS.CONFLICT, {
        依据: i.source || 'figure-data', 影响: '人物名分决定开局能不能立得住',
        建议: i.suggest || '按该年实际身份重写', blocking: i.field === 'anachronism' || i.field === 'denied',
      }));
    }
  }
  return out;
}

/* ============================ 5.3 地点验证 ============================ */
function checkPlace(state, online) {
  const out = [];
  const loc = state.location || {};
  const y = Number(state.clock && state.clock.gregorianYear) || 0;
  const full = String(loc.full || '');
  const name = String((state.protagonist && state.protagonist.name) || '').trim();

  // ① 行政归属：控制者与政权不一致（名义 vs 实际）
  if (loc.controller && loc.polity && loc.controller !== loc.polity) {
    out.push(chk('行政归属', `${full}：${loc.controller} 实控 / 属 ${loc.polity}`, STATUS.CONFLICT, {
      依据: '地盘表', 影响: '开局所在地的法统与实控不一致，玩家到底听谁的',
      建议: '写明「名义属X、实际为Y所据」，不要默认一致',
    }));
  }

  // ② 人物与地点的联系（规格 §B：不能因为父子关系就推出他在某地有宅第官仓）
  if (name && y) {
    const seat = figure.seatAt(name, y);
    if (seat && full && !full.includes(seat) && !seat.includes(full)) {
      out.push(chk('活动区域', `${name}在${y}年的治所是「${seat}」，开局却在「${full}」`, STATUS.CONFLICT, {
        依据: '本地档案', 影响: '他在别处任职，开局地点、宅第、仓廪都失去了依据',
        建议: `把开局地改到「${seat}」，或说明他为何在此（出使/客居/架空）`,
        blocking: true,
      }));
    } else if (seat && full && (full.includes(seat) || seat.includes(full))) {
      out.push(chk('活动区域', `${name}在${y}年镇「${seat}」，开局在「${full}」`, STATUS.PASS, { 依据: '本地档案' }));
    } else if (!seat) {
      const ev = (online && (online.place || online.nativePlace)) || '';
      out.push(chk('活动区域', `${name}在${y}年是否身在「${full}」`, STATUS.UNCERTAIN, {
        依据: ev ? `联网核定仅供参考：${ev}` : '无本地档案',
        不确定性: ev ? `仅有「${ev}」可作参考，无法证实其当时在「${full}」` : '查不到其该年的活动区域',
        建议: '保留为待核验，开局不得据此给他安排宅第、仓廪或独立势力',
      }));
    }
  }

  // ③ 交通：从核心人物所在地到开局地，消息要多久（传播不得瞬间）
  if (name && y) {
    const seat = figure.seatAt(name, y);
    if (seat && full && seat !== full) {
      const tr = timeline.travelDays(seat, full);
      out.push(tr
        ? chk('交通/消息', `${seat}→${full}`, STATUS.PASS, {
          依据: `${tr.note}（${tr.min}~${tr.max} 日，估算）`,
          不确定性: '估量级，非精确日程',
        })
        : chk('交通/消息', `${seat}→${full}`, STATUS.UNCERTAIN, {
          不确定性: '缺乏该路线的行程依据，不作判定（宁可不判，不编）',
        }));
    }
  }
  return out;
}

/* ============================ 5.4 人物验证 ============================ */
function checkPersons(state) {
  const out = [];
  // ① 名籍体检（生卒/名分/时代错置）—— 复用 figure.auditAll
  const a = figure.auditAll(state);
  for (const i of a.issues) {
    out.push(chk('名籍', `${i.who}：${i.text}`, STATUS.CONFLICT, {
      依据: i.source || 'figure-data', 建议: i.suggest || '', blocking: i.field === 'anachronism',
    }));
  }
  // ② 虚构人物必须明确标记，不得包装成历史人物（规格 §F）
  for (const n of (state.npcs || [])) {
    const src = String(n.source || '');
    const isFict = ['generated', 'fictional', 'localCast', 'real-kin'].includes(src) || n.fictional === true;
    if (src === 'historical') continue;
    if (!isFict && src) {
      out.push(chk('人物性质', `${n.name}的来源标记是「${src}」`, STATUS.UNCERTAIN, {
        不确定性: '该来源无法判定其真伪', 建议: '明确标注 历史/虚构',
      }));
    }
  }
  // ③ 历史人物的在线档案是否核过
  const unverified = (state.npcs || []).filter(n => n.source === 'historical' && !n.verified);
  if (unverified.length) {
    out.push(chk('人物核实', `${unverified.length} 名历史人物未经核定`, STATUS.UNCERTAIN, {
      不确定性: unverified.slice(0, 4).map(n => n.name).join('、') + (unverified.length > 4 ? ' 等' : ''),
      建议: '开局时跑 /api/world/figures 或重新 seed',
    }));
  }
  return out;
}

/* ============================ 5.5 资源验证 ============================
   规格：每个数字都要能说明 从哪来、归谁、能不能动。
   没有来源的数字必须摘掉「已确认史实」的帽子。 */
function checkResources(state) {
  const out = [];
  const e = state.economy;
  if (!e) {
    out.push(chk('资源·账本', '尚未建立', STATUS.NA, { 不确定性: '开局未跑 seed，无账可查' }));
    return out;
  }
  const src = (e.scope && e.scope.source) || 'unknown';
  const conf = (e.scope && e.scope.confidence) || 'low';
  const note = (e.estimate && e.estimate.note) || '';
  const label = { recorded: '史料所载', estimate: '数量级估算', generated: '游戏设定' }[src] || '来源不明';

  for (const [项, 值, 单位] of [
    ['现钱', e.treasury.cashGuan, '贯'], ['官仓粮', e.treasury.grainShi, '石'],
    ['总兵', e.military.total, '人'], ['欠债', e.treasury.debtGuan, '贯'],
  ]) {
    if (src === 'recorded') {
      out.push(chk(`资源·${项}`, `${值} ${单位}`, STATUS.PASS, { 依据: label }));
    } else {
      out.push(chk(`资源·${项}`, `${值} ${单位}`, STATUS.DIVERGENCE, {
        依据: `${label}（可信度 ${conf}）${note ? '；' + note : ''}`,
        不确定性: '不是史料所载，是引擎按规模推的',
        建议: '正文与账目里都必须带「估算/游戏设定」标签，不得冒充史实数字',
      }));
    }
  }

  // 所有权分离（规格 §E：私人财产、官府库存、国库资源不得混为一谈）
  const scopeLabel = e.scale || '';
  out.push(chk('资源·所有权', `账本口径「${scopeLabel}」`, STATUS.UNCERTAIN, {
    依据: 'economy.scope',
    不确定性: '私有、官仓、国库不得混为一谈：现账只记了「官方盘子」，主角私人资财未与官仓、国库分账',
    建议: '涉及动用钱财时，须先分清 私有/官仓/国库，不得相加后直接视为玩家可调动',
  }));
  return out;
}

/* ============================ 5.4b 行为能力（规格 §1.3 / §十四） ============================
   实际故障：给玩家一个九岁的马希声，正文却让他批公文、理钱粮、决断国事。
   这里是「程序侧」的闸门判定：未成年 / 无职衔 → 列明不能做什么、由谁代决；
   开局地与史实治所不符 → 判矛盾并给出正确地点（玩家可显式声明架空后放行）。 */
function checkCapability(state) {
  const out = [];
  let cap;
  try { cap = require('./capability'); } catch { return out; }
  const c = cap.capabilityOf(state);
  if (!c.name) return out;

  // ① 理政权限：未成年而握实任职衔 = 硬矛盾（不得开局），除非玩家明写架空
  const declared = state.divergenceAccepted === true || state.playerDivergence === true
    || String((state.location && state.location.divergence) || '') === '架空';
  if (c.isMinor && c.hasOffice) {
    out.push(chk('理政权限', `${c.name} ${c.age} 岁而带实任职衔「${c.role}」`, STATUS.CONFLICT, {
      依据: `未满 ${cap.MINOR_AGE} 岁无独立理政权（${c.why}）`,
      影响: '正文会出现孩童批阅公文、调度兵马的错误场面',
      建议: '取消该职衔，改由其监护人或僚属主事；或明确标为架空分歧后开局',
      blocking: !declared,
    }));
  } else if (c.isMinor) {
    out.push(chk('理政权限', `未成年（${c.age} 岁），政务不由他决`, STATUS.PASS, {
      依据: c.why,
      不确定性: c.guardian ? `实际主事者：${c.guardian.name}（${c.guardian.relation}，${c.guardian.source}）` : '监护人未能确定，须在开局正文里说明谁在替他拿主意',
      影响: '正文只能写其日常（受业/习射/随侍/旁听），不得写其批阅公文、领兵、支度钱粮',
    }));
  } else if (!c.hasOffice && !c.isEmperor) {
    out.push(chk('理政权限', `无行政职衔（${c.role || '身份见档案'}）`, STATUS.UNCERTAIN, {
      依据: c.why,
      不确定性: '能否调动人马钱粮取决于其所属组织与实际人脉，程序无法判定',
      建议: '正文不得凭空给他加官；办事须经由其所属组织或私人关系',
    }));
  }

  // ② 开局地与史实治所不符（旧档把马希声放在开封，而他其实随父在潭州）
  if (c.seat && !c.locationAttested) {
    const full = String((state.location && state.location.full) || '');
    out.push(chk('开局地点', `${c.name} 开局在「${full}」`, declared ? STATUS.DIVERGENCE : STATUS.CONFLICT, {
      依据: `${c.year} 年其${c.guardian ? c.guardian.relation + '「' + c.guardian.name + '」的治所' : '治所'}在「${c.seat.place}」${c.suggestedPlaceWhy}`,
      不确定性: '地点决定其归属政权、可接触的人物与能办的事，错一处则全盘皆错',
      建议: `改到「${c.seat.place}」开局；坚持「${full}」须显式声明为架空分歧，并承担随之而来的矛盾`,
      blocking: !declared,
    }));
  }
  return out;
}

/* ============================ 汇总（5.6 初始化结果） ============================ */
/**
 * 完整初始化检查。返回：
 *   checks / facts / conflicts / unfounded / divergence / unknowns / blocking / canProceed
 * A 内部审计（本函数输出）与 B 玩家可见开局（叙事层）严格分开。
 */
async function checkScenario(state, opts = {}) {
  let online = null;
  const name = String((state.protagonist && state.protagonist.name) || '').trim();
  const y = Number(state.clock && state.clock.gregorianYear) || 0;
  if (opts.online !== false && name && y) {
    try {
      const dossier = require('./dossier');
      online = await dossier.identify(name, y, (state.location && state.location.polity) || '');
    } catch (e) { online = { error: String(e && e.message || e) }; }
  }
  const checks = [
    ...checkTime(state, online),
    ...checkPlace(state, online),
    ...checkPersons(state),
    ...checkCapability(state),
    ...checkResources(state),
  ];
  const facts = checks.filter(c => c.结果 === STATUS.PASS);
  const conflicts = checks.filter(c => c.结果 === STATUS.CONFLICT);
  const unfounded = checks.filter(c => c.结果 === STATUS.UNCERTAIN);
  const divergence = checks.filter(c => c.结果 === STATUS.DIVERGENCE);
  const blocking = checks.filter(c => c.blocking);
  return {
    checks, facts, conflicts, unfounded, divergence, blocking,
    online: online ? { found: !!online.found, born: online.born ?? null, died: online.died ?? null, role: online.role || '', place: online.place || '', why: online.why || '' } : null,
    // 规格 §H：不能强制玩家接受单一剧情——只报问题，是否继续由玩家/引擎流程决定
    canProceed: blocking.length === 0,
    summary: `检查 ${checks.length} 项：通过 ${facts.length} / 矛盾 ${conflicts.length}（其中阻断 ${blocking.length}）/ 证据不足 ${unfounded.length} / 架空 ${divergence.length}`,
  };
}

/** 内部审计报告（§5.6 A：内部初始化审计，与玩家正文物理分离） */
function renderInitAudit(r) {
  const lines = ['=== 开局初始化审计（内部，不得混入玩家正文） ===', r.summary, ''];
  const sec = (t, arr) => {
    if (!arr.length) return;
    lines.push(`【${t}】`);
    for (const c of arr) {
      lines.push(`- ${c.项}：${c.主张}　→ ${c.结果}${c.blocking ? '（阻断）' : ''}`);
      if (c.依据) lines.push(`　依据：${c.依据}`);
      if (c.不确定性) lines.push(`　不确定：${c.不确定性}`);
      if (c.建议) lines.push(`　建议：${c.建议}`);
    }
  };
  sec('存在矛盾', r.conflicts);
  sec('证据不足', r.unfounded);
  sec('架空设定', r.divergence);
  sec('已确认', r.facts);
  lines.push(r.canProceed ? '结论：无阻断项，可进入正文生成。' : `结论：存在 ${r.blocking.length} 项阻断，先修复或请玩家确认，不得直接进入正文生成。`);
  return lines.join('\n');
}

module.exports = { checkScenario, checkTime, checkPlace, checkPersons, checkCapability, checkResources, renderInitAudit, polityAlive, POLITY_SPAN, STATUS };
