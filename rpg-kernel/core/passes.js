'use strict';
/**
 * 纳米级剧情审计：P0–P9 十遍扫描
 *
 * 方法：把每一轮输出拆成「断言 / 动作 / 对话行 / 数字 / 状态」这些原子单位，
 * 十遍扫描逐个验证；错误一律「编码、定级、溯源、回归」。
 *
 *   P0 输入对账     把玩家的话拆成约束（约束表 / 模糊指令表 / 优先级 / 授权台账）
 *   P1 主语与动作归属 主角句分 A–F 六类，D 类内心禁写、C 类须有出处
 *   P2 断言核查      可判真假的断言 → 与状态卡比对，冲突即报错
 *   P3 时间线        时间词排序、倒流、跳跃、与时钟冲突
 *   P4 在场表        出场人物是否有入场 / 不在场却发言 / 退场后仍在
 *   P5 四本账        人情账、利害账、信息账、物资账
 *   P6 知识矩阵      谁知道什么 —— 未卜先知 / 信息无出处
 *   P7 对话审计      每句对话的说话人、身份、语域、是否替玩家说
 *   P8 情节节拍      本轮是否真的推进（新信息 / 转折 / 代价 / 选择点）
 *   P9 状态卡与追溯   状态卡差异、错误编码汇总、复发（回归）判定
 *
 * 证据等级：
 *   E0 凭空（无出处）  E1 模型自述  E2 档案/状态卡可查  E3 外部检索证据
 * 严重度：
 *   S0 致命（整轮作废） S1 严重（须改） S2 一般（建议改） S3 提示
 */
const { modernHitsIn } = require('./eraVocab');

/* ============================ 编码 / 定级 ============================ */
const SEVERITY = { S0: '致命', S1: '严重', S2: '一般', S3: '提示' };
const EVIDENCE = { E0: '凭空', E1: '模型自述', E2: '档案可查', E3: '检索证据' };

const PASS_META = [
  ['P0', '输入对账', '把玩家这一轮的话拆成约束，明确「必须兑现 / 禁止越界」'],
  ['P1', '主语与动作归属', '主角句分 A–F 六类：内心禁写、动作须有出处'],
  ['P2', '断言核查', '可判真假的断言逐条与状态卡比对'],
  ['P3', '时间线', '时间词排序、倒流、跳跃、与时钟冲突'],
  ['P4', '在场表', '出场人物须有入场，不在场者不得发言'],
  ['P5', '四本账', '人情账 / 利害账 / 信息账 / 物资账'],
  ['P6', '知识矩阵', '谁知道什么 —— 查未卜先知与无出处信息'],
  ['P7', '对话审计', '每句对话的说话人、身份、语域、是否替玩家说'],
  ['P8', '情节节拍', '本轮是否真的推进：新信息 / 转折 / 代价 / 选择点'],
  ['P9', '状态卡与追溯', '状态卡差异、错误编码汇总、复发判定'],
];

let SEQ = 0;
function issue(pass, code, severity, title, detail, opts = {}) {
  return {
    id: `${pass}-${code}-${++SEQ}`,
    pass, code: `${pass}-${code}`, sev: severity,
    sevLabel: SEVERITY[severity] || severity,
    title, detail,
    at: opts.at || '',                    // 溯源：原文片段
    evidence: opts.evidence || 'E0',      // 证据等级
    evidenceLabel: EVIDENCE[opts.evidence || 'E0'],
    fix: opts.fix || '',                  // 怎么改
    blocking: severity === 'S0',
  };
}

/* ============================ 通用切分 ============================ */
// 按句读切句，保留引号内的内容不被句号切断（粗略但够用）
function splitSentences(text) {
  const s = String(text || '');
  const out = [];
  let buf = '';
  let inQuote = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '「' || ch === '“' || ch === '"') inQuote++;
    else if (ch === '」' || ch === '”' || ch === '"') inQuote = Math.max(0, inQuote - 1);
    if (!inQuote && /[。！？!?\n]/.test(ch)) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = '';
    } else buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

// 抽取对话行：说话人 + 内容。匹配「XX道：」/「XX说：」/「XX：」以及紧跟的引号内容
function extractDialogue(text) {
  const s = String(text || '');
  const out = [];
  const re = /([^\s，。！？；：、“”「」]{1,12}?)(?:[道说问答回喝斥笑叹问曰禀奏接口吟][道说])?\s*[:：]\s*([「“"][^」”"]*[」”"])/g;
  let m;
  while ((m = re.exec(s))) {
    let speaker = m[1].replace(/^[的地和与随后忽便又乃于是]+/, '').trim();
    const body = m[2].replace(/^[「“"]|[」”"]$/g, '');
    if (!body) continue;
    if (!speaker) {
      // 往前找最近的说话人
      const before = s.slice(Math.max(0, m.index - 60), m.index);
      const mb = before.match(/([^\s，。！？；：、“”「」]{1,10})[^。！？]{0,8}$/);
      speaker = mb ? mb[1] : '';
    }
    out.push({ speaker: cleanSpeaker(speaker), body, index: m.index });
  }
  // 兜底：没有「XX：」形式的独立引号，也当作一行对话（说话人未知）
  const known = new Set(out.map(x => x.body));
  const re2 = /([「“"])([^」”"]{2,})([」”"])/g;
  let m2;
  while ((m2 = re2.exec(s))) {
    const body = m2[2];
    if (known.has(body)) continue;
    out.push({ speaker: '', body, index: m2.index });
  }
  return out.sort((a, b) => a.index - b.index);
}

/* 说话人清洗：把「蒋文举抬眼看你，你拱手道」里挂在名字后面的姿态与说字去掉 */
const MANNER = '(?:拱手|欠身|抬眼|抬眸|含笑|冷笑|苦笑|沉吟|正色|低声|高声|朗声|淡淡|厉声|轻声|缓缓|连声|点头|摇头|摆手|忙|便|遂|于是|又|也|却|乃|当下|忽|只|连|先|再|才|就|这才)';
function cleanSpeaker(s) {
  let t = String(s || '').trim();
  t = t.replace(/[道说问答曰喝斥笑叹应回云唤]+$/, '');
  t = t.replace(new RegExp(MANNER + '+$'), '');
  t = t.replace(/[的地得](?=$)/, '').trim();
  return t || '';
}

const QUOTE_RE = /[「“"][^」”"]*[」”"]/g;
function stripQuotes(t) { return String(t || '').replace(QUOTE_RE, '〚引〛'); }

/* ============================================================
   P0 输入对账：把玩家这一轮的话拆成约束
   ============================================================ */
// 顺序即优先级：从上往下第一个命中的类型算数
const P0_RULES = [
  { type: '禁止', re: /(不要|不许|不准|不可|别|莫|勿|严禁|绝不|切莫|休要|不得|禁止|免了|算了别)/,
    must: '正文里不得出现被禁止的事', forbid: '任何形式的越界执行' },
  { type: '授权', re: /(你来定|你定|你看着办|你自己决定|由你|听你的|你安排|随便你|无所谓|你决定|都行|随意|你看着)/,
    must: 'GM 可代为推进，但仍不得替玩家写内心', forbid: '把授权当成替玩家做重大抉择的许可' },
  { type: '目标', re: /(我要|我想|我打算|我决意|务必|必须|定要|志在|图谋|意在)/,
    must: '让世界对该目标作出反应（阻力或助力）', forbid: '让目标自动达成' },
  { type: '模糊', re: /(看看情况|随便逛逛|转转|走走|做点什么|看看|了解一下|打听打听|瞧瞧|待着|等等看|先看看|有什么动静)/,
    must: 'GM 只写「环境送上门的第一件事」，停在玩家做选择之前', forbid: '替玩家把这件事办完' },
  { type: '时间', re: /(三日|三天|五日|五天|旬日|十天|半月|一月|数月|一年|等到|过了|次日|明日|后日|当晚|入夜|天亮)/,
    must: '时间推进须由时钟执行，不得在正文里快进', forbid: '在一段正文内跨过多个时日' },
  { type: '行动', re: /(查|审|搜|抓|捕|杀|买|卖|写|修|练|招募|赈|减免|上奏|弹劾|结交|拜访|送|收|核|盘|验|封|放|免|赦|斩|调|借|还债|聚|散)/,
    must: '把这件事的头一步演出来，遇到阻力', forbid: '一句话把整件事办完' },
  { type: '言语', re: /(说|问|告诉|回答|回话|答应|拒绝|骂|称赞|上奏|禀|称|道|交待|交代|吩咐|劝|谢|赔)/,
    must: '把这句言语的对方、场合、后果写出来', forbid: '替玩家写出他没说过的整段话' },
  { type: '移动', re: /(去|往|到|回|赴|入|进|上京|上任|离|出城|进城|过江|北上|南下)/,
    must: '写出路程、门禁、所见', forbid: '瞬移或跳过路途上的遭遇' },
  { type: '询问', re: /(吗|呢|如何|怎样|怎么|谁|什么|哪里|何处|几许|多少|可否|能不能)[？?]?$/,
    must: '正面回答玩家的问题', forbid: '回避或改写成别的事' },
];

function splitClauses(input) {
  const s = String(input || '').trim();
  if (!s) return [];
  const rough = s.split(/[。！？；;\n!?]+/).map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const r of rough) {
    if (r.length <= 24) { out.push(r); continue; }
    // 长句再按逗号切
    for (const p of r.split(/[，,]/).map(x => x.trim()).filter(Boolean)) out.push(p);
  }
  return out;
}

function p0Input(state, input) {
  const clauses = splitClauses(input);
  const table = [];
  const fuzzy = [];
  const priority = [];
  const issues = [];
  let authorized = false;
  const authScopes = [];

  if (!String(input || '').trim()) {
    issues.push(issue('P0', 'E01', 'S3', '本轮玩家没有输入', '没有指令就没有约束可言，正文只能是「世界主动送上来的事」，且必须停在玩家做选择之前。', { at: '', evidence: 'E2' }));
  }

  clauses.forEach((frag, i) => {
    let type = '陈述';
    let rule = null;
    for (const r of P0_RULES) {
      if (r.re.test(frag)) { type = r.type; rule = r; break; }
    }
    const row = {
      i: i + 1,
      frag,
      type,
      明确: rule ? rule.must : '无明确约束（视为「世界照常运转」）',
      未明确: [],
      必须兑现: rule ? rule.must : '保持世界连续，不做无由头的突发事件',
      禁止越界: rule ? rule.forbid : '不得替玩家做决定、不得写玩家内心',
    };
    // 未明确的部分：逐项检查
    if (!/(何时|几时|什么时辰|多久)/.test(frag)) row.未明确.push('时间');
    if (!/(在|于|到|去|往)[^，。]{0,8}(处|地|县|州|府|城|营|帐|衙|寺|乡|村)/.test(frag) && !/(这里|那里|当地|本地)/.test(frag)) row.未明确.push('地点');
    const namedTarget = (state.npcs || []).some(n => n.name && frag.includes(n.name));
    if (!namedTarget && !/(对|向|与|和|跟|同)[^，。]{0,10}/.test(frag) && type !== '询问') row.未明确.push('对象');
    if (!/(用|以|拿|使|凭|带)[^，。]{0,8}/.test(frag)) row.未明确.push('手段');
    table.push(row);

    if (type === '授权') {
      authorized = true;
      authScopes.push(frag);
    }
    if (type === '模糊') {
      fuzzy.push({
        frag,
        解释: ['观察而不行动', '与人搭话', '就地处理眼前第一件事'],
        需澄清: '你要的是「看」还是「做」？做了之后要不要承担后果？',
        默认处理: '只写环境送上门的第一件事，停在你要做选择之前',
      });
    }
  });

  // 优先级：禁止 > 目标 > 明确行动 > 询问 > 授权 > 模糊 > 默认
  const order = ['禁止', '授权', '目标', '模糊', '时间', '行动', '言语', '移动', '询问', '陈述'];
  for (const t of order) {
    const hits = table.filter(r => r.type === t);
    if (hits.length) priority.push({ 级: order.indexOf(t) + 1, 类型: t, 条目: hits.map(h => h.frag) });
  }

  return {
    table, fuzzy, priority,
    authorization: { granted: authorized, scopes: authScopes, note: authorized ? '玩家本轮把决定权交给了 GM —— 仍禁止写内心独白与重大抉择' : '玩家未授权，GM 不得替他拍板' },
    issues,
  };
}

/* ============================================================
   P1 主语与动作归属：主角句 A–F 六类
   ============================================================ */
/* 主角句分类用的有序模式表（从上往下第一个命中的算数）。
   刻意收紧：D 类要够准才敢判 S0；C 类的单字动词必须紧贴「你」，避免把「知道」「决定」误判。 */
const PAT = [
  ['D1', /你[^。！？\n]{0,2}(?:打定主意|拿定主意|下定决心|心意已决|决意已定|拿定了主意)/, 1],
  ['D1', /你(?:心底|心中|暗里)?(?:已|便|遂|于是)?(?:决定|决意)(?:要|去|不|把|先|如何|如此|下来|了|如何是好)?/, 1],
  ['D2', /(?:心想|暗想|心道|暗忖|寻思|思忖|心里想|心中想|暗里想)/, 1],
  ['D2', /你[^。！？\n]{0,4}(?:暗自|盘算|暗暗|心中盘算|暗叹|心中默|不由得想)/, 1],
  ['D3', /(?:心中一凛|心头一紧|心中一喜|心中大喜|心中恼怒|感到欣慰|心中不安|心中一沉|心头火起|心中五味|心中苦涩|暗自庆幸|心中百感|心头一热)/, 1],
  ['E', /(?:被(?:召见|传唤|召|拦|推|赐|贬|劾|捕|打|斥|问|阻|解职|卸|请|邀|迫)|挨了|遭到|受了)/, 1],
  ['F', /你(?:如今|现|此刻|本|已|仍|素|向|自)?(?:是|官拜|任|担任|领)(?!何|什么)/, 1],
  ['A', /(?:看见|瞧见|望见|瞥见|看到|望到|听见|听到|听得|听闻|闻得|嗅到|尝到|触到|摸到|眼见|目睹|入耳|入目|见得)/, 1],
  ['B', /(?:饿了|口渴|口干|疲惫|疲倦|困乏|病了|咳嗽|疼痛|作痛|头晕|目眩|手心出汗|心跳|冷得|热得|踉跄|颤抖|发抖|脸色发白|满头大汗|腿软|气喘)/, 1],
  ['C', /(?:走上|走进|走出|上前|上马|下马|站起|站定|坐下|跪下|叩首|拱手|作揖|说道|答道|问道|回话|拔刀|抽出|举起|挥手|写下|起草|递上|接过|取过|拿起|放下|翻开|翻阅|批阅|签署|画押|命人|派人|召见|点头|摇头|笑了|哭道|斥道|喝道|送去|收下|起身|离席|入座|转身|抬眼|抬手|上奏|启程|登舟|登船|骑马|出城|进城|过江|叩谢|拜谢|告辞|退下|斟酒|举杯|饮酒|离了|来到|到了|去了|回到|进入)/, 1],
  ['C', /你(?:便|遂|于是|当下|又|连忙|立即|立刻|赶紧|先|只|再)?(走|进|出|跪|拜|写|递|接|取|拿|放|翻|命|派|召|笑|哭|斥|送|收|退|追|拦|挡|扶|逃|去|到|回|上|下|站|坐|说|问|答|喝|吃|开|关|穿|披|拔|挥|举)/, 1],
];

// 最小细化：即便玩家没写，也允许写的「应答性动作」——停在反应，不推进剧情
const MINIMAL = ['点头', '摇头', '应声', '应了', '应道', '拱手', '作揖', '起身', '离席', '入座', '转身', '抬眼', '抬手', '放下', '接过', '递出', '回话', '称是', '诺', '道谢', '行礼', '看去', '望过去', '抬眸', '侧身', '让开', '站定', '站起', '坐下', '沉默', '不语', '缄口'];

// 连续推进的高危句式：玩家只说了一件事，正文却一路写下去
const CONT_MARK = /(随即|接着|于是|当下|连忙|立马|立即|赶紧|一面)/;

// 隐性决策窃取：别人替你答应/决定
const STEAL_RE = /(替你(?:答应|应下|应了|决定|做主|拍板|回绝|谢绝|答应下来))|(代你(?:答应|应下|决定|做主|回绝))|(为你做主)|(帮你拿主意)/g;

// 时间预占：正文里自己往前提时间
const TIME_JUMP_RE = /(次日|翌日|第二天|第三日|三日后|五日后|旬日后|半月后|一月后|数月后|一年后|过了(?:三|五|十|半|一)个?[日月年])/g;

function classifySentence(s) {
  for (const [cls, re] of PAT) {
    if (re.test(s)) return { cls, word: (s.match(re) || [])[1] || (s.match(re) || [])[0] || '' };
  }
  return null;
}

function p1Subject(scene, p0, state) {
  const issues = [];
  const rows = [];
  const sents = splitSentences(scene);
  const input = String(state.__input || '');
  const authorized = p0.authorization.granted;

  // 玩家原话里出现过的动词（出处）
  const hasProvenance = (word) => {
    if (!input) return false;
    if (input.includes(word)) return true;
    const w = word.length >= 2 ? word.slice(0, 2) : word;
    return input.includes(w);
  };

  sents.forEach((s0, idx) => {
    const stripped = stripQuotes(s0);   // 去掉引号内容，避免把别人说的话当成主角动作
    if (!stripped.includes('你')) return;
    // 一句里常有多个「你…」小句（如「你拱手道…，你随即翻开账册」），逐小句判定
    const subs = stripped.split(/[，,；;]/).filter(x => x.includes('你'));
    for (const s of (subs.length ? subs : [stripped])) judgeClause(s, idx);
  });

  function judgeClause(s, idx) {
    const hit = classifySentence(s);
    if (!hit) return;
    const row = { i: idx + 1, 句: s.slice(0, 40), 类: hit.cls, 词: hit.word, 判定: '', 依据: '' };

    if (hit.cls === 'D1') {
      row.判定 = '禁（内心决断）'; row.依据 = '玩家的抉择只能由玩家自己写';
      issues.push(issue('P1', 'D01', 'S0', '替玩家做了内心决定',
        `正文写「${hit.word}」—— 这是玩家的决断，只能由他自己的指令产生。`,
        { at: s.slice(0, 60), fix: '删掉这句，改为把局面摆到他面前，以「用户决定」收尾。', evidence: 'E2' }));
    } else if (hit.cls === 'D2') {
      if (authorized) { row.判定 = '特许（玩家已授权）'; row.依据 = '玩家本轮把决定权交给 GM'; }
      else {
        row.判定 = '禁（内心独白）'; row.依据 = '内心活动只能来自玩家的指令';
        issues.push(issue('P1', 'D02', 'S1', '替玩家写内心独白',
          `正文写「${hit.word}」—— 玩家没有写过这个念头。`,
          { at: s.slice(0, 60), fix: '改成可从外面看出来的样子（神色、动作、一句话），或直接删掉。', evidence: 'E1' }));
      }
    } else if (hit.cls === 'D3') {
      row.判定 = '限（情绪须有外因）'; row.依据 = '情绪只能由本轮发生的事引出';
      if (!input) {
        issues.push(issue('P1', 'D03', 'S3', '主角情绪无外因', `写了「${hit.word}」，但本轮没有明显的触发事件。`, { at: s.slice(0, 60), fix: '补一句触发它的外因。', evidence: 'E1' }));
      }
    } else if (hit.cls === 'C') {
      const minimal = MINIMAL.some(w => s.includes(w));
      const prov = hasProvenance(hit.word);
      if (prov) { row.判定 = '可（有玩家出处）'; row.依据 = '玩家本轮写过这个动作'; }
      else if (minimal) { row.判定 = '可（最小细化）'; row.依据 = '只写到「反应」为止，没有替他推进'; }
      else {
        const cont = CONT_MARK.test(s) && new RegExp(`你[^。！？\\n]{0,10}${CONT_MARK.source}`).test(s);
        row.判定 = cont ? '禁（擅自连续行动）' : '疑（动作无出处）';
        row.依据 = cont ? '玩家只说了一件事，正文却一路往下写' : '玩家本轮没写过这个动作';
        issues.push(issue('P1', cont ? 'C01' : 'C02', cont ? 'S1' : 'S2',
          cont ? '擅自连续行动' : '主角动作没有出处',
          cont
            ? `「${s.slice(0, 30)}…」—— 玩家只交代了一件事，正文却用「${hit.word}」继续推进。`
            : `「${s.slice(0, 30)}…」—— 玩家本轮没写过「${hit.word}」，这是 GM 替他动的。`,
          { at: s.slice(0, 60), fix: cont ? '删到玩家指令的终点就停，剩下的等他下一轮说。' : '改成环境/NPC 的举动，或让他自己来写这一步。', evidence: 'E0' }));
      }
    } else if (hit.cls === 'E') {
      row.判定 = '可（被动结果）'; row.依据 = '外界施加于他，非他自主';
    } else if (hit.cls === 'F') {
      row.判定 = '可（状态陈述）'; row.依据 = '须与状态卡一致（见 P2）';
    } else {
      row.判定 = '可（感官/身体）'; row.依据 = 'A/B 类不算行动';
    }
    rows.push(row);
  }

  // 隐性决策窃取
  let sm;
  const stealRe = new RegExp(STEAL_RE.source, 'g');
  while ((sm = stealRe.exec(scene))) {
    issues.push(issue('P1', 'S01', 'S0', '别人替玩家做了决定',
      `正文写「${sm[0]}」—— 这是把玩家的选择权拿走了。`,
      { at: scene.slice(Math.max(0, sm.index - 20), sm.index + 30), fix: '改成「他等着你开口」或「他把话头递给你」。', evidence: 'E2' }));
  }

  // 替玩家说整段话：引号内容归属于「你」，且玩家原话里没有
  const dlg = extractDialogue(scene);
  const playerName = (state.protagonist && state.protagonist.name) || '';
  for (const d of dlg) {
    const isPlayer = d.speaker === '你' || (playerName && d.speaker === playerName);
    if (!isPlayer) continue;
    const body = d.body.replace(/[，。！？、；：]/g, '');
    const inp = String(input || '').replace(/[，。！？、；：]/g, '');
    const verbatim = inp && body.length >= 2 && inp.includes(body);
    const shortReply = body.length <= 6 && /^(是|诺|好|遵命|谢|不敢|正是|然|善|唯|喏|领命|遵|可|罢了|且慢|住手|退下|不必|容我)/.test(body);
    if (!verbatim && !shortReply) {
      issues.push(issue('P1', 'S02', 'S0', '替玩家说了他没说过的话',
        `把「${d.body.slice(0, 30)}」安在了你嘴里，但你这轮并没这么写。`,
        { at: d.body.slice(0, 60), fix: '删掉这句台词，改成旁人问/旁人说，把话头留给你。', evidence: 'E0' }));
    }
  }

  const table = { rows, authorization: p0.authorization };
  return { issues, table };
}

/* ============================================================
   P2 断言核查：与状态卡逐条比对
   ============================================================ */
const ASSERT_RE = /(?:^|[，。！？；：])([^，。！？；：]{0,20}?)(是|为|官拜|领|任|据|辖|治|属于|归|已|未|尚无|共有|计有|存有)([^。！？；]{0,30})/g;

function stateFacts(state) {
  const f = [];
  const p = state.protagonist || {};
  const c = state.clock || {};
  const L = state.location || {};
  f.push({ k: '身份', v: p.role || '', src: 'protagonist.role' });
  f.push({ k: '姓名', v: p.name || '', src: 'protagonist.name' });
  f.push({ k: '年龄', v: p.age != null ? String(p.age) : '', src: 'protagonist.age' });
  f.push({ k: '年号', v: c.yearLabel || '', src: 'clock.yearLabel' });
  f.push({ k: '公元', v: c.gregorianYear != null ? String(c.gregorianYear) : '', src: 'clock.gregorianYear' });
  f.push({ k: '月', v: c.month != null ? String(c.month) : '', src: 'clock.month' });
  f.push({ k: '日', v: c.day != null ? String(c.day) : '', src: 'clock.day' });
  f.push({ k: '所在地', v: L.full || '', src: 'location.full' });
  f.push({ k: '政权', v: L.polity || '', src: 'location.polity' });
  f.push({ k: '控制者', v: L.controller || '', src: 'location.controller' });
  (state.npcs || []).forEach(n => f.push({ k: '人物:' + n.name, v: n.role || n.tie || '', src: 'npcs' }));
  return f.filter(x => x.v);
}

function p2Assertions(scene, state) {
  const issues = [];
  const rows = [];
  const facts = stateFacts(state);
  const sents = splitSentences(scene).map(stripQuotes);
  const names = (state.npcs || []).map(n => n.name).filter(Boolean);

  // 1) 直接冲突：正文里写「你是X」「你官拜X」，与状态卡不一致
  const roleRe = /你(?:如今|现|此刻|本|已|仍)?(?:是|为|官拜|领|任|担任)([^，。！？；]{1,20})/g;
  let m;
  while ((m = roleRe.exec(scene))) {
    const claimed = m[1].trim();
    const real = (state.protagonist && state.protagonist.role) || '';
    // 「你是杜伏威」——那是姓名，不是职衔，不算身份断言
    const pname = (state.protagonist && state.protagonist.name) || '';
    if (pname && (claimed === pname || claimed.startsWith(pname))) continue;
    rows.push({ 断言: `你是${claimed}`, 出处: '正文', 档案: real || '（未登记）', 判定: real && !claimed.includes(real) && !real.includes(claimed) ? '冲突' : '一致', 证据: 'E2' });
    if (real && !claimed.includes(real) && !real.includes(claimed)) {
      issues.push(issue('P2', 'A01', 'S1', '身份断言与状态卡冲突',
        `正文说你是「${claimed}」，档案里是「${real}」。`,
        { at: m[0], fix: '以档案为准，或先在档案页改身份再写。', evidence: 'E2' }));
    }
  }

  // 2) 数字断言：与档案年龄/年份/资源比对
  const ageRe = /你(?:今年|现年|年方|时年|已)?(?:([二十百零一二三四五六七八九\d]+)岁)/g;
  while ((m = ageRe.exec(scene))) {
    const said = m[1];
    const real = state.protagonist && state.protagonist.age;
    if (real != null) {
      const n = cn(said);
      if (n != null && Math.abs(n - real) > 1) {
        issues.push(issue('P2', 'A02', 'S1', '年龄断言与档案冲突',
          `正文说你 ${said} 岁，档案推算为 ${real} 岁。`,
          { at: m[0], fix: '按档案写，或说明这是虚岁/口述误差。', evidence: 'E2' }));
      }
    }
  }

  // 3) 人物断言：正文说某人的官职/立场，与档案登记的不同
  for (const n of names) {
    const re = new RegExp(`${n}(?:是|为|任|官拜|领)([^，。！？；]{1,18})`, 'g');
    let mm;
    while ((mm = re.exec(scene))) {
      const claimed = mm[1].trim();
      const rec = (state.npcs || []).find(x => x.name === n);
      const real = rec && (rec.role || '');
      if (real && !claimed.includes(real) && !real.includes(claimed)) {
        issues.push(issue('P2', 'A03', 'S2', '人物身份断言与档案冲突',
          `正文说「${n}」是${claimed}，档案登记为「${real}」。`,
          { at: mm[0], fix: '以档案为准；若要改，先在人物表里改。', evidence: 'E2' }));
      }
    }
  }

  // 4) 无据断言：出现了「据传/据说/人人都知道」之类的托词
  const hearsay = scene.match(/(据说|据传|人人都知道|众所周知|谁都知道|坊间传闻)/g);
  if (hearsay) {
    issues.push(issue('P2', 'A04', 'S3', '存在托词式断言',
      `正文用了「${[...new Set(hearsay)].slice(0, 3).join('、')}」—— 这类说法没有出处，等于凭空。`,
      { at: '', fix: '写明是谁说的、在哪听来的，或删掉。', evidence: 'E0' }));
  }

  const table = { facts: facts.slice(0, 30), rows };
  return { issues, table };
}

function cn(s) {
  if (/^\d+$/.test(s)) return Number(s);
  const D = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let n = 0, cur = 0;
  for (const ch of String(s)) {
    if (ch === '十') { cur = (cur || 1) * 10; n += cur; cur = 0; }
    else if (ch === '百') { cur = (cur || 1) * 100; n += cur; cur = 0; }
    else if (D[ch] != null) cur = D[ch];
  }
  return n + cur;
}

/* ============================================================
   P3 时间线：排序、倒流、跳跃
   ============================================================ */
const TIME_WORDS = [
  ['凌晨', 1], ['天未亮', 1], ['拂晓', 2], ['清晨', 3], ['早晨', 3], ['上午', 4], ['午时', 6], ['正午', 6], ['午后', 7], ['未时', 7], ['傍晚', 9], ['黄昏', 9], ['入夜', 10], ['夜里', 11], ['夜半', 12], ['三更', 12], ['翌日', 20], ['次日', 20], ['第二天', 20],
];
const DAY_JUMP = /(次日|翌日|第二天|第三日|三日后|五日后|旬日后|半月后|一月后|数月后|一年后|一年之后|三年后)/g;

function p3Timeline(scene, state) {
  const issues = [];
  const rows = [];
  const clock = state.clock || {};
  const seen = [];
  let idx = 0;
  TIME_WORDS.forEach(([w, rank]) => {
    let p = scene.indexOf(w);
    while (p >= 0) { seen.push({ w, rank, p }); p = scene.indexOf(w, p + 1); }
  });
  seen.sort((a, b) => a.p - b.p);
  let prevRank = null;
  for (const s of seen) {
    rows.push({ i: ++idx, 时间词: s.w, 位置: s.p, 序: s.rank, 判定: prevRank != null && s.rank < prevRank ? '倒流' : '顺', 证据: 'E2' });
    if (prevRank != null && s.rank < prevRank) {
      issues.push(issue('P3', 'T01', 'S1', '时间倒流',
        `正文先写到「${seen[idx - 2] && seen[idx - 2].w}」，后面又写「${s.w}」—— 同一段里时间往回走了。`,
        { at: scene.slice(Math.max(0, s.p - 20), s.p + 20), fix: '按先后顺序重排，或明确这是追述。', evidence: 'E1' }));
    }
    prevRank = s.rank;
  }

  // 跳跃：正文内跨日
  const jumps = scene.match(DAY_JUMP);
  if (jumps) {
    const maxA = (clock.maxAdvancePerTurn != null ? clock.maxAdvancePerTurn : 5);
    issues.push(issue('P3', 'T02', 'S1', '正文内跨日推进',
      `正文出现「${[...new Set(jumps)].join('、')}」—— 时间只能由时钟推进，单轮上限 ${maxA} 天。`,
      { at: '', fix: '删掉跨日表述，本轮只写当日之事；要过几天请用「采纳时推进」的下拉框。', evidence: 'E2' }));
  }

  // 与时钟冲突：正文写了具体月日，与 clock 不一致
  const md = scene.match(/([一二三四五六七八九十\d]+)月([一二三四五六七八九十\d]+)日/g);
  if (md && clock.month) {
    for (const t of md.slice(0, 3)) {
      const mm = t.match(/([一二三四五六七八九十\d]+)月([一二三四五六七八九十\d]+)日/);
      const M = cn(mm[1]);
      if (M != null && Math.abs(M - clock.month) > 1) {
        issues.push(issue('P3', 'T03', 'S2', '日期与时钟不符',
          `正文写「${t}」，时钟是 ${clock.month}月${clock.day || ''}日。`,
          { at: t, fix: '按时钟写日期，或说明这是引述旧事。', evidence: 'E2' }));
      }
    }
  }

  // 时长与路程：一日内做不到的事
  const impossible = /(一日之内(?:抵|到|赶到)[^。！？]{0,10}(?:京|都|千里|三千里))|(立刻(?:抵|到)[^。！？]{0,8}京)/g.exec(scene);
  if (impossible) {
    issues.push(issue('P3', 'T04', 'S2', '路程与时长不符', `「${impossible[0]}」—— 这个距离在所给时间里走不到。`, { at: impossible[0], fix: '按里程折算日程，或改地点。', evidence: 'E1' }));
  }

  return { issues, table: { rows, clock: { 年号: clock.yearLabel, 月: clock.month, 日: clock.day } } };
}

/* ============================================================
   P4 在场表
   ============================================================ */
const ENTER_WORDS = ['来了', '入', '进', '到', '现身', '求见', '求见', '传', '召', '迎', '至', '赶来', '进来', '进来', '登门', '拜谒', '现身', '出现在'];
const EXIT_WORDS = ['退下', '告退', '辞出', '离去', '走了', '送走', '退出', '告辞', '离开', '离去', '退去'];

function p4Presence(scene, state) {
  const issues = [];
  const rows = [];
  const names = (state.npcs || []).map(n => n.name).filter(Boolean);
  const sents = splitSentences(scene);
  const dlg = extractDialogue(scene);

  for (const n of names) {
    const first = scene.indexOf(n);
    if (first < 0) continue;
    // 入场：名字前后 30 字内是否有入场词
    const near = scene.slice(Math.max(0, first - 30), first + 30);
    const entered = ENTER_WORDS.some(w => near.includes(w));
    const banished = EXIT_WORDS.some(w => scene.slice(0, first).includes(w) && scene.slice(0, first).lastIndexOf(n) >= 0);
    // 发言位置
    const speaksAt = [];
    dlg.forEach(d => { if ((d.speaker && d.speaker.includes(n)) || (!d.speaker && d.body && scene.indexOf(d.body) > first)) speaksAt.push(d.body.slice(0, 24)); });
    rows.push({
      人物: n, 首次出现: first, 有入场: entered ? '有' : '无',
      有发言: speaksAt.length ? '有' : '无', 发言: speaksAt.slice(0, 2),
      判定: banished ? '疑（退场后仍在）' : (entered ? '在场' : '疑（凭空出现）'),
    });
    if (!entered && speaksAt.length) {
      issues.push(issue('P4', 'P01', 'S2', '人物凭空出现并发言',
        `「${n}」在正文里开口，但此前没有他入场/被通报的描写。`,
        { at: n, fix: '先写他怎么进来（传报、掀帘、求见），再让他说话。', evidence: 'E1' }));
    }
    if (banished) {
      issues.push(issue('P4', 'P02', 'S1', '退场后仍在场',
        `「${n}」已经写过退场，后面却又出现。`,
        { at: n, fix: '补一句他为何折返，或删掉后面的出场。', evidence: 'E1' }));
    }
  }

  // 已故者出场（状态卡层）
  const dead = ((state.household && state.household.members) || []).filter(m => m.status === '已故').map(m => m.name);
  for (const d of dead) {
    if (scene.includes(d)) {
      issues.push(issue('P4', 'P03', 'S0', '已故人物出场', `「${d}」已标记为已故，本轮却又在正文里出现。`, { at: d, fix: '删掉，或改成追述/梦忆并写明。', evidence: 'E2' }));
    }
  }
  return { issues, table: { rows } };
}

/* ============================================================
   P5 四本账
   ============================================================ */
const LEDGERS = {
  人情: ['谢', '恩', '怨', '欠', '得罪', '结交', '许诺', '应承', '面子', '礼', '报答', '记恨', '感恩', '卖了个人情', '欠下'],
  利害: ['利', '害', '亏空', '亏', '赚', '得失', '危及', '牵连', '保住', '丢官', '升迁', '贬', '削', '夺', '赏', '罚'],
  信息: ['得知', '听说', '打听到', '探得', '告知', '密报', '发现', '查知', '听说', '风闻', '走漏', '透露', '禀明', '看出了'],
  物资: ['银', '钱', '贯', '石', '匹', '两', '粮', '米', '兵', '船', '马', '斛', '顷', '亩', '斤', '束', '车'],
};
const NUM_RE = /([一二三四五六七八九十百千万两\d]+)([银钱贯石匹两粮米兵船马斛顷亩斤束车])/g;

function p5Ledgers(scene, state) {
  const rows = [];
  const issues = [];
  for (const [k, words] of Object.entries(LEDGERS)) {
    const hits = [];
    for (const w of words) {
      if (k === '物资') continue;
      const re = new RegExp(w, 'g');
      const m = scene.match(re);
      if (m) hits.push(`${w}×${m.length}`);
    }
    if (k === '物资') {
      let m;
      const re = new RegExp(NUM_RE.source, 'g');
      while ((m = re.exec(scene))) hits.push(`${m[0]}`);
    }
    rows.push({ 账: k, 本轮变动: hits.length ? hits.slice(0, 8).join('、') : '（无）', 笔数: hits.length });
  }

  // 物资账与档案比对：正文说支出，档案里的资源若为 0 或不存在 → 提醒
  const res = state.resources || {};
  const spent = rows.find(r => r.账 === '物资').本轮变动;
  if (spent !== '（无）' && !Object.keys(res).length) {
    issues.push(issue('P5', 'L01', 'S3', '物资账无底账可核', '正文出现了钱粮数目，但档案里没有登记资源，无从核对是否与账目相符。', { at: spent.slice(0, 40), fix: '在档案页登记资源底账，或让 gm 先报个底数再改。', evidence: 'E0' }));
  }
  // 无代价的胜利
  const win = scene.match(/(顺利(?:办成|达成|解决)|毫无阻碍|一路顺风|皆大欢喜|尽如人意)/g);
  if (win) {
    issues.push(issue('P5', 'L02', 'S2', '没有代价的顺利', `正文写「${[...new Set(win)].join('、')}」—— 好事办成了却没付代价，四本账里没有一笔支出。`, { at: '', fix: '补一笔代价：欠了人情、得罪了谁、花了钱粮、留下了把柄。', evidence: 'E1' }));
  }
  return { issues, table: { rows } };
}

/* ============================================================
   P6 知识矩阵：谁知道什么
   ============================================================ */
const OMNI_RE = /(早已知道你会|料到你|料定你|未卜先知|仿佛知道|竟似知道|事先知道|早知如此|早已知晓|猜到了你会|知道你心里|晓得你心里)/g;
const KNOW_RE = /(得知|听说|探得|打听到|知晓|知道|晓得|明白|看出|听说)/g;

function p6Knowledge(scene, state) {
  const issues = [];
  const rows = [];
  let m;
  const omniRe = new RegExp(OMNI_RE.source, 'g');
  while ((m = omniRe.exec(scene))) {
    issues.push(issue('P6', 'K01', 'S0', '未卜先知 / 上帝视角',
      `正文写「${m[0]}」—— 没有人能预先知道玩家会怎么做。`,
      { at: scene.slice(Math.max(0, m.index - 15), m.index + 35), fix: '改成「他猜」「他防着一手」，并给出依据。', evidence: 'E0' }));
  }

  // 信息出处：每处「得知/听说」都要有来源
  const knowRe = new RegExp(KNOW_RE.source, 'g');
  const SRC = /(听|闻|见|报|告|禀|探|访|查|阅|信|札|揭|帖|人言|传|语|云)/;
  let cnt = 0;
  while ((m = knowRe.exec(scene))) {
    cnt++;
    const after = scene.slice(m.index, m.index + 40);
    const before = scene.slice(Math.max(0, m.index - 25), m.index);
    const hasSrc = SRC.test(before) || SRC.test(after.slice(0, 12));
    rows.push({ 片段: (before + m[0] + after.slice(0, 20)).slice(-50), 有出处: hasSrc ? '有' : '无', 证据: hasSrc ? 'E1' : 'E0' });
    if (!hasSrc && cnt <= 3) {
      issues.push(issue('P6', 'K02', 'S2', '信息没有出处',
        `「${m[0]}」—— 这个消息是谁说的、怎么传来的，正文没交代。`,
        { at: (before + m[0]).slice(-40), fix: '补上来源：谁说的、在哪听来的、是亲眼还是耳闻。', evidence: 'E0' }));
    }
  }

  // 旁人知道了玩家独自做的事（无目击者）
  const secret = /(你(?:独自|私下|暗中|悄悄)[^。！？]{0,20})/g;
  let sm;
  while ((sm = secret.exec(scene))) {
    const tail = scene.slice(sm.index, sm.index + 120);
    if (/(他(?:竟|却|已经|早已)?(?:知道|晓得|得知|清楚))/.test(tail)) {
      issues.push(issue('P6', 'K03', 'S1', '旁人知道了无目击者的事',
        `你「${sm[1].slice(0, 16)}」，旁人却知道了 —— 谁看见的？`,
        { at: tail.slice(0, 50), fix: '补一个目击者或泄密的环节，或删掉。', evidence: 'E0' }));
    }
  }
  return { issues, table: { rows: rows.slice(0, 20) } };
}

/* ============================================================
   P7 对话审计
   ============================================================ */
function p7Dialogue(scene, state) {
  const issues = [];
  const rows = [];
  const dlg = extractDialogue(scene);
  const npcMap = {};
  (state.npcs || []).forEach(n => { npcMap[n.name] = n; });
  const playerName = (state.protagonist && state.protagonist.name) || '';

  dlg.forEach((d, i) => {
    const who = d.speaker || '（未标明）';
    const rec = npcMap[who];
    const isPlayer = who === '你' || (playerName && who.includes(playerName));
    const modern = modernHitsIn(d.body);
    rows.push({
      i: i + 1, 说话人: who,
      身份: isPlayer ? '主角' : (rec ? (rec.role || rec.tie || '已登记') : '（档案中无此人）'),
      内容: d.body.slice(0, 40),
      语域: modern.length ? '存疑' : '通过',
      备注: modern.length ? modern.map(x => `「${x.modern}」→「${x.ancient}」`).join('；') : '',
    });
    if (modern.length) {
      issues.push(issue('P7', 'G01', 'S1', '台词里有现代说法',
        `${who} 说「${d.body.slice(0, 30)}」，其中：${modern.map(x => `「${x.modern}」应作「${x.ancient}」`).join('；')}。`,
        { at: d.body.slice(0, 50), fix: '换成当时人的说法。', evidence: 'E2' }));
    }
    if (!isPlayer && !rec && who !== '（未标明）' && who.length <= 6 && !/^(旁人|有人|众人|士兵|随从|侍者|家丁|差役|门子|小吏|军士|百姓)/.test(who)) {
      issues.push(issue('P7', 'G02', 'S3', '说话人不在人物表', `「${who}」在正文里说话，但人物表里没有他。`, { at: who, fix: '登记进人物表，或改成泛称（旁人/随从）。', evidence: 'E2' }));
    }
    if (who === '（未标明）') {
      issues.push(issue('P7', 'G03', 'S2', '对话没有标明说话人', `「${d.body.slice(0, 24)}」—— 不知道是谁说的。`, { at: d.body.slice(0, 40), fix: '补上「某某道：」。', evidence: 'E1' }));
    }
  });

  // 长篇独白：一句台词过长（>120 字）不符合说话节奏
  for (const d of dlg) {
    if (d.body.length > 120) {
      issues.push(issue('P7', 'G04', 'S2', '台词过长', `${d.speaker || '某人'}一口气说了 ${d.body.length} 字 —— 不像人说话。`, { at: d.body.slice(0, 40), fix: '拆成几句，中间插入对方的反应。', evidence: 'E1' }));
    }
  }
  return { issues, table: { rows } };
}

/* ============================================================
   P8 情节节拍
   ============================================================ */
function p8Beat(scene, state, draft, p5) {
  const issues = [];
  const newInfo = (p5.table.rows.find(r => r.账 === '信息') || {}).笔数 > 0;
  const turn = /(但|然而|谁知|不料|忽|忽然|却|偏偏|竟)/.test(scene);
  const cost = /(失|损|伤|亡|得罪|耗费|花了|赔|亏|折|丢|削|贬|罚|代价|付出)/.test(scene);
  const choice = /用户决定/.test(scene) || /用户决定/.test(String(draft && draft.pendingDecision || ''));
  const newFace = (draft && (draft.newNpcs || []).length) || 0;
  const rows = [
    { 节拍: '新信息', 有: newInfo ? '有' : '无' },
    { 节拍: '转折', 有: turn ? '有' : '无' },
    { 节拍: '代价', 有: cost ? '有' : '无' },
    { 节拍: '选择点', 有: choice ? '有' : '无' },
    { 节拍: '新人物', 有: newFace ? `有（${newFace}）` : '无' },
  ];
  const score = [newInfo, turn, cost, choice, newFace > 0].filter(Boolean).length;
  if (score <= 1) {
    issues.push(issue('P8', 'B01', 'S2', '本轮几乎没有推进',
      `五项节拍里只中了 ${score} 项 —— 这一轮读起来会像原地踏步。`,
      { at: '', fix: '至少补一样：一条新信息、一个转折、一笔代价，或把选择摆到玩家面前。', evidence: 'E1' }));
  }
  if (!choice) {
    issues.push(issue('P8', 'B02', 'S1', '没有把选择交还玩家', '本轮结尾没有「用户决定」。', { at: '', fix: '结尾停在需要他拍板的地方，并写「用户决定」。', evidence: 'E2' }));
  }
  return { issues, table: { rows, score } };
}

/* ============================================================
   P9 状态卡与追溯
   ============================================================ */
function p9StateCard(state, allIssues, prevHistory) {
  const issues = [];
  const p = state.protagonist || {};
  const c = state.clock || {};
  const card = {
    身份: p.role || '未登记',
    年龄: p.age != null ? `${p.age} 岁` : '未登记',
    时间: `${c.yearLabel || '?'} ${c.month || '?'}月${c.day || '?'}日`,
    所在地: (state.location && state.location.full) || '未登记',
    控制者: (state.location && state.location.controller) || '未登记',
    人物数: (state.npcs || []).length,
    线索数: (state.threads || []).length,
    未结线索: (state.threads || []).filter(t => !t.status || t.status === 'open').length,
    地盘数: ((state.territory && state.territory.items) || (state.territory || []).length) || 0,
  };
  // 复发（回归）：以前修过的错误码又出现
  const nowCodes = new Set(allIssues.map(i => i.code));
  const regressions = [];
  // 「已修」= 上一轮有、紧接着那一轮没有；也接受外部显式登记的 fixed
  const hist = prevHistory || [];
  const fixedBefore = new Set();
  for (let i = 0; i < hist.length - 1; i++) {
    const next = new Set(hist[i + 1].codes || []);
    for (const c2 of (hist[i].codes || [])) if (!next.has(c2)) fixedBefore.add(c2);
  }
  for (const h of hist) for (const f of (h.fixed || [])) fixedBefore.add(f);
  for (const c2 of fixedBefore) {
    if (nowCodes.has(c2)) regressions.push(c2);
  }
  const seenBefore = new Set((prevHistory || []).flatMap(h => h.codes || []));
  const repeat = [...nowCodes].filter(c2 => seenBefore.has(c2));
  if (regressions.length) {
    issues.push(issue('P9', 'R01', 'S1', '已修错误复发（回归）',
      `这些错误你曾经修过，本轮又出现了：${[...new Set(regressions)].join('、')}。`,
      { at: '', fix: '把它们加进纠正记录库，提示词里会重点提醒。', evidence: 'E2' }));
  } else if (repeat.length >= 3) {
    issues.push(issue('P9', 'R02', 'S2', '同类错误反复出现',
      `${repeat.length} 类错误在最近几轮反复出现：${repeat.slice(0, 6).join('、')}。`,
      { at: '', fix: '考虑在设置里收紧篇幅/语气，或在纠正记录里点名。', evidence: 'E2' }));
  }
  return { issues, table: { card, regressions, repeat } };
}

/* ============================================================
   总入口
   ============================================================ */
function runPasses({ state, draft, input, prevHistory }) {
  SEQ = 0;
  const scene = String((draft && draft.scene) || '');
  const st = Object.assign({}, state, { __input: String(input || '') });

  const p0 = p0Input(st, input);
  const p1 = p1Subject(scene, p0, st);
  const p2 = p2Assertions(scene, st);
  const p3 = p3Timeline(scene, st);
  const p4 = p4Presence(scene, st);
  const p5 = p5Ledgers(scene, st);
  const p6 = p6Knowledge(scene, st);
  const p7 = p7Dialogue(scene, st);
  const p8 = p8Beat(scene, st, draft, p5);

  const before = [...p0.issues, ...p1.issues, ...p2.issues, ...p3.issues, ...p4.issues, ...p5.issues, ...p6.issues, ...p7.issues, ...p8.issues];
  const p9 = p9StateCard(st, before, prevHistory);
  const all = [...before, ...p9.issues];

  const passes = PASS_META.map(([id, name, desc], i) => {
    const src = [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9][i];
    const rows = src.table || {};
    const iss = all.filter(x => x.pass === id);
    return {
      id, name, desc,
      issues: iss,
      table: rows,
      state: iss.some(x => x.sev === 'S0') ? '致命' : iss.some(x => x.sev === 'S1') ? '须改' : iss.length ? '存疑' : '通过',
      counts: {
        S0: iss.filter(x => x.sev === 'S0').length,
        S1: iss.filter(x => x.sev === 'S1').length,
        S2: iss.filter(x => x.sev === 'S2').length,
        S3: iss.filter(x => x.sev === 'S3').length,
      },
    };
  });

  const summary = { S0: 0, S1: 0, S2: 0, S3: 0 };
  for (const i of all) summary[i.sev]++;

  return {
    passes,
    issues: all,
    summary,
    blocking: all.some(i => i.sev === 'S0'),
    blockingIssues: all.filter(i => i.sev === 'S0').map(i => ({ code: i.code, title: i.title, detail: i.detail, fix: i.fix, at: i.at })),
    p0: { table: p0.table, fuzzy: p0.fuzzy, priority: p0.priority, authorization: p0.authorization },
    codes: [...new Set(all.map(i => i.code))],
  };
}

module.exports = { runPasses, PASS_META, SEVERITY, EVIDENCE, splitSentences, extractDialogue, p0Input, p1Subject };
