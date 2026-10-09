'use strict';
/**
 * 真实人物核验档案（协议 §12.1 / §3.2 / §2.4）。
 *
 * 为什么需要：引擎此前把历史人物当成「一个名字 + 一个身份模块」，
 * 于是梁武帝第八子萧纪被放到江陵——那其实是他七兄萧绎（湘东王、荆州刺史）的治所。
 * 萧纪自大同三年（537）起任益州刺史，镇成都，太清二年（548）已在蜀十一年。
 * 「人物在哪儿、任什么职、有多大权」必须是可查的确定性数据，不能靠身份猜。
 *
 * 数据录入原则：
 *   · 只收有明确史料支持的字段，查不到的一律留空，不补、不猜；
 *   · 官职带起止年份（协议 §2.4：某年任某职 ≠ 数年后仍任该职）；
 *   · 驻地、名义辖区、实际权限分别记录，不混为一谈（§3.4）；
 *   · 每条都标来源与可信度。
 */
const FIGURES = {
  萧纪: {
    name: '萧纪',
    aliases: ['蕭紀'],   // 存档里常见繁体写法，须能查到同一份档案
    courtesy: '世询',
    born: 508,
    died: 553,
    diedM: 7,   // 承圣二年七月兵败峡口被杀；553 年 8 月起不得再作为在世人物行动
    polity: '梁',
    gender: '男',
    father: '萧衍（梁武帝）',
    mother: '葛修容',
    siblingsNote: '梁武帝第八子；七兄萧绎（湘东王、荆州刺史，后为梁元帝）',
    // 爵位 / 官职：带起止年份，seat 为该职务的实际驻地
    posts: [
      { from: 514, to: 553, title: '武陵郡王', seat: '', kind: '爵', note: '天监十三年封，邑二千户', src: '《梁书·武陵王纪传》', conf: 'high' },
      { from: 537, to: 552, title: '使持节、都督益梁等十三州诸军事、安西将军、益州刺史', seat: '成都', kind: '职',
        note: '大同三年闰九月拜，加鼓吹一部；后加散骑常侍、征西大将军、开府仪同三司', src: '《梁书》《南史》《资治通鉴》', conf: 'high' },
    ],
    // 该年驻地（据 posts 推算；与 seatAt() 同源）
    // 太清二年：在成都，治蜀十一年
    traits: '自小勤学，有文才，不尚浮华；史称在蜀十七年，南开宁州、越巂，西通吐谷浑',
    resources: {
      note: '内修耕桑盐铁之政，外通商贾远方之利，故能殖其财用，器甲殷积，有马八千匹',
      src: '《资治通鉴》（司马光语）',
      conf: 'medium',
      // 只录史料原文所述，不折算成精确数字（协议 §8.1：无依据的精确数字不得伪造）
    },
    /* 逐年、逐月的真实处境：这是剧情核心矛盾的史实依据。
       **必须分月**：旧版把「侯景围台城、密敕加官」整条挂在 548 年，于是 548 年 10 月一开局
       就写「诏令已递到你手上」——可台城十月二十四日才被围，消息溯江到成都要一到两个月，
       密敕到蜀更在其后。开局因此被挤成一篇军国急报，既不合史实，也毫无日常。
       每段的 from 是该年的起始月；tension 是给剧情引擎用的「这一段真正要抉择的事」。 */
    situation: {
      548: [
        { from: 1,
          text: '镇蜀十一年，政务如常：劝课耕桑、经营盐铁、通商远方，南抚宁州、越巂；侯景降梁、涡阳兵败之事，于蜀中只是远方消息',
          tension: null,
          src: '《梁书·武陵王纪传》《资治通鉴》', conf: 'medium', basis: 'recorded' },
        { from: 9,
          text: '寿阳侯景以「清君侧」为名起兵的消息陆续传入蜀中；朝廷尚无诏命到来，刺史府政务照常，幕府中已有人议论京师安危',
          tension: { id: 'T-SIT-HJ-NEWS', name: '京师警讯', label: '侯景起兵的消息传入蜀中',
            parties: ['萧纪（益州刺史）', '幕府僚佐', '蜀中将校'],
            wants: { '萧纪（益州刺史）': '在消息未明之前不轻动，保住蜀中', '幕府僚佐': '早作打算，免得事急时无备', '蜀中将校': '若有战事，先要粮饷与名分' },
            whyNotResolved: '消息只是传闻，建康远在三千里外，朝廷无诏；此时整军东下既无名分也无急需',
            actions: ['遣使赴建康探问', '整饬兵甲以备不虞', '照常理事、静观其变', '与江陵萧绎通信'],
            ifUnresolved: '一旦京师有变，蜀中仓促应对' },
          src: '《资治通鉴·梁纪十四》（侯景起兵）；传入蜀中的时日系按行程推算', conf: 'medium', basis: 'inferred' },
        { from: 12,
          text: '台城被围的急报传至蜀中；各地宗王纷纷起兵入援，萧纪手握蜀中兵马资财，是否东下赴援成为不得不答的问题',
          tension: 'T-SIT-RELIEF',
          src: '《梁书·武陵王纪传》《资治通鉴》；急报到蜀的时日系按行程推算', conf: 'medium', basis: 'inferred' },
      ],
      549: [
        { from: 1,
          text: '侯景围台城，梁武帝密敕加萧纪侍中、假黄钺、都督征讨诸军事、太尉、承制；萧纪据蜀，不赴援',
          tension: 'T-SIT-RELIEF',
          src: '《梁书·武陵王纪传》《资治通鉴》', conf: 'high',
          note: '《梁书》评：「太清中，侯景乱，纪据有庸、蜀之资，不率军赴援朝廷之难。」密敕到蜀的月份系按行程推算' },
        { from: 5,
          text: '台城陷落、武帝被困的消息传入蜀中；萧纪仍据益州，按兵不动',
          tension: 'T-SIT-RELIEF',
          src: '《梁书》《南史》', conf: 'high' },
        { from: 7,
          text: '武帝饿殁台城、萧纲即位而受制于侯景的消息传来；诸王各自为谋，湘东王萧绎在江陵以「承制」自任',
          tension: 'T-SIT-SUCCESSION',
          src: '《梁书》《资治通鉴》', conf: 'medium' },
      ],
      550: [
        { from: 1,
          text: '萧绎在江陵号令诸方；萧纪遣世子萧圆照东下，被萧绎令屯白帝不得东进，兄弟间的名分之争渐显',
          tension: 'T-SIT-SUCCESSION',
          src: '《梁书·武陵王纪传》《资治通鉴》', conf: 'low', note: '萧圆照东下年月有 549/550 两说' },
      ],
      551: [
        { from: 1,
          text: '侯景西攻巴陵败还，旋废弑简文帝、篡位称汉；萧纪据蜀观望，蜀中僚属渐有劝进之议',
          tension: 'T-SIT-SUCCESSION',
          src: '《梁书》《资治通鉴》', conf: 'medium' },
      ],
      552: [
        { from: 1,
          text: '侯景败亡在即，建康帝位空悬；蜀中僚属劝进，萧纪议称帝',
          tension: 'T-SIT-SUCCESSION', src: '《梁书·武陵王纪传》', conf: 'medium' },
        { from: 4,
          text: '萧纪于成都称帝，改元天正，与江陵萧绎并立；是否东下争位成为头等大事',
          tension: 'T-SIT-EAST', src: '《梁书·武陵王纪传》《资治通鉴》', conf: 'medium' },
        { from: 8,
          text: '萧纪率大军东下争位，留萧撝守成都；谏阻者被诛',
          tension: 'T-SIT-EAST', src: '《梁书·武陵王纪传》《资治通鉴》', conf: 'medium' },
      ],
      553: [
        { from: 1,
          text: '萧纪大军顿于峡口一带，与萧绎所遣之军相持；萧绎已向西魏求援',
          tension: 'T-SIT-EAST', src: '《资治通鉴·梁纪二十》', conf: 'medium' },
        { from: 4,
          text: '西魏尉迟迥自散关入蜀，成都告急；前有萧绎之军，后有西魏之兵，军心动摇',
          tension: 'T-SIT-EAST', src: '《周书·尉迟迥传》《资治通鉴》', conf: 'medium' },
      ],
    },
    /* 本剧本的结构性矛盾（剧情引擎第一候选）。都来自上面的处境与史评，不是编的。 */
    tensions: {
      'T-SIT-RELIEF': {
        name: '赴援台城之议', label: '是否东下赴援台城',
        parties: ['萧纪（益州刺史）', '主张赴援的僚佐将校', '主张保境的蜀中僚佐'],
        wants: {
          '萧纪（益州刺史）': '既不担「坐视君父之难」的恶名，又不把蜀中家底耗在三千里外',
          '主张赴援的僚佐将校': '奉诏勤王，博取功名，免受天下指摘',
          '主张保境的蜀中僚佐': '守住蜀中钱粮兵马，不远涉三峡与侯景死战',
        },
        whyNotResolved: '蜀中有资财兵马（史载有马八千匹），但建康远在三千里外，溯江出峡、千里行军，赴援未必赶得上；不去则名分有亏',
        actions: ['整军东下赴援', '遣偏师或世子出峡以示勤王', '上表请命、按兵观望', '加固三峡防务、保境安民', '与江陵萧绎约期共进'],
        ifUnresolved: '台城若陷，「不赴援」将成为萧纪一生的定评；诸王之间的猜忌由此加深',
        src: '《梁书·武陵王纪传》：「纪据有庸、蜀之资，不率军赴援朝廷之难。」', conf: 'high', basis: 'fact',
      },
      'T-SIT-SUCCESSION': {
        name: '诸王名分之争', label: '武帝崩后谁主梁室',
        parties: ['萧纪（据蜀）', '萧绎（据江陵，承制）', '萧詧（据襄阳，附西魏）'],
        wants: {
          '萧纪（据蜀）': '以武帝之子、据蜀之资，不居萧绎之下',
          '萧绎（据江陵，承制）': '以「承制」之名统摄诸王，先灭侯景再定大位',
          '萧詧（据襄阳，附西魏）': '保住襄阳，借西魏之力报复萧绎',
        },
        whyNotResolved: '萧绎是第七子、先据上游且握平侯景之兵；萧纪是第八子、资财兵马更厚——谁先称尊谁就成了另一方的讨伐对象',
        actions: ['遣使江陵通好', '上表奉萧绎为盟主', '自立名号以待时', '遣兵出峡观衅', '结援于西魏或北齐'],
        ifUnresolved: '兄弟相疑终至兵戎相见',
        src: '《梁书·武陵王纪传》《梁书·元帝纪》《资治通鉴》', conf: 'medium', basis: 'recorded',
      },
      'T-SIT-EAST': {
        name: '东下争位', label: '是否东下与萧绎争位',
        parties: ['萧纪（天正帝）', '萧绎（江陵，承圣帝）', '西魏宇文泰', '蜀中留守与谏臣'],
        wants: {
          '萧纪（天正帝）': '东下平定上游，使天下只有一个梁帝',
          '萧绎（江陵，承圣帝）': '挡住萧纪于峡口，必要时借西魏之兵抄其后路',
          '西魏宇文泰': '趁梁室兄弟相攻，取蜀',
          '蜀中留守与谏臣': '先固根本，勿倾蜀中之兵远出',
        },
        whyNotResolved: '大军一出三峡，成都空虚；不出则两帝并立、名分终难定',
        actions: ['倾师东下', '留重兵守成都', '与萧绎议和划界', '回师救蜀', '诛杀谏阻者以定军心'],
        ifUnresolved: '前后受敌，蜀地有失',
        src: '《梁书·武陵王纪传》《周书·尉迟迥传》《资治通鉴》', conf: 'medium', basis: 'recorded',
      },
    },
    /* 长线时钟（《实现包》§3.4）：格数由代码按规则推进，满格必须发生。
       onIdleKeywords：玩家本轮没碰这些词就 +delta（拖着不管压力就涨）；onKeywords：碰了就 +delta。 */
    clocks: [
      { name: '幕府赴援之争', segments: 6,
        rules: [{ onIdleKeywords: ['援', '勤王', '出兵', '发兵', '东下', '京师', '台城', '侯景', '寿阳', '建康', '朝廷', '诏'], delta: 1 }, { onKeywords: ['赴援', '勤王', '出兵', '发兵'], delta: -2 }],
        omens: ['将校私下聚议', '有人在堂下打听东边的军报', '主战的僚佐上书措辞渐急'],
        onFull: '幕府中主战的将校联名请命出峡赴援，消息已传到江陵，萧纪被迫当众表态' },
      { name: '江陵的猜忌', segments: 6,
        rules: [{ onKeywords: ['募兵', '整军', '东下', '称帝', '即位', '扩军', '出峡'], delta: 1 }, { everyTurns: 8, delta: 1 }],
        omens: ['江陵来的商旅多问蜀中兵马', '湘东王的书信措辞渐冷'],
        onFull: '湘东王萧绎遣使到成都，名为问安，实为诘问蜀中兵马去向' },
    ],
    /* 对手卡（《设计书》§4.6）：处境与名分取自史料，「眼中的主角」「会犯的错」为依史载性格的推演 */
    opponents: [
      { name: '萧绎', born: 508, died: 554, diedM: 12,
        wants: '以「承制」之名统摄诸王，先灭侯景再定大位，绝不让蜀中坐大',
        cards: '据江陵上游，握王僧辩诸军，以承制名分号令四方',
        weakness: '猜忌兄弟，又怕背上「不救君父」的恶名',
        view: '八弟据蜀资厚兵多，迟迟不动，必有异志（推演）',
        next: '遣使与书信试探蜀中虚实，扼住出峡的道路',
        mistake: '多疑，宁信一封密报也不信当面之言（推演，依史载性格）' },
      { name: '侯景', born: 503, died: 552, diedM: 4,
        wants: '挟天子以令诸侯，据有江南',
        cards: '围台城之兵、朝中内应萧正德',
        weakness: '兵少、名不正，最怕诸王合力来援',
        view: '远在蜀中的武陵王未必肯来（推演）',
        next: '散布流言离间来援的诸王',
        mistake: '骄横，急于称尊' },
    ],
    /* 伏笔种子（《设计书》§3.4）：truth 是 GM 机密，surface 是玩家能看到的表象 */
    foreshadowSeeds: [
      { type: '政治约定', surface: '有传言说朝廷有一道诏书正在入蜀的路上', truth: '梁武帝确有密敕加萧纪侍中、假黄钺、都督征讨诸军事、承制（《梁书》），送到时京师已危；接诏即无不赴援的名分退路', earliestIn: 2, latestIn: 10 },
      { type: '人物秘密', surface: '侄儿萧撝近来格外留心府中丁口兵籍', truth: '萧撝想在叔父幕下谋一个实任，也在为自己留后路（推演，非史载）', earliestIn: 3, latestIn: 14 },
    ],
    /* 本剧本真实存在的派系框架（按时点生效，from = [年, 月]）。
       取代通用的「宗室诸王 对 外戚权臣」——梁末并无外戚专权，那是套模板。 */
    factions: [
      { from: [548, 1], title: '门阀士族 对 寒人近幸', sideA: '门阀士族', sideB: '寒人近幸（朱异等）',
        stake: '武帝晚年朱异等寒人用事，士族不平；侯景起兵即以「诛朱异」为名', src: '《梁书·朱异传》《梁书·侯景传》', conf: 'high' },
      { from: [548, 12], title: '赴援之议 对 保境之议', sideA: '主张出峡赴援的僚佐将校', sideB: '主张保境安蜀的僚佐',
        stake: '蜀中兵马钱粮是出峡勤王，还是固守根本', src: '《梁书·武陵王纪传》（不赴援）；幕府分议系推演', conf: 'medium' },
      { from: [549, 7], title: '江陵 对 成都', sideA: '湘东王萧绎（江陵）', sideB: '武陵王萧纪（成都）',
        stake: '武帝崩后，诸子谁主梁室；萧绎以承制号令诸方，萧纪不肯居其下', src: '《梁书·武陵王纪传》《梁书·元帝纪》', conf: 'high' },
    ],
    /* 身边的真实人物（同处成都、可打交道的人）与远方的关键人物。
       只收史书有名的；生卒、职掌查不到的留空，不补。 */
    circle: [
      { name: '萧圆照', relation: '世子（长子）', role: '武陵王世子', seat: '成都', born: null, died: 553,
        note: '史载曾受命率兵东下，受萧绎节度，屯白帝', src: '《梁书·武陵王纪传》', conf: 'medium' },
      { name: '萧圆正', relation: '子', role: '武陵王之子', seat: '成都', born: null, died: 553,
        src: '《梁书·武陵王纪传》', conf: 'low' },
      { name: '萧撝', relation: '从子（侄）', role: '宗室，随萧纪在蜀', seat: '成都', born: 515, died: 573,
        note: '后萧纪东下时留守成都，553 年降西魏', src: '《周书·萧撝传》', conf: 'medium' },
      { name: '刘孝胜', relation: '僚属', role: '萧纪幕府长史', seat: '成都', born: null, died: null,
        note: '后劝萧纪称帝', src: '《梁书·武陵王纪传》《资治通鉴》', conf: 'medium' },
      { name: '王僧略', relation: '僚属', role: '萧纪幕府司马', seat: '成都', born: null, died: 552,
        note: '后谏阻东下被杀', src: '《资治通鉴》', conf: 'medium' },
      { name: '徐怦', relation: '僚属', role: '萧纪幕府直兵参军', seat: '成都', born: null, died: 552,
        note: '后谏阻东下被杀', src: '《资治通鉴》', conf: 'medium' },
      { name: '杨乾运', relation: '部将', role: '萧纪部将', seat: '成都', born: null, died: null,
        note: '553 年西魏入蜀时降魏', src: '《周书》《资治通鉴》', conf: 'low' },
      // —— 远方的关键人物：只有名义统属或消息往来，开局与主角无直接交往 ——
      { name: '萧衍', relation: '父', role: '梁武帝', seat: '建康', born: 464, died: 549, diedM: 5, far: true,
        src: '《梁书·武帝纪》', conf: 'high' },
      { name: '萧纲', relation: '兄', role: '皇太子', seat: '建康', born: 503, died: 551, diedM: 10, far: true,
        src: '《梁书·简文帝纪》', conf: 'high' },
      { name: '萧绎', relation: '七兄', role: '湘东王、荆州刺史', seat: '江陵', born: 508, died: 554, diedM: 12, far: true,
        src: '《梁书·元帝纪》', conf: 'high' },
      { name: '萧詧', relation: '侄（昭明太子之子）', role: '岳阳王、雍州刺史', seat: '襄阳', born: 519, died: 562, far: true,
        src: '《周书·萧詧传》', conf: 'high' },
      { name: '侯景', relation: '叛臣', role: '河南王（东魏降将，据寿阳）', seat: '寿阳', born: 503, died: 552, diedM: 4, far: true,
        src: '《梁书·侯景传》', conf: 'high' },
      { name: '王僧辩', relation: '萧绎部将', role: '萧绎部将', seat: '江陵', born: null, died: 555, diedM: 9, far: true,
        src: '《梁书·王僧辩传》', conf: 'high' },
      { name: '宇文泰', relation: '外敌', role: '西魏权臣（丞相，总揽朝政）', seat: '长安', born: 507, died: 556, far: true,
        src: '《周书·文帝纪》', conf: 'high' },
    ],
    /* 逐年身份轨迹：**人物不是一张静态名片**。跑到不同年份，他的身份、驻地、
       生死、政治地位都不同——长线跑下去必须跟着变，否则就会出现
       「552 年他已称帝，系统还写着益州刺史」这种错误。 */
    timeline: [
      { y: 514, kind: 'rank', text: '天监十三年，封武陵郡王，邑二千户' },
      { y: 537, kind: 'post', text: '大同三年闰九月，拜益州刺史，镇成都', seat: '成都' },
      { y: 548, kind: 'event', text: '侯景围台城，受密敕都督征讨诸军事，不赴援' },
      { y: 550, m: 7, kind: 'event', text: '遣世子萧圆照率兵东下，受湘东王萧绎节度，屯白帝不得东（年月有 549/550 两说）' },
      { y: 552, m: 4, kind: 'post', text: '在成都即皇帝位，改元天正', seat: '成都', identity: 'emperor' },
      { y: 552, m: 8, kind: 'event', text: '率大军东下争位，留萧撝守成都' },
      { y: 553, m: 7, kind: 'death', text: '兵败峡口，为樊猛所杀，年四十六；萧绎除其宗籍，赐姓饕餮' },
    ],
    // 明确否定：旧开局里的错误设定（协议 §2.1 F 类「已被否定的错误说法」）
    denied: [
      { text: '萧纪在江陵', why: '江陵是荆州治所，太清二年属湘东王萧绎；萧纪时镇成都', src: '《梁书》《资治通鉴》' },
      { text: '萧纪有陇西的马场', why: '陇西在北魏/西魏境，非梁土；萧纪所有为蜀中马匹（史载「有马八千匹」）', src: '《资治通鉴》' },
    ],
  },
};

/* 别名索引：繁体/异写也能查到同一份档案 */
const ALIAS = {};
for (const [k, v] of Object.entries(FIGURES)) for (const a of (v.aliases || [])) ALIAS[a] = k;

/** 注册一份自动生成的档案（core/figureGen.js 校验通过后调用）。人工档案优先，不被覆盖。 */
function registerFigure(fig) {
  if (!fig || !fig.name) return false;
  if (FIGURES[fig.name] && !FIGURES[fig.name].generated) return false;
  FIGURES[fig.name] = fig;
  for (const a of (fig.aliases || [])) if (!FIGURES[a]) ALIAS[a] = fig.name;
  return true;
}
function resolveName(name) {
  const n = String(name || '').trim();
  return FIGURES[n] ? n : (ALIAS[n] || null);
}
const figOf = name => { const k = resolveName(name); return k ? FIGURES[k] : null; };

/** 该年的实际驻地；查不到返回 null（不猜） */
function seatAt(name, y) {
  const f = figOf(name);
  if (!f) return null;
  const hit = (f.posts || []).filter(p => p.seat && p.from <= y && y <= p.to)
    .sort((a, b) => (a.kind === '职' ? -1 : 1));
  return hit.length ? hit[0].seat : null;
}
/** 该年所任主要官职（名义职务） */
function postAt(name, y) {
  const f = figOf(name);
  if (!f) return null;
  const hit = (f.posts || []).filter(p => p.kind === '职' && p.from <= y && y <= p.to);
  return hit.length ? hit[hit.length - 1] : null;
}
/** 该年爵位 */
function rankAt(name, y) {
  const f = figOf(name);
  if (!f) return null;
  const hit = (f.posts || []).filter(p => p.kind === '爵' && p.from <= y && y <= p.to);
  return hit.length ? hit[hit.length - 1] : null;
}
/** 虚岁：中国古代用虚岁，年龄 = 公元年 − 生年 + 1 */
function ageAt(name, y) {
  const f = figOf(name);
  if (!f || f.born == null) return null;
  return y - f.born + 1;
}
/** 该年应有的称谓：已即位者称皇帝（带年号，若可考），否则取该年官职。
    为什么单列这一项：跑长线时「官职」会失效——萧纪 552 年在成都称帝后，
    再写「益州刺史」就是错的，哪怕他的刺史任期写到了 552 年。 */
function titleAt(name, y) {
  const f = figOf(name);
  if (!f) return null;
  const st = statusAt(name, y);
  if (st && st.identity === 'emperor') {
    const t = (f.timeline || []).find(x => x.kind === 'post' && x.identity === 'emperor');
    const era = t && /改元([^\s，,。]+)/.exec(t.text || '');
    return era ? `皇帝（改元${era[1]}）` : '皇帝';
  }
  const p = postAt(name, y);
  return p ? p.title : null;
}
/** 某人某年某月是否在世（有卒月的精确到月；没给月份时按年判断，卒年当年仍算在世） */
function isAliveAt(p, y, m) {
  if (!p) return true;
  if (p.born != null && y < p.born) return false;
  if (p.died == null) return true;
  if (y < p.died) return true;
  if (y > p.died) return false;
  if (m == null || p.diedM == null) return true;
  return m <= p.diedM;
}
/** 某人在 (y, m) 的真实处境：取该年 from ≤ m 的最后一段；没给月份取该年第一段。
    兼容旧格式（situation[y] 是单个对象）。 */
function situationAt(name, y, m) {
  const f = figOf(name);
  if (!f || !f.situation) return null;
  const s = f.situation[y];
  if (!s) return null;
  if (!Array.isArray(s)) return s;
  // 没给月份：与年表 hasHappened 同口径，按该年年末取（只知年份时，取「这一年过完时」的处境）
  const M = m == null ? 12 : Number(m);
  let hit = null;
  for (const seg of s) if ((seg.from || 1) <= M) hit = seg;
  return hit || null;
}
/** 处境所指的结构性矛盾（剧情引擎的第一候选）；没有则返回 null */
function tensionAt(name, y, m) {
  const f = figOf(name);
  const sit = situationAt(name, y, m);
  if (!f || !sit || !sit.tension) return null;
  const t = typeof sit.tension === 'string' ? (f.tensions || {})[sit.tension] : sit.tension;
  if (!t) return null;
  const id = typeof sit.tension === 'string' ? sit.tension : (t.id || 'T-SIT');
  return { ...t, id, situation: sit.text, source: 'figure.situation', confidence: t.conf || sit.conf || 'medium', basis: t.basis || sit.basis || 'recorded' };
}
/** 某人在 (y, m) 时已生效的派系框架；没有本地档案返回 null（调用方退回通用框架） */
function factionsAt(name, y, m) {
  const f = figOf(name);
  if (!f || !f.factions) return null;
  const now = y * 12 + (m || 1);
  return f.factions.filter(x => !x.from || (x.from[0] * 12 + (x.from[1] || 1)) <= now);
}
/** 某人在 (y, m) 身边与远方的真实人物：已死的、尚未出生的不列 */
function circleAt(name, y, m) {
  const f = figOf(name);
  if (!f || !f.circle) return [];
  return f.circle.filter(c => isAliveAt(c, y, m));
}
/** 完整核验档案（供开局底稿使用）。m 可选：给了月份，处境与生死按月判 */
function dossierAt(name, y, m) {
  const f = figOf(name);
  if (!f) return null;
  const st = statusAt(name, y, m);
  return {
    name: f.name, born: f.born, died: f.died, diedM: f.diedM || null, polity: f.polity, gender: f.gender,
    age: ageAt(name, y),
    seat: seatAt(name, y),
    post: postAt(name, y),
    rank: rankAt(name, y),
    traits: f.traits || '',
    resources: f.resources || null,
    situation: situationAt(name, y, m),
    tension: tensionAt(name, y, m),
    denied: f.denied || [],
    alive: st ? st.alive : true,
    identity: st ? st.identity : null,
    atThisYear: st ? st.notes : [],
    deathNote: st ? st.deathNote : '',
    source: 'offline', confidence: 'high',
  };
}
/** 该年该人的状态：在世与否、按轨迹推得的身份（如已称帝）、当年大事。m 可选，给了就按月判生死 */
function statusAt(name, y, m) {
  const f = figOf(name);
  if (!f) return null;
  const alive = isAliveAt(f, y, m);
  let identity = null, seat = '';
  const notes = [];
  for (const t of (f.timeline || [])) {
    if (t.y > y) continue;
    // 同年之内也分先后：552 年 1 月的萧纪还不是皇帝（四月才称帝）
    if (t.y === y && m != null && t.m != null && t.m > m) continue;
    if (t.kind === 'post' && t.identity) identity = t.identity;
    if (t.kind === 'post' && t.seat) seat = t.seat;
    if (t.y === y) notes.push(t.text);
  }
  return {
    alive, identity,
    seat: seat || seatAt(name, y) || '',
    notes,
    deathNote: (!alive && f.died != null) ? `${f.name}已于${f.died}年${f.diedM ? f.diedM + '月' : ''}去世` : '',
  };
}
/** 跨年推进：把一个人的状态从 oldY 带到 newY，返回变化清单（写进存档留痕） */
function advanceOne(name, oldY, newY) {
  const f = figOf(name);
  if (!f || newY === oldY) return [];
  const changes = [];
  const aliveOf = y => !(f.died != null && y > f.died);
  if (aliveOf(oldY) && !aliveOf(newY)) {
    const d = (f.timeline || []).find(t => t.kind === 'death' && t.y <= newY);
    changes.push({ name, kind: 'death', text: `${name}于${f.died}年去世${d ? '：' + d.text : ''}` });
  }
  const bp = postAt(name, oldY), ap = postAt(name, newY);
  if (bp && ap && bp.title !== ap.title) changes.push({ name, kind: 'post', text: `${name}：${bp.title} → ${ap.title}` });
  const bs = seatAt(name, oldY), as = seatAt(name, newY);
  if (bs !== as && as) changes.push({ name, kind: 'seat', text: `${name}治所：${bs || '?'} → ${as}` });
  for (const t of (f.timeline || [])) {
    if (t.y > oldY && t.y <= newY && t.kind !== 'death') changes.push({ name, kind: t.kind, text: `${t.y}年：${t.text}` });
  }
  return changes;
}
/** 身份自检：档案记载的身份与存档里填的身份是否冲突 */
function checkIdentity(name, y, currentIdentity, currentRole) {
  const f = figOf(name);
  if (!f) return null;
  const st = statusAt(name, y);
  const role = String(currentRole || '');
  const out = [];
  // 该年并未称帝，却写着皇帝
  if (st && st.identity !== 'emperor' && /皇帝|天子|即位|称帝/.test(role)) {
    out.push({
      field: 'identity', at: y,
      text: `档案记载${name}在${y}年尚未称帝（${f.timeline ? (f.timeline.find(t => t.kind === 'post' && t.identity === 'emperor') ? '至 ' + f.timeline.find(t => t.kind === 'post' && t.identity === 'emperor').y + ' 年方称帝' : '终身未称帝') : ''}），但身份写着「${role}」。`,
      suggest: postAt(name, y) ? postAt(name, y).title : '',
      source: 'figure-data', confidence: 'high',
    });
  }
  // 该年已称帝，却仍按宗室处理
  if (st && st.identity === 'emperor' && currentIdentity && currentIdentity !== 'emperor') {
    out.push({
      field: 'identity', at: y,
      text: `${name}在${y}年已即位称帝，身份模块仍是「${currentIdentity}」。`,
      suggest: 'emperor', source: 'figure-data', confidence: 'high',
    });
  }
  // 已过世却仍在场
  if (st && !st.alive) {
    out.push({ field: 'alive', at: y, text: st.deathNote, suggest: '', source: 'figure-data', confidence: 'high' });
  }
  return out.length ? out : null;
}
/** 某设定是否已被档案明确否定（返回被否定的条目） */
function checkDenied(name, text) {
  const f = figOf(name);
  if (!f || !f.denied) return null;
  const s = String(text || '');
  return f.denied.filter(d => s.includes(d.text)) || null;
}

/* —— 朝代年段：用于「时代错置」体检 ——
   用户原话：「身份设定的错误很多，而且很多内容都不对」。
   实测最典型的一例：南朝梁太清二年（548）的萧纪，被自动抽取成「元太守」——
   「元」是北魏（拓跋氏改姓）的姓，与梁朝宗室风马牛不相及。
   这类错误不需要联网就能查出来：把官职/身份里的朝代标记，与该政权实际存在的年段比对。 */
const DYNASTY_SPAN = {
  夏: [[-2070, -1600]], 商: [[-1600, -1046]], 周: [[-1046, -256]], 秦: [[-221, -206]],
  汉: [[-202, 220]], 魏: [[220, 266], [386, 534]], 晋: [[266, 420]],
  宋: [[420, 479], [960, 1279]], 齐: [[479, 502]], 梁: [[502, 557]], 陈: [[557, 589]],
  隋: [[581, 618]], 唐: [[618, 907]], 元: [[1271, 1368]], 明: [[1368, 1644]], 清: [[1636, 1912]],
  北魏: [[386, 534]], 东魏: [[534, 550]], 西魏: [[535, 557]], 北齐: [[550, 577]], 北周: [[557, 581]],
  南朝: [[420, 589]], 北朝: [[386, 581]], 五代: [[907, 960]],
};
/* 从一段文字里抽「朝代标记」：要求后面跟着朝代/时期/年号语境词，
   否则「元」「明」「清」这类单字会在「清明」「元年」里误命中。 */
const DYA = ['北魏', '东魏', '西魏', '北齐', '北周', '南朝', '北朝', '五代',
  '夏', '商', '周', '秦', '汉', '魏', '晋', '宋', '齐', '梁', '陈', '隋', '唐', '元', '明', '清'];
const DY_CTX = /(?:朝|代|时期|末年|初年|中叶|人|皇帝|太守|刺史|将军|尚书|丞相|王|帝)/;
function dynastyMarkers(text) {
  const s = String(text || '');
  const out = [];
  for (const d of DYA) {
    const re = new RegExp(d + '(?:朝|代|时期|末年|初年|中叶|人|皇帝|太守|刺史|将军|尚书|丞相|王|帝)', 'g');
    let m; while ((m = re.exec(s))) {
      const after = s.slice(m.index + m[0].length, m.index + m[0].length + 1);
      if (DY_CTX.test(m[0])) out.push({ dyn: d, raw: m[0], ok: true, after });
    }
  }
  return out;
}
/** 该朝代在 year 年是否存在（用于判断时代错置） */
function dynastySpans(dyn, year) {
  const sp = DYNASTY_SPAN[dyn];
  if (!sp) return null;
  return sp.some(([a, b]) => year >= a && year <= b) ? 'ok' : 'out';
}

/**
 * 单人身份体检：不联网，纯确定性校验。开局、跨年、每次读档都能跑。
 * 入参：{ name, year, polity, role, seat, born, died, identityModule }
 * 返回问题数组（空数组=没查出问题）。
 */
function auditFigure(p) {
  const out = [];
  if (!p || !p.name) return out;
  const name = String(p.name).trim();
  const year = Number(p.year) || 0;
  const role = String(p.role || '');

  // ① 生卒与当前年份矛盾
  const born = p.born != null ? Number(p.born) : null;
  const died = p.died != null ? Number(p.died) : null;
  if (born && year && year < born) {
    out.push({ field: 'born', level: 'S0', text: `${name}生于${born}年，${year}年尚未出生，不该出现在场上。`, suggest: '从名籍中剔除或改换年份', source: 'figure-data' });
  }
  if (died && year && year > died) {
    out.push({ field: 'died', level: 'S0', text: `${name}卒于${died}年，${year}年已在世外，不该再作为在世人物行动。`, suggest: '标记为已故，其势力按继承处理', source: 'figure-data' });
  }

  // ② 时代错置：官职/身份里的朝代与该年不符
  if (year) {
    for (const mk of dynastyMarkers(role)) {
      const r = dynastySpans(mk.dyn, year);
      if (r === 'out') {
        out.push({
          field: 'anachronism', level: 'S0',
          text: `「${role}」中的「${mk.raw}」与${year}年不符：${mk.dyn}的存在年段为${(DYNASTY_SPAN[mk.dyn] || []).map(([a, b]) => `${a}~${b}`).join(' 或 ')}。`,
          suggest: '改按本朝职官体系重新核定该人的职掌', source: 'figure-data',
        });
      }
    }
  }

  // ③ 本地档案的身份冲突（有档案才查，没有档案不硬套）
  const idc = checkIdentity(name, year, p.identityModule, role);
  if (idc) out.push(...idc.map(x => ({ ...x, level: 'S0' })));

  // ④ 已被明确否定的设定（如「萧纪在江陵」）
  const dn = checkDenied(name, `${role} ${p.seat || ''}`);
  if (dn && dn.length) {
    out.push(...dn.map(d => ({ field: 'denied', level: 'S0', text: d.why ? `${d.text}——${d.why}` : d.text, suggest: '', source: 'figure-data' })));
  }
  return out;
}

/** 全名籍体检：一次查完所有人（主角 + 历史 NPC），返回 { issues, byName } */
function auditAll(state) {
  const year = (state && state.clock && state.clock.gregorianYear) || 0;
  const polity = (state && state.location && state.location.polity) || '';
  const issues = [];
  const list = [];
  if (state && state.protagonist) list.push({ obj: state.protagonist, isProtagonist: true });
  for (const n of ((state && state.npcs) || [])) if (n && n.source === 'historical') list.push({ obj: n, isProtagonist: false });
  for (const { obj, isProtagonist } of list) {
    const r = auditFigure({
      name: obj.name, year, polity,
      role: obj.role || obj.office || '', seat: obj.seat || '',
      born: obj.born ?? obj.birthYear, died: obj.died,
      identityModule: isProtagonist ? (state.identityModule || '') : '',
    });
    for (const x of r) issues.push({ ...x, who: obj.name, isProtagonist });
  }
  const byName = {};
  for (const i of issues) (byName[i.who] = byName[i.who] || []).push(i);
  return { issues, byName, year, count: list.length };
}

module.exports = { FIGURES, registerFigure, dossierAt, seatAt, postAt, rankAt, ageAt, situationAt, tensionAt, circleAt, factionsAt, isAliveAt, checkDenied, statusAt, advanceOne, checkIdentity, titleAt, auditFigure, auditAll, dynastyMarkers, dynastySpans };
