'use strict';
/**
 * 提示词组装：全部内容来自规则包 + 存档状态，引擎本身不含任何规则文本。
 * 换一个 RulePack 就是换一套世界观，代码不用动。
 */
const IDM_LABEL = {
  emperor: '皇帝（最高统治者）', noble: '宗室 / 贵族', official: '朝廷命官',
  warlord: '军阀 / 独立领主', commoner: '平民',
};
const { renderLiveHistory } = require('./liveHistory');
const { renderEvent } = require('./events');
const { renderTranslation } = require('./eraVocab');
const { renderDrama } = require('./drama');
const { renderLedger } = require('./corrections');
const { renderNumericGuide } = require('./numeric');
const { renderArchiveBlock } = require('./archive');

/* 开场：第一轮必须有「详细交代一大串信息」的开场白。
   过去 state.opening 只显示在档案页、从没进过提示词 —— GM 明明不知道开场设定，这就是"没有开头"。 */
function renderOpening(s, isOpening) {
  const lines = ['=== 开局设定（引擎已定，你须以此开场） ==='];
  if (s.opening) lines.push('开局处境：' + s.opening);
  if (!isOpening) return lines.length > 1 ? lines.join('\n') : '';

  // 首轮：开场不是系统报告，而是把玩家「放进」这个时代
  const p = s.protagonist || {};
  const L = s.location || {};
  const idm = s.identityModule || 'official';
  lines.push('');
  lines.push('【本轮是整局的开场。你不是在写剧情，而是在把玩家放进一个已经存在的世界】');
  lines.push('');
  // 2026-10-08 改写：旧版七步清单（先报身份、再报兵数钱粮、再讲天下大势、再列人物……）
  // 与「200~400 字」「开篇即入事」「从日常落笔」互相打架，模型只好照清单念账，
  // 实测开场成了「萧纪命人取来人力钱粮簿册……兵一千二百……马八千匹」。现在改成「一场戏」。
  lines.push('**开场写成一场戏，不是一份报告**（用自然叙述，绝不写成条目或菜单）：');
  lines.push('一、从一个具体的人、一件具体的事落笔：此刻有谁来到你面前、为了什么（来客、僚属进言、一封书信、堂下一桩小事）。第一段就要有人在场、有人说话。');
  lines.push(`二、身份顺带交代，一两句即可：${p.name || '你'}，${p.age ? p.age + '岁' : '年岁见档案'}，${p.role || '身份见档案'}，此刻在${L.full || '（地点见档案）'}——借在场者的称呼、礼数、所请之事自然带出，不要另起一段自我介绍。`);
  lines.push('三、远方大势只经在场者之口出现（「听说…」「商旅说…」「书信里提到…」），只说此地此时已传到的那一点；没传到的一字不提。');
  lines.push('四、来人要有自己的盘算：他想要什么、怕什么，用他那个身份、那个时代的口吻说出来（士人讲名分礼法，武人讲功劳实利，僧人讲因果）。只写他说出口的，不写他心里的。');
  lines.push('五、写一两个可感的细节（衣着、器物、天时、声音）把场面立住，不堆辞藻。');
  lines.push('六、停在一个需要主角回应的地方：来人等着你一句话。不给选项，不替主角开口。');
  lines.push('');
  lines.push('**开场不写**：兵数、钱粮数、户口数（除非来人正是为此而来，且只说个大概）；天下大势的编年梗概；人物名册式的轮番登场；任何主角自己的动作与决定。');
  lines.push('');
  lines.push('（以下为补充约束）');
  lines.push(`　主角：${p.name || '你'}，在${L.full || '（地点见档案）'}。`);
  // —— 行为能力闸门：未成年/无职衔者，绝不允许被写成在理政 ——
  // 旧版固定写「你手上有兵多少人、可靠的是哪几支」，于是出现过九岁孩童调度兵马钱粮的开场。
  // 改为按 capability 的判定来写：能调度的才写，不能调度的就写明「这些事归谁管」。
  try {
    const cap = require('./capability');
    const c = cap.capabilityOf(s);
    if (c.isMinor || !c.hasOffice) {
      lines.push('　**注意（程序判定）**：' + c.why + '。因此——');
      lines.push('　　不要写「他掌握多少兵、多少钱粮、哪些地方听他的」：那些不由他调度；');
      if (c.guardian) lines.push(`　　要写清真正拿主意的是谁：${c.guardian.name}（${c.guardian.relation}），以及他凭什么听清这个人的话、又隔着几层。`);
      lines.push('　　要写他**日常真正在做的事**：受业、习射、随侍、旁听、与乳保侍从往来。');
    }
  } catch { /* capability 判定失败则退回通用写法 */ }
  lines.push('　严禁写出人物的真实动机（如「他准备背叛你」）——玩家只能靠相处和调查自己判断。');
  lines.push('');
  lines.push('**开场严禁**：');
  lines.push('· 严禁写成角色面板或系统报告（不许出现【身份：】【势力：】【资源：】这类条目）。');
  lines.push('· 严禁给任务列表或选项（不许出现 A/B/C/D、主线/支线、推荐行动）。');
  lines.push('· 严禁一上来就连环爆发大事件；真实世界大部分时候是由一堆普通事务组成的。');
  lines.push('· 严禁把 GM 掌握的世界真相提前告诉玩家（不许提前揭秘谁是主谋）。');
  lines.push('· 严禁把推测写成事实；「事实／怀疑／推测／结论」四层不许混。');
  lines.push('');
  // —— 开局节奏：旧版开场塞满「军情+党争+财政+密信」，一上来就连环爆发 ——
  // 规格 §十四：开局必须先确认「他是谁、在哪、能碰什么」，只选一个核心问题。
  lines.push('**开场的节奏（这一条最常被写坏，务必照做）**：');
  lines.push('· 从一件**具体而日常**的事落笔：一顿饭、一课书、一次习射、一位来客的通报、一件待办的杂务。');
  lines.push('　不要开场即写「接到急报」「接到密旨」「大兵压境」——那是第二回合以后的事。');
  lines.push('· 只选**一个**核心议题，把它写透：它从何时起、经谁的手、现在卡在哪一步。');
  lines.push('　其余矛盾最多一笔带过（且必须真的影响这一件事），不许塞成一本世界说明书。');
  lines.push('· 时代大势只写「活在当时的人此刻真正用得上的那一点」，不写编年史梗概。');
  lines.push('· 人物登场要有到场理由：谁叫他来的、为什么此刻在此。不许让名册上的人排队亮相。');
  lines.push('· 停在**一件可以动手的小事**上，而不是停在"天下将变"的悬念上。');
  lines.push('');
  lines.push('开场是一场戏：把上述信息融进场景，用叙述带出来，而不是罗列；不写身世简介，不写「你是一个……」。');
  return lines.join('\n');
}
/* 待战：GM 已宣告开战、但玩家还没布阵。此时 GM 只写「两军已列阵对峙」，不得替玩家决定怎么打。 */
function renderEncounter(s) {
  const e = s.encounter;
  if (!e) return '';
  return [
    '=== 待战（两军已对峙，但**玩家尚未布阵设策**） ===',
    `敌：${e.enemyName}，约 ${e.enemyTroops} 人${e.enemyFormation ? '，阵形约是' + e.enemyFormation : '，阵形未明'}；地形：${e.terrain || '未详'}。`,
    '本轮你**只写到两军列阵、弓弩上弦、战鼓将发为止**：写清敌我态势、地形的利与害、在场将士的神情与请战，然后把「怎么打」完全留给玩家——他会在「战阵」面板里自行布阵、选战术。**不得替他决定阵形或战术，也不得抢先打完这一仗。**',
  ].join('\n');
}

function renderBattle(s) {
  const b = s.pendingBattle;
  if (!b) return '';
  const im = b.ourFormation ? `我军阵形：${b.ourFormation}${b.ourTactic ? '，战术：' + b.ourTactic : ''}` : '';
  const em = b.enemyFormation ? `敌军阵形：${b.enemyFormation}${b.enemyTactic ? '，战术：' + b.enemyTactic : ''}` : '';
  return [
    '=== 战阵（本轮由玩家自行布阵设策，引擎已推演出结果，你须据此写成战况） ===',
    [im, em].filter(Boolean).join('；'),
    `兵力：我军 ${b.ourTroops ?? '?'} 对 敌军 ${b.enemyTroops ?? '?'}。地形：${b.terrain || '未详'}${b.weather ? '，天候：' + b.weather : ''}。`,
    b.outcome ? `推演结果：${b.outcome.result}（我方优势比 ${b.outcome.shareA}）。伤亡：我军 ${b.outcome.casualties.A}，敌军 ${b.outcome.casualties.B}。缘由：${(b.outcome.reasons || []).join('、')}。` : '',
    '要求：据上述阵形克制、战术相性与伤亡数字写战况，胜败与死伤不得与推演相悖；写清阵法如何展开、计策如何得手或反噬，以及将士的真实反应。',
  ].filter(Boolean).join('\n');
}

function renderStateBrief(s, pack) {
  const p = s.protagonist || {};
  const idm = s.identityModule || 'official';
  const idmLabel = IDM_LABEL[idm] || '（身份未定）';
  const lines = [];
  lines.push(`时间锁定：${s.clock.yearLabel}（公元 ${s.clock.gregorianYear} 年）${s.clock.month}月${s.clock.day}日 ${s.clock.season}。写到此处为止，不得向后推进。`);
  lines.push(`地点：${s.location.full}。隶属：${s.location.polity}。实际控制者：${s.location.controller}。`);
  lines.push(`主角：${p.name}，此时年 ${p.age} 岁，身份类型：${idmLabel}，具体职衔：${p.role}。`);
  if (p.nativePlace) lines.push(`主角籍贯：${p.nativePlace}。`);
  if (p.background) lines.push(`主角处境 / 背景：${p.background}`);
  if (s.reigningSovereign) lines.push(`当朝天子：${s.reigningSovereign}（你非人主，天下大事皆由此君与朝局牵引，不可僭称帝号或预知宫禁秘事）。`);
  // —— 身份沿革：中途可能从百姓变官员、变军阀甚至称帝，叙事必须接得上这条弧线 ——
  if (s.identityHistory && s.identityHistory.length) {
    lines.push('【身份沿革（你是一路走上来的，不是天生如此）】' + s.identityHistory
      .map(h => `${h.at || ('第' + h.turn + '轮')}：由「${h.fromLabel || h.from}」转为「${h.toLabel || h.to}」${h.role ? '（' + h.role + '）' : ''}${h.reason ? '，因' + h.reason : ''}`)
      .join('；'));
    lines.push('叙事须体现这条弧线的沉淀：旧身份留下的旧关系、旧习气、旧仇怨仍在，不得因为换了身份就把前后判若两人。');
  }
  // —— 身份锁死：所有叙事必须从此身份的视角与权力位阶出发 ——
  lines.push(`【身份锁死】你就是${idmLabel}本人，不是旁观者、也不是臣下。是皇帝便至高无上、乾纲独断；是平民便不得僭知朝堂机密，只能通过告示、传闻、族人耳闻获知零碎信息。每轮必须体现你这一身份特有的压力、资源与抉择，不得把你降格或拔高为别的身份。`);
  if (pack && pack.identityModules && pack.identityModules[idm]) {
    lines.push(`【身份视角】${pack.identityModules[idm]}`);
  }
  if (s.resources && Object.keys(s.resources).length) {
    lines.push('资源/权力：' + Object.entries(s.resources).map(([k, v]) => `${k}=${v}`).join('、'));
  }
  return lines.join('\n');
}

/* 是否与主角「有交集」：只有打过交道的人，才谈得上态度/动机。
   本地生成人物天生与主角有关系；真人同代人物在没接触前只是「同代」，不该替他编态度。 */
function npcHasContact(n) {
  if (!n) return false;
  if (n.contact === true) return true;
  if (n.source === 'generated' || n.source === 'real-kin' || n.source === 'fictional') return true;
  if (n.source === 'historical-keep') return true;
  if (n.firstSeenTurn && n.firstSeenTurn > 0) return true;
  return false;
}

/* 只有「割据（军阀）」与「皇帝」这两种身份，才需要盯着一群人的忠诚与态度；
   其余身份只记录你实际打过交道的人。 */
function tracksAttitudes(idm) { return idm === 'warlord' || idm === 'emperor'; }

function renderNpcs(s) {
  const arr = s.npcs || [];
  if (!arr.length) return '（尚无登记人物）';
  const idm = s.identityModule || 'official';
  const met = arr.filter(npcHasContact);
  const unmet = arr.filter(n => !npcHasContact(n));
  const fmt = n => {
    const sex = n.gender ? n.gender + '，' : '';
    const age = (n.age == null || n.age === '') ? '年龄待考' : n.age + '岁';
    const head = `- ${n.name}（${sex}${age}，${n.nativePlace || '籍贯待考'}），${n.role}。背景：${n.background}。关系：${n.tie}。`;
    const auto = (n.goal || n.risk || n.defectionCondition)
      ? `\n  他要的东西：${n.goal || '未写'}；他的风险与代价：${n.risk || '未写'}；他在什么条件下会背叛或反噬：${n.defectionCondition || '未写'}。`
        + (tracksAttitudes(idm) ? `\n  他对你的态度：${n.attitude || '未写（由剧情中他的言行体现）'}。` : '')
      : '\n  【缺口】此人与你已有交往，却还没写明目标/风险/背叛条件，出场前你必须先补写这三项。';
    return head + auto;
  };
  const blocks = [];
  if (met.length) blocks.push(tracksAttitudes(idm) ? '【已与你结交 / 打交道的人｜你需要掌握他们的忠诚与态度】' : '【已与你结交 / 打交道的人】', met.map(fmt).join('\n'));
  if (unmet.length) {
    const names = unmet.map(n => `${n.name}（${n.role}${n.age ? '，' + n.age + '岁' : ''}${n.gender ? '，' + n.gender : ''}）`).join('、');
    blocks.push('【同代人物（你尚未与他有交集）】' + names,
      '这些人只是与你同时代、或有名义上的统属，**你还没和他们打过交道**：不得替他们编造对你的态度、动机或私交；只有当你真的派人接洽、共事、交锋之后，才把他们当作「打过交道的人」来写。');
  }
  return blocks.join('\n');
}

function renderHousehold(s) {
  const h = s.household;
  if (!h || (!h.clan && !(h.members || []).length)) return '（未登记。若本轮需要涉及家事，先向玩家确认，不要凭空编造家庭成员。）';
  const fmt = m => `- ${m.name}（${m.gender ? m.gender + '，' : ''}${m.relation}${m.rank ? '·' + m.rank + '出' : ''}，${m.age ?? '?'}岁，${m.status || '在世'}）${m.role ? '，' + m.role : ''}${m.nativePlace ? '，籍贯' + m.nativePlace : ''}${m.attitude ? '，对你的态度：' + m.attitude : ''}${m.note ? '。' + m.note : ''}`;
  const mem = (h.members || []);
  const inner = mem.filter(m => m.inner);
  const outer = mem.filter(m => !m.inner);
  const prop = h.property && Object.keys(h.property).length
    ? Object.entries(h.property).map(([k, v]) => `${k}=${v}`).join('、') : '未登记';
  const obl = (h.obligations || []).length ? h.obligations.join('、') : '未登记';
  const lines = [`宗族/家族：${h.clan || '未登记'}`];
  if (outer.length) lines.push('父母手足 / 族人：', outer.map(fmt).join('\n'));
  if (inner.length) lines.push('内宅（妻妾、子女、内宅管事 —— 请注意各人性别与嫡庶之别，内宅自有其争斗与人情）：', inner.map(fmt).join('\n'));
  lines.push(`家产：${prop}`, `家族义务与摊派：${obl}`);
  return lines.join('\n');
}

/* 派系 / 内斗：朝局不是铁板一块。写「谁与谁一党、争的是什么」，而不是把所有人写成一团和气。 */
function renderFactions(s) {
  const f = s.factions || [];
  if (!f.length) return '';
  return [
    '=== 朝局派系 / 内斗（本局年代真实存在的党争框架；GM 须据此写出各派立场、算计与倾轧，不得把朝野写成铁板一块） ===',
    '（下列为史实框架。哪个人属哪一派，你须依真实史实指认——用上表「本朝臣工」里的真人，不得看错人、也不得把外族或方外之士算作朝臣。）',
    f.map((x, i) => {
      const a = x.membersA && x.membersA.length ? '（' + x.membersA.join('、') + '）' : '';
      const b = x.membersB && x.membersB.length ? '（' + x.membersB.join('、') + '）' : '';
      return `${i + 1}. 【${x.title}】：${x.stake}。${x.sideA}${a} 与 ${x.sideB}${b} 相争。`;
    }).join('\n'),
  ].join('\n');
}

function renderGeography(s) {
  const g = s.geography;
  if (!g || !Object.keys(g).length) return '（未登记。写路程、行军、运粮、传信时必须按该地真实地理处理；不确定就写"不知"，不要编山水道路。）';
  const pick = ['地形', '水系', '道路驿站', '距州治', '邻境', '物产', '常发灾异'];
  const body = pick.filter(k => g[k]).map(k => `${k}：${g[k]}`).join('\n');
  return (body || '（该地真实地理记载不足，各字段均不详）')
    + (g.source ? `\n来源：${g.source}` : '')
    + (g.note ? `\n备注：${g.note}` : '');
}

/* 地盘：谁占着哪里。这是玩家最关心的战局记忆，GM 每轮都必须据此写，不得凭空改归属。 */
function renderTerritory(s) {
  const t = s.territory || [];
  if (!t.length) return '';
  return [
    '=== 地盘 / 势力控制（引擎按检索与历轮战事记录，是当前战局的既成事实） ===',
    t.map(x => `- ${x.name}：现由「${x.controlledBy || '不详'}」控制${x.note ? '（' + x.note + '）' : ''}`).join('\n'),
    '写战事时必须以此为准：不得让已失守的地方仍在我方手里，也不得凭空改变某地归属。若本轮确实易主，用 `CLAIM: 地名|新控制者|备注` 登记，引擎会记住。',
  ].join('\n');
}

function renderAnchors(s) {
  const a = s.anchors;
  if (!a) return '';
  const lines = ['=== 扮演真实历史人物 · 史实硬约束（违反即视为穿帮） ==='];
  if (a.born) lines.push(`生年：${a.born}。不得写他在此之前的任何事。`);
  if (a.died) lines.push(`卒年：${a.died}。不得让他活过这一年，也不得让他无故消失。`);
  if (a.birthPlace) lines.push(`籍贯：${a.birthPlace}。`);
  if (a.officeHistory) lines.push(`仕履（年份—官职）：${a.officeHistory}`);
  if (a.kin) lines.push(`已知亲属：${a.kin}`);
  if (a.events && a.events.length) {
    // 只列截至本年已发生的；未来的事（如称帝、身死）不剧透给 GM
    const past = require('./dossier').pastEvents(a.events, s.clock && s.clock.gregorianYear);
    if (past.length) lines.push(`已知大事（截至本年）：${past.join('；')}`);
  }
  if (a.qid) lines.push(`资料来源：https://www.wikidata.org/wiki/${a.qid}`);
  lines.push('年岁必须随年份真实递增；每轮出场都要能对应到他在这一年的真实处境。不确定就写不确定，禁止编造他的具体言行细节充当史实。');
  return lines.join('\n');
}

function renderEvents(pack, s) {
  // 年表已按时点切过的，就不再退回规则包预置事件（那是整朝一包、不分先后的旧数据）
  const evs = (s.eraEventsSource === 'timeline' || (s.eraEvents && s.eraEvents.length)) ? (s.eraEvents || [])
    : (s.eraPresetId && (pack.eventsByEra || {})[s.eraPresetId]) || [];
  const rum = s.eraEventsRumored || [];
  if ((!evs || !evs.length) && !rum.length) return '';
  const out = [
    '=== 外部消息 / 天下大势（截至此时、**已传到主角所在地**的真实事件，由年表按驿传行程推算；GM 须据此写场景与在场人物的反应，不得另造与年代不符的全局大事，也不得无视这些大势） ===',
    (evs || []).map((e, i) => `${i + 1}. ${e}`).join('\n') || '（暂无已确知的远方大事）',
  ];
  if (rum.length) {
    out.push('【传闻·未经证实】下列消息可能已经传来，只能经来人口中以传言出现，细节与真伪都不确定，主角不能据此当作确知：');
    out.push(rum.map(e => `· ${e}`).join('\n'));
  }
  if (s.eraEventsSource === 'timeline') out.push('（凡未列在上面的远方大事，此时此地都还不知道，一个字也不得写。）');
  return out.join('\n');
}

function renderThreads(s) {
  const arr = s.threads || [];
  if (!arr.length) return '（无）';
  return arr.map(t => {
    const stale = s.turn - (t.lastTouchedTurn || 0);
    return `- [${t.status}] ${t.title}${stale > 2 ? `（已 ${stale} 轮未触及）` : ''}${t.note ? ' — ' + t.note : ''}`;
  }).join('\n');
}

/* 篇幅偏好：短 / 标准 / 长 / 不限。默认「短」，直接决定模型写多少，治「太长玩不了」。 */
// 2026-10-08：按用户的 GM 规范（history-rpg-gm v5.0 §5.3），默认正文 1200~2000 字（key: long）；短篇幅留作可选
const VERBOSITY = {
  short:   { min: 300, max: 700,  hint: '300~600 字，只写这一件事最关键的反应' },
  normal:  { min: 600, max: 1200, hint: '600~1000 字，简明' },
  long:    { min: 1000, max: 2300, hint: '1200~2000 字，承接→推进→变数→停点，写活场景，不灌水' },
  nolimit: { min: 0,   max: 0,    hint: '不设硬限，但仍须紧扣玩家指令' },
};
function verbosityOf(opts, pack) {
  const key = (opts && opts.verbosity) || 'long';
  const v = VERBOSITY[key] || VERBOSITY.short;
  const oc = (pack && pack.outputContract) || {};
  return { key, min: v.min, max: v.max, hint: v.hint };
}

/**
 * 人物身份体检 + 逐年史实结算（协议 §12 / §13）。
 * 两条内容都是引擎硬算出来的，GM 不得无视，也不得在正文里与之冲突：
 *   ① name 身份体检：本年此人的生卒、身份、职掌是否与该年相符；
 *   ② 逐年结算流水：跨年时人物实际发生了什么（封王、拜官、称帝、身死）。
 */
function renderFigureAudit(state) {
  const lines = [];
  const issues = state.figureIssues || (state.figureAudit && state.figureAudit.issues) || [];
  if (issues && issues.length) {
    lines.push('=== 人物身份体检（引擎每轮重算，以下为查出的硬错误，正文不得与之冲突） ===');
    for (const i of issues.slice(0, 12)) {
      lines.push(`- 【${i.level || 'S0'}】${i.who}：${i.text}${i.suggest ? `　应改为：${i.suggest}` : ''}`);
    }
    lines.push('- 上述人物若已过世，不得出场；若该年尚未称帝，称谓与名分须按该年的实际身份写。');
  }
  const log = (state.figureLog || []).slice(-12);
  if (log.length) {
    lines.push('=== 史实逐年结算（世界已据此推进，不是你可选的背景） ===');
    for (const c of log) lines.push(`- ${c.year ? c.year + '年 · ' : ''}${c.text}`);
  }
  if (state.identityIssue) {
    lines.push(`=== 身份变更待确认 ===\n- ${state.identityIssue.note}（当前存档写的是「${state.identityIssue.from}」；是否改为「${state.identityIssue.to}」由玩家确认，你不得擅自改写）`);
  }
  if (state.protagonistDead) {
    lines.push(`=== 主角已故 ===\n- ${state.protagonistDead.name}于${state.protagonistDead.year}年身故${state.protagonistDead.note ? '：' + state.protagonistDead.note : ''}。此后叙事须按其继承人/旧部的处境展开，不得再让他本人出场。`);
  }
  return lines.join('\n');
}

function buildPrompt(pack, state, input, opts = {}) {
  const vb = verbosityOf(opts, pack);
  // 实测 DeepSeek 只看到上限时常写 800~900 字；下限要明说
  const lenRule = vb.max ? `正文控制在 ${vb.hint}；少于 ${vb.min} 字或超过 ${vb.max} 字都不合格（不够长就把对话与阻力写足，不要灌景物）。` : '紧扣玩家指令，不设篇幅硬限。';
  const system = pack.systemPrompt
    + `\n\n【篇幅】${lenRule}`
    + '\n\n【你要扮演的身份类型】：' + (opts.identityModule ? pack.identityModules[opts.identityModule] : pack.identityModules[state.identityModule] || '')
    + '\n\n【输出格式】返回严格 JSON，不要包 ``` 代码块，字段如下：'
    + '\n' + JSON.stringify(pack.outputContract.schema, null, 2);

  // 历史只留摘要（每轮最多 160 字），避免提示词逐轮膨胀、模型越写越长
  const recent = (state.log || []).slice(-3).map(l => `[第${l.turn}轮/${l.time}] ${String(l.text || '').slice(0, 160)}${String(l.text || '').length > 160 ? '…' : ''}`).join('\n\n');
  // 首轮 = 整局开场（存档尚无任何叙事）
  const isOpening = opts.isOpening != null ? opts.isOpening : (!(state.log || []).some(l => l.speaker === 'GM'));

  const prompt = [
    // —— 最前：本轮任务（模型先看到的就是这个，杜绝被淹没）——
    '############ 本轮任务（最重要，先读这里） ############',
    isOpening
      ? '【本轮是整局开场】玩家尚未行动。请写一场开场戏（要求见下「开局设定」）：一个具体的人带着一件具体的事来到主角面前，身份与时局借他之口带出，停在等主角回应处。'
      : '玩家本回合的指令（主角本回合唯一的行动，一切服从它）：',
    isOpening ? '' : (input || '（玩家本回合未写具体指令：请你呈现此刻正在发生、且对主角构成压力的活场景，然后停下等玩家决定。）'),
    '',
    '你必须做到：',
    '1. 只写「世界、他人、环境」对上面这一件事的反应与后果；不得改写、忽略或替换成别的行动。',
    '2. 开篇第一句就进入这件事（有人在场、有事发生），不要先写一段天气景物或人物履历。',
    '3. 玩家点名的人物、称谓、物件、地点照用；若你疑心与实际不符，只能在 understood 里点明，不得擅自改成别人。',
    '4. 绝不替玩家做决定、说话、下令、答应或动手；凡「要不要…」的抉择一律留给他。',
    '5. NPC 要有动作、要符合人的常情与该身份处境；不得古怪离奇，不得为了剧情需要让谁突然反常、或懂了他本不该懂的事。',
    '6. 若涉及真实人物：与他往来者也须是史料可查的真人（父母妻儿师友同僚部属），只有侍从内侍婢仆军卒可为虚构且须标虚构；不同时代的真人不得相会（秦始皇与刘邦不能同席）。',
    '7. 一切道德与观念都要**合乎那个时代**：等级、忠孝、宗法、鬼神、天命、名分，是当时人真心相信的天理。不得让任何人物有现代的权利观、平等观、科学观、个人主义或心理分析式自省；人物按当时的道理行事，哪怕在你我看来残酷不仁。',
    '8. 玩家若用了现代词或现代做法，见下方「现代词汇转译」，一律落成当时真实可行的行为再演，正文与 understood 都不得出现现代词。',
    // 旧第 9 条要求「写生死名节、不写公文琐务」，与开局「从日常落笔」打架，模型两头顾，结果写成流水账
    '9. **写成一场戏，而不是一份公文**：一件事、几个人、几句话。日常之事也有戏——要写出其中的人：他求什么、怕什么、话里留了几分。人物用自己身份与时代的口吻说话，有来有往；不要让僚属排队递文书、念账目。远方大事只经人之口进来。结尾停在一个要主角表态的地方（有人在等他一句话、一个决定）。宁可一件事写透，不要几件小事并陈；不要罗列账目，需要数字时按量级锚点给、且经得起推算。至少一个玩家没料到的变数；场景套路不要与上一回合重复。',
    '10. **凡写真实人物 / 地名 / 事件 / 官制 / 年号 / 器物之年代，必须先 SEARCH 查证**（见下方指令说明），不得凭记忆直接写；检索不到就按「不详」处理，不要编造。',
    `11. ${lenRule}`,
    '',
    '【十遍扫描防线：下笔前先自检，写错即整轮作废】',
    '① 主角句只许写允许的那几类：A 感官（看见/听见）、B 身体（饿、累、病）、E 被动（被召、被拦、被斥）、F 状态（你的官职身份，须与档案一致）。',
    '② C 类外在动作：只有玩家本轮写过这个动作才许写；否则只写到「最小细化」为止（点头、拱手、起身、接过），不许再往下推进。',
    '③ D 类内心一律禁写：不许出现「你心想/你暗想/你打定主意/你决定」；也不许用「你随即…」「你接着…」「你于是…」把玩家没交代的动作一路写下去。',
    '④ 不许替玩家说话：引号里归在「你」名下的整句台词，必须是玩家本轮的原话；否则改成旁人说，把话头留给玩家。不许写「他替你答应/代你做主」。',
    '⑤ 不许未卜先知：没人能预先知道玩家要做什么；旁人知道的每件事都要有出处（谁说的、在哪听来的、亲眼还是耳闻）。',
    '⑥ 时间不归你管：正文只写当日之事，不许出现「次日/三日后/数月后」这类跨日推进；写到月日须与时钟一致。',
    '⑦ 已故者不得出场；人物开口前须先有入场（传报、掀帘、求见）；写过退场的人不得再开口。',
    '⑧ 本轮至少要有一条新信息、或一个转折、或一笔代价（欠人情/得罪人/花粮钱/留把柄），结尾停在要他拍板的地方。',
    '',
    renderTranslation(input),
    '############ 以上为本轮任务，以下为背景资料 ############',
    '',
    renderLedger(state),
    '',
    renderNumericGuide(state),
    '',
    renderOpening(state, isOpening),
    '',
    '=== 世界当前状态（引擎提供，以它为准，不得改写） ===',
    renderStateBrief(state, pack),
    '',
    renderArchiveBlock(state, pack),
    '',
    '=== 已登记人物 ===',
    (state.identityModule === 'emperor'
      ? '【本朝臣工与同代真人】下列皆是与你在位同时的真实历史人物，各有真实身份与职掌。你须据其真实身份调度、猜忌、倚仗；叙事不得与其真实人事相冲突。'
      : ''),
    renderNpcs(state),
    '',
    renderFigureAudit(state),
    '',
    '=== 家庭 / 家族 ===',
    renderHousehold(state),
    '',
    '=== 地理 ===',
    renderGeography(state),
    '',
    renderTerritory(state),
    '',
    renderBattle(state),
    '',
    renderEncounter(state),
    '',
    renderDrama(state.drama),
    '',
    renderEvent(state.currentEvent),
    '',
    renderAnchors(state),
    '',
    renderEvents(pack, state),
    '',
    renderFactions(state),
    '',
    renderLiveHistory(state),
    '',
    '=== 线索表（推进与否由玩家决定，你不得替他收尾） ===',
    renderThreads(state),
    '',
    '=== 硬规则 ===',
    (pack.hardRules || []).map(r => '- ' + r).join('\n'),
    '',
    opts.playerConfirmedThreads && opts.playerConfirmedThreads.length
      ? '=== 玩家本回合明确要求触及的线索 ===\n' + opts.playerConfirmedThreads.map(t => '- ' + t).join('\n')
      : '=== 玩家本回合没有指定要触及的线索 ===\n你可以自然提及，但不得替玩家推进或收尾任何线索。',
    '',
    '=== 最近三轮叙事（仅供衔接，切勿照此长度续写） ===',
    recent || '（本轮为开局）',
    '',
    '=== 收尾要求 ===',
    `写到「${pack.outputContract.requireDecisionMarker}」即停，把它原样放在 pendingDecision 字段与正文结尾。不得替玩家做选择，不得给选项式建议。`,
    `最后再强调一次：本轮正文只写「${(input || '此刻正在发生的事').slice(0, 40)}」这一件事，${vb.hint}。`,
  ].join('\n');

  return { system, prompt, verbosity: vb };
}

module.exports = { buildPrompt, verbosityOf, VERBOSITY, npcHasContact, tracksAttitudes };
