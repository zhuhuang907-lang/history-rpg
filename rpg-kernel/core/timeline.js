'use strict';
/**
 * 历史时间轴：带时间约束的历史事件（协议 §2.4 / §4.3）。
 *
 * 为什么要这个文件：
 *   旧实现把「本朝大事」当成一个字符串数组（如「侯景围台城，梁武帝饿踣将殁」），
 *   不分先后地整包塞给任意年份。于是太清二年（548）开局时，系统把
 *   「梁武帝饿死」当成正在发生的事——那其实是太清三年（549）五月的事，早了一整年。
 *
 * 规则：
 *   ① 每个事件必须有起始时间（年、可考则带月/日），可考则带结束时间；
 *   ② 开局只取「当前时点之前已发生」的事件；
 *   ③ 当前时点之后的事，列为「尚未发生」，严禁写入正文当作既成事实；
 *   ④ 每条都标来源与可信度，查不到来源的宁可不写（协议 §2.5）。
 */
const EVENTS = [
  // —— 侯景之乱（南朝梁 太清年间）——
  { id: 'hj-1', polity: '梁', y: 547, m: 2, endY: 547,
    text: '侯景以河南十三州降梁，梁武帝纳之，授大将军、河南王、都督河南北诸军事',
    src: '《梁书·侯景传》《资治通鉴·梁纪》', conf: 'high' },
  { id: 'hj-2', polity: '梁', y: 548, m: 1, endY: 548,
    text: '东魏慕容绍宗大破侯景于涡阳，侯景率八百余残兵走保寿阳',
    src: '《资治通鉴·梁纪十四》', conf: 'high' },
  { id: 'hj-3', polity: '梁', y: 548, m: 8, d: 10, endY: 548,
    text: '侯景以「清君侧」（诛朱异等）为名，起兵于寿阳',
    src: '《梁书·侯景传》《资治通鉴》', conf: 'high', place: '寿阳' },
  { id: 'hj-4', polity: '梁', y: 548, m: 10, d: 20, endY: 548,
    text: '侯景自横江渡江，陷采石、姑孰，进逼建康',
    keys: ['侯景渡江', '陷采石', '进逼建康'],
    src: '《资治通鉴·梁纪十四》', conf: 'high', place: '建康' },
  { id: 'hj-5', polity: '梁', y: 548, m: 10, d: 24, endY: 549, endM: 3,
    text: '侯景军至朱雀桥，合围台城；羊侃督守，攻之不克，乃筑长围',
    keys: ['合围台城', '围台城', '台城被围', '台城之围', '朱雀桥'],
    src: '《梁书·侯景传》《资治通鉴》', conf: 'high', place: '台城' },
  { id: 'hj-6', polity: '梁', y: 548, m: 11, d: 1, endY: 549,
    text: '侯景立萧正德为帝，改元正平',
    keys: ['萧正德为帝', '萧正德称帝', '改元正平'],
    src: '《梁书》', conf: 'high', place: '建康' },
  { id: 'hj-7', polity: '梁', y: 548, m: 11, d: 12, endY: 548,
    text: '湘东王萧绎（荆州刺史）起兵于江陵，联络湘州萧誉、雍州萧詧等增援建康',
    src: '《资治通鉴·梁纪十四》', conf: 'high', place: '江陵' },
  // 旧表把「太子萧纲即位」并进三月台城陷落，错：萧纲即位在五月武帝崩后。已拆为 hj-8 / hj-9b。
  { id: 'hj-8', polity: '梁', y: 549, m: 3, d: 12, endY: 549,
    text: '台城陷落，侯景入宫，挟梁武帝以令内外；入援诸军相继解散',
    keys: ['台城陷落', '台城失守', '台城已陷', '侯景囚梁武帝', '武帝被囚'],
    src: '《梁书·武帝纪》《资治通鉴·梁纪十七》', conf: 'high', place: '台城' },
  { id: 'hj-9', polity: '梁', y: 549, m: 5, d: 2, endY: 549,
    text: '梁武帝萧衍饿殁于台城净居殿，享年八十六',
    keys: ['梁武帝饿死', '武帝饿死', '梁武帝饿殁', '武帝饿殁', '萧衍饿死', '萧衍崩', '武帝崩', '武帝驾崩'],
    src: '《梁书·武帝纪》《南史》', conf: 'high', place: '台城' },
  { id: 'hj-9b', polity: '梁', y: 549, m: 5, d: 27, endY: 551, endM: 8,
    text: '太子萧纲即位于建康，是为简文帝，政由侯景',
    keys: ['萧纲即位', '简文帝即位', '太子即位'],
    src: '《梁书·简文帝纪》《资治通鉴》', conf: 'high', place: '建康' },
  { id: 'hj-10', polity: '梁', y: 549, m: 6, endY: 549,
    text: '侯景杀萧正德',
    keys: ['萧正德被杀', '杀萧正德'],
    src: '《梁书·侯景传》', conf: 'medium', place: '建康' },
  { id: 'hj-11', polity: '梁', y: 549, m: 9, endY: 549,
    text: '萧詧自襄阳袭江陵以救其兄萧誉，不克而还，遣使附于西魏',
    keys: ['萧詧附魏', '萧詧降魏', '萧詧附西魏'],
    src: '《周书·萧詧传》《资治通鉴》', conf: 'medium', place: '江陵', note: '月份待核' },

  // —— 大宝元年（550）——
  { id: 'lm-550-1', polity: '梁', y: 550, m: 1, endY: 550,
    text: '简文帝改元大宝',
    src: '《梁书·简文帝纪》', conf: 'high', place: '建康' },
  { id: 'lm-550-2', polity: '梁', y: 550, m: 5, endY: 550,
    text: '王僧辩克长沙，河东王萧誉被杀，湘州归萧绎',
    keys: ['萧誉被杀', '长沙陷落', '克长沙'],
    src: '《梁书·王僧辩传》《资治通鉴》', conf: 'medium', place: '江陵', note: '月份待核' },
  { id: 'lm-550-3', polity: '梁', y: 550, m: 5, endY: 550, foreign: true,
    text: '东魏高洋受禅称帝，国号齐（北齐）',
    keys: ['北齐建国', '高洋称帝', '高洋受禅'],
    src: '《北齐书·文宣帝纪》', conf: 'high', place: '邺' },
  { id: 'lm-550-4', polity: '梁', y: 550, m: 6, endY: 550,
    text: '西魏册封萧詧为梁王，襄阳为西魏附庸',
    keys: ['萧詧为梁王', '册萧詧'],
    src: '《周书·萧詧传》', conf: 'medium', place: '襄阳', note: '月份待核' },
  { id: 'lm-550-5', polity: '梁', y: 550, m: 7, endY: 550, scope: '蜀',
    text: '萧纪遣世子萧圆照率兵东下，受湘东王萧绎节度；萧绎令其屯白帝，不得东进',
    keys: ['萧圆照东下', '圆照屯白帝'],
    src: '《梁书·武陵王纪传》《资治通鉴》', conf: 'low', place: '成都', note: '年月有 549/550 两说，待核' },
  { id: 'lm-550-6', polity: '梁', y: 550, m: 10, endY: 552, endM: 4,
    text: '侯景自加宇宙大将军、都督六合诸军事，简文帝形同傀儡',
    keys: ['宇宙大将军'],
    src: '《梁书·侯景传》', conf: 'medium', place: '建康', note: '月份待核' },

  // —— 大宝二年（551）——
  { id: 'lm-551-1', polity: '梁', y: 551, m: 4, endY: 551, endM: 6,
    text: '侯景溯江西攻，王僧辩坚守巴陵；景军大败，东还建康',
    keys: ['巴陵之战', '侯景败于巴陵', '巴陵大捷'],
    src: '《梁书·王僧辩传》《资治通鉴》', conf: 'high', place: '巴陵' },
  { id: 'lm-551-2', polity: '梁', y: 551, m: 8, endY: 551,
    text: '侯景废简文帝，立豫章王萧栋，改元天正',
    keys: ['废简文帝', '萧栋即位', '立萧栋'],
    src: '《梁书·侯景传》《资治通鉴》', conf: 'high', place: '建康' },
  { id: 'lm-551-3', polity: '梁', y: 551, m: 10, endY: 551,
    text: '侯景遣人弑简文帝萧纲',
    keys: ['简文帝遇弑', '简文帝被杀', '弑简文帝', '萧纲被杀'],
    src: '《梁书·简文帝纪》', conf: 'high', place: '建康' },
  { id: 'lm-551-4', polity: '梁', y: 551, m: 11, endY: 552, endM: 4,
    text: '侯景篡位，国号汉，改元太始',
    keys: ['侯景称帝', '侯景篡位', '国号汉'],
    src: '《梁书·侯景传》《资治通鉴》', conf: 'high', place: '建康' },

  // —— 承圣元年（552）；萧纪于蜀称天正元年 ——
  { id: 'lm-552-1', polity: '梁', y: 552, m: 3, endY: 552,
    text: '王僧辩、陈霸先联军克建康，侯景东走',
    keys: ['收复建康', '克建康', '建康光复'],
    src: '《梁书·王僧辩传》《陈书·高祖纪》', conf: 'high', place: '建康' },
  { id: 'lm-552-2', polity: '梁', y: 552, m: 4, endY: 552,
    text: '侯景逃亡途中为部下羊鹍所杀，侯景之乱平',
    keys: ['侯景被杀', '侯景伏诛', '侯景死', '侯景之乱平'],
    src: '《梁书·侯景传》', conf: 'high', place: '建康' },
  { id: 'lm-552-3', polity: '梁', y: 552, m: 4, endY: 553, endM: 7, scope: '蜀',
    text: '萧纪于成都即皇帝位，改元天正',
    keys: ['萧纪称帝', '萧纪即位', '萧纪即皇帝位', '改元天正'],
    src: '《梁书·武陵王纪传》《资治通鉴·梁纪二十》', conf: 'medium', place: '成都', note: '《通鉴》系于四月；另有八月说' },
  { id: 'lm-552-4', polity: '梁', y: 552, m: 8, endY: 553, endM: 7, scope: '蜀',
    text: '萧纪率大军东下争位，留萧撝守成都；谏阻东下者被诛',
    keys: ['萧纪东下', '萧纪出兵东下', '东下争位'],
    src: '《梁书·武陵王纪传》《资治通鉴》', conf: 'medium', place: '成都' },
  { id: 'lm-552-5', polity: '梁', y: 552, m: 11, endY: 554, endM: 11,
    text: '湘东王萧绎于江陵即皇帝位，是为梁元帝，改元承圣',
    keys: ['萧绎即位', '萧绎称帝', '元帝即位', '改元承圣'],
    src: '《梁书·元帝纪》', conf: 'high', place: '江陵' },

  // —— 承圣二年（553）：本剧本主角的终点 ——
  { id: 'lm-553-1', polity: '梁', y: 553, m: 3, endY: 553, endM: 8, scope: '蜀',
    text: '萧绎求援于西魏；宇文泰遣尉迟迥率军自散关伐蜀',
    keys: ['尉迟迥伐蜀', '西魏伐蜀', '尉迟迥入蜀'],
    src: '《周书·尉迟迥传》《资治通鉴》', conf: 'medium', place: '长安' },
  { id: 'lm-553-2', polity: '梁', y: 553, m: 5, endY: 553, endM: 8, scope: '蜀',
    text: '尉迟迥围成都，萧撝据城固守',
    keys: ['围成都', '成都被围'],
    src: '《周书·尉迟迥传》', conf: 'medium', place: '成都' },
  { id: 'lm-553-3', polity: '梁', y: 553, m: 7, endY: 553, scope: '蜀',
    text: '萧纪兵败峡口，为樊猛所杀，年四十六',
    keys: ['萧纪被杀', '萧纪败亡', '萧纪兵败', '萧纪身死', '萧纪之死', '樊猛杀萧纪'],
    src: '《梁书·武陵王纪传》《资治通鉴》', conf: 'medium', place: '峡口', note: '多记为七月' },
  { id: 'lm-553-4', polity: '梁', y: 553, m: 8, endY: 553, scope: '蜀',
    text: '萧撝以成都降西魏，蜀地入西魏',
    keys: ['成都降', '成都陷落', '蜀地入西魏', '西魏取蜀', '蜀入西魏'],
    src: '《周书·尉迟迥传》《周书·萧撝传》', conf: 'medium', place: '成都', note: '多记为八月' },

  // —— 承圣三年（554）以后：梁亡 ——
  { id: 'lm-554-1', polity: '梁', y: 554, m: 9, endY: 554, endM: 11,
    text: '西魏遣于谨、宇文护、杨忠率军攻江陵',
    keys: ['于谨伐江陵', '西魏攻江陵'],
    src: '《周书·于谨传》《资治通鉴》', conf: 'medium', place: '江陵' },
  { id: 'lm-554-2', polity: '梁', y: 554, m: 11, endY: 554,
    text: '江陵陷落，梁元帝萧绎被俘',
    keys: ['江陵陷落', '江陵失守', '萧绎被俘', '元帝被俘'],
    src: '《梁书·元帝纪》《周书》', conf: 'high', place: '江陵' },
  { id: 'lm-554-3', polity: '梁', y: 554, m: 12, endY: 554,
    text: '梁元帝萧绎被杀',
    keys: ['萧绎被杀', '元帝遇害', '元帝被杀'],
    src: '《梁书·元帝纪》', conf: 'high', place: '江陵' },
  { id: 'lm-555-1', polity: '梁', y: 555, m: 1, endY: 555,
    text: '萧詧于江陵即帝位，附庸西魏，史称后梁（西梁）',
    keys: ['后梁建立', '萧詧称帝', '西梁'],
    src: '《周书·萧詧传》', conf: 'medium', place: '江陵' },
  { id: 'lm-555-2', polity: '梁', y: 555, m: 5, endY: 555, endM: 9,
    text: '王僧辩迎北齐所送萧渊明入建康即位',
    keys: ['萧渊明即位', '迎萧渊明'],
    src: '《梁书·敬帝纪》《资治通鉴》', conf: 'medium', place: '建康' },
  { id: 'lm-555-3', polity: '梁', y: 555, m: 9, endY: 555,
    text: '陈霸先自京口袭杀王僧辩，废萧渊明',
    keys: ['王僧辩被杀', '袭杀王僧辩'],
    src: '《陈书·高祖纪》', conf: 'high', place: '建康' },
  { id: 'lm-555-4', polity: '梁', y: 555, m: 10, endY: 557, endM: 10,
    text: '萧方智即位，是为梁敬帝，改元绍泰',
    keys: ['敬帝即位', '萧方智即位', '改元绍泰'],
    src: '《梁书·敬帝纪》', conf: 'medium', place: '建康' },
  { id: 'lm-557-1', polity: '梁', y: 557, m: 10, endY: 557,
    text: '陈霸先受禅称帝，国号陈，梁亡',
    keys: ['陈霸先称帝', '梁亡', '陈代梁', '陈霸先受禅'],
    src: '《陈书·高祖纪》《梁书·敬帝纪》', conf: 'high', place: '建康' },
];

/* 时点→可比较的日序（按 30 日一月、360 日一年粗算，与 engine 的推进口径一致） */
function dayIndex(y, m, d) { return (Number(y) || 0) * 360 + ((Number(m) || 1) - 1) * 30 + ((Number(d) || 1) - 1); }

/* 事件是否已发生于给定时点（m 缺省按年内末月，d 缺省按月末日） */
function hasHappened(ev, y, m, d) {
  const M = m || 12, D = d || 30;
  if (ev.y > y) return false;
  if (ev.y < y) return true;
  if ((ev.m || 1) > M) return false;
  if ((ev.m || 1) < M) return true;
  return (ev.d || 1) <= D;
}
/* 事件是否已结束（结束了就不该再当作「正在发生」） */
function hasEnded(ev, y, m) {
  const M = m || 12;
  if (ev.endY == null) return false;
  if (ev.endY < y) return true;
  if (ev.endY > y) return false;
  return (ev.endM || 12) <= M;
}

/** 截至 (y,m,d) 已发生的事件（按时间正序） */
function eventsBefore(polity, y, m, d) {
  return EVENTS.filter(e => (!polity || e.polity === polity) && hasHappened(e, y, m, d))
    .sort((a, b) => (a.y - b.y) || ((a.m || 0) - (b.m || 0)) || ((a.d || 0) - (b.d || 0)));
}
/** 截至 (y,m,d) 尚未发生的事件——严禁把它们写成既成事实（协议 §17.1 第 5 条） */
function eventsAfter(polity, y, m, d) {
  return EVENTS.filter(e => (!polity || e.polity === polity) && !hasHappened(e, y, m, d))
    .sort((a, b) => (a.y - b.y) || ((a.m || 0) - (b.m || 0)));
}
/** 正在进行的事件（已开始且未结束） */
function eventsOngoing(polity, y, m, d) {
  return eventsBefore(polity, y, m, d).filter(e => !hasEnded(e, y, m));
}

/* —— 消息传播：事件自发生地传到某地所需的日程（协议 §4.2）——
   无精确史料时给「合理区间」并标记为估算，绝不假装精确。 */
const TRAVEL_DAYS = {
  // 建康 ↔ 上游诸州：溯江而上，急递（驿传/快船）
  '建康→江陵': { min: 10, max: 20, note: '溯江约一千七百里，快船顺风十余日；寻常舟行倍之' },
  '建康→成都': { min: 30, max: 60, note: '溯江逾三千里，须经江陵转递，急递亦须月余；寻常两月' },
  '寿阳→建康': { min: 3, max: 7, note: '陆路兼水路约五百里，急递三四日' },
  '寿阳→成都': { min: 35, max: 70, note: '须先至建康再溯江，或取陆路入蜀，月余乃至两月' },
  // 蜀中与上游诸州（梁末萧纪剧本用）
  '江陵→成都': { min: 20, max: 40, note: '溯江过三峡入蜀，峡路险阻，急递二十余日；寻常逾月' },
  '成都→江陵': { min: 12, max: 25, note: '顺江出峡，舟行甚速，急递旬余' },
  '巴陵→成都': { min: 25, max: 50, note: '先溯江至江陵，再过三峡入蜀' },
  '襄阳→成都': { min: 25, max: 50, note: '取汉水、陆路经汉中入蜀，或绕江陵溯江' },
  '长安→成都': { min: 20, max: 40, note: '越秦岭、走金牛道入蜀，山路艰险' },
  '峡口→成都': { min: 10, max: 20, note: '峡口在巴东，溯江西上至成都' },
  '白帝→成都': { min: 10, max: 20, note: '自鱼复溯江西上至成都' },
  '邺→成都': { min: 50, max: 90, note: '北朝消息须辗转经襄阳或建康入蜀，迟滞且多失真' },
  '建康→江陵': { min: 10, max: 20, note: '溯江约一千七百里' },
  // 五代（后梁 开平年间）：开封 ↔ 诸道
  '开封→潭州': { min: 12, max: 25, note: '自汴州南行经蔡、鄂入湘约一千五六百里，急递十余日；寻常逾旬' },
  '潭州→开封': { min: 12, max: 25, note: '北上顺江至鄂州转陆，千余里，旬余乃至' },
  '开封→洛阳': { min: 2, max: 4, note: '汴洛之间约四百里，驿路通畅' },
  '开封→扬州': { min: 6, max: 12, note: '顺汴水入淮，约八百里' },
  '开封→太原': { min: 7, max: 15, note: '渡河入河东，约九百里，多山' },
};
/* 同城/别称归一：台城即建康宫城，建邺、建业、金陵皆指建康；汴州、东京皆指开封；长沙即潭州 */
const PLACE_ALIAS = { 台城: '建康', 建邺: '建康', 建业: '建康', 金陵: '建康', 益州: '成都', 荆州: '江陵', 汴州: '开封', 东京: '开封', 汴梁: '开封', 长沙: '潭州', 武安: '潭州' };
const norm = p => PLACE_ALIAS[String(p || '').trim()] || String(p || '').trim();

/** 估算消息从 from 传到 to 所需天数；查不到就返回 null（不得凭空给数） */
function travelDays(from, to) {
  from = norm(from); to = norm(to);
  if (from === to) return { min: 0, max: 1, note: '同城，当日可达', from, to, source: 'estimate', confidence: 'low' };
  const k = `${from}→${to}`;
  if (TRAVEL_DAYS[k]) return { ...TRAVEL_DAYS[k], from, to, source: 'estimate', confidence: 'low' };
  return null;
}
/** 某事件在 given 时点是否已能传到某地（返回 {known, arriveAfterDays, note}） */
function newsReached(ev, to, y, m, d) {
  const tr = travelDays(ev.place || '', to);
  if (!tr) return { known: null, note: '缺乏该路线的行程依据，不作判定（宁可不判，不编）', source: 'unknown' };
  // 事件起始日 + 最快/最慢天数，与当前时点比较（与 engine 推进同口径：30 日一月）
  const gap = dayIndex(y, m, d) - dayIndex(ev.y, ev.m, ev.d);
  if (gap < tr.min) return { known: false, arriveInDays: tr.min - gap, note: tr.note, source: 'estimate', confidence: 'low' };
  if (gap > tr.max) return { known: true, note: tr.note, source: 'estimate', confidence: 'low' };
  return { known: 'possibly', note: tr.note + `（处于 ${tr.min}~${tr.max} 日的可能区间内）`, source: 'estimate', confidence: 'low' };
}

/* 无行程表的路线：不得假装精确。超过此天数才视为「必已传到」，否则一律按「未必知道」处理。 */
const UNKNOWN_ROUTE_DAYS = 90;

/**
 * 站在某地某时，把事件分成三类（剧情与正文都只能用前两类）：
 *   known   —— 已发生，且消息按最慢行程也已传到此地；
 *   rumored —— 已发生，消息处于可能传到的区间（只能写成传闻、未经证实）；
 *   unheard —— 已发生，但消息尚未传到（正文不得写主角知道）；
 * 另附 future —— 尚未发生（严禁写成既成事实）。
 */
function knownAt(polity, place, y, m, d) {
  // 与 hasHappened 同口径：没给月/日就按该年年末算（只知年份时，取「这一年已过完」）
  m = m || 12; d = d || 30;
  const out = { known: [], rumored: [], unheard: [], future: eventsAfter(polity, y, m, d) };
  for (const ev of eventsBefore(polity, y, m, d)) {
    if (!ev.place || norm(ev.place) === norm(place)) { out.known.push(ev); continue; }
    const r = newsReached(ev, place, y, m, d);
    if (r.known === true) out.known.push(ev);
    else if (r.known === 'possibly') out.rumored.push({ ...ev, reach: r });
    else if (r.known === false) out.unheard.push({ ...ev, reach: r });
    else {
      const gap = dayIndex(y, m, d) - dayIndex(ev.y, ev.m, ev.d);
      if (gap > UNKNOWN_ROUTE_DAYS) out.known.push(ev);
      else out.rumored.push({ ...ev, reach: { note: '缺乏该路线行程依据，按传闻处理' } });
    }
  }
  return out;
}

/** 按原文/关键词反查事件（线索、剧情只存了文字时，靠它判断「这件事发生了没有」） */
function findEventByText(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  return EVENTS.find(e => e.text === s)
    || EVENTS.find(e => s.length >= 8 && (e.text.startsWith(s.slice(0, 12)) || s.startsWith(e.text.slice(0, 12))))
    || null;
}

/** 注册自动生成的年表事件（core/figureGen.js 校验后调用）：同年同月、开头相同的视为同一事，不重复收 */
function registerEvents(list) {
  let n = 0;
  for (const e of (list || [])) {
    if (!e || !e.y || !e.text || !e.polity) continue;
    if (EVENTS.some(x => x.id === e.id)) continue;
    const head = String(e.text).slice(0, 6);
    if (EVENTS.some(x => x.polity === e.polity && x.y === e.y && (x.m || 0) === (e.m || 0) && (x.text.includes(head) || e.text.includes(x.text.slice(0, 6))))) continue;
    EVENTS.push({ ...e, generated: true });
    n++;
  }
  return n;
}

module.exports = { EVENTS, registerEvents, eventsBefore, eventsAfter, eventsOngoing, travelDays, newsReached, knownAt, findEventByText, dayIndex, hasHappened, hasEnded };
