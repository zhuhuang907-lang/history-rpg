'use strict';
/**
 * 全存档体检器：不靠猜，把每个存档的毛病逐条读出来。
 *
 * 用法：
 *   node save_doctor.js          只体检，不动任何文件
 *   node save_doctor.js --fix    体检并修复可安全修复的项（会先备份到 data/saves-quarantine/）
 *
 * 用户原话：「你其他存档也不行啊，这是一个全面的差劲啊，而且开头剧情很突兀」。
 * 之前一直是「发现一个修一个」，改完 907 马希声，553 萧纪又出问题。
 * 这个工具把已知的全部故障类型做成一张检查表，一次扫完所有档，
 * 以后每修一类 bug 就往表里加一条，避免「修完这个坏那个」。
 */
const fs = require('fs');
const path = require('path');
const SAVE_DIR = path.join(__dirname, 'data', 'saves');
const QUAR_DIR = path.join(__dirname, 'data', 'saves-quarantine');
const FIX = process.argv.includes('--fix');

const cap = require('./core/capability');
const init = require('./core/initializer');
const events = require('./core/events');

/** 这个档是不是真的玩过（有日志或已推进回合）。没玩过的档，按需生成的字段为空属正常。 */
const played = s => (Number(s.turn) || 0) > 0 || (s.log || []).length > 0;

/* ------------------------------ 检查项 ------------------------------ */

const CHECKS = [
  {
    id: 'capability',
    name: '行为能力（未成年/无职衔不得理政）',
    run(s) {
      const c = cap.capabilityOf(s);
      const out = [];
      if (c.isMinor && (c.hasOffice || c.isEmperor)) {
        out.push(`未成年（${c.age} 岁）却被赋予实职「${(s.protagonist.role || s.protagonist.office || '')}」，` +
                 `旧版会让他批阅公文、调度兵马。监护人应为 ${c.guardian ? c.guardian.name : '（未定）'}。`);
      }
      if (c.isMinor && !c.guardian) out.push('未成年却查不到监护人，开场无人可托。');
      return out;
    },
  },
  {
    id: 'place',
    name: '开局地点与史实治所',
    run(s) {
      const out = [];
      const c = cap.capabilityOf(s);
      const loc = String((s.location && s.location.full) || '');
      if (c.seat && !c.locationAttested) {
        const isDivergent = !!(s.divergence && JSON.stringify(s.divergence).includes('location'));
        out.push(`地点「${loc}」与${s.protagonist.name}该年治所「${c.seat.place}」不符` +
                 (c.seat.src ? `（据${c.seat.src}）` : '') + (isDivergent ? '——已声明为架空，仅提示' : '。'));
      }
      return out;
    },
  },
  {
    id: 'time',
    name: '年号与公元年',
    run(s) {
      const out = [];
      const c = s.clock || {};
      if (c.yearLabel && c.gregorianYear) {
        try {
          const r = init.checkTime(s, false);
          for (const x of (r || [])) {
            if (x.status && /冲突|矛盾/.test(String(x.status))) out.push(`${x.name}：${x.detail || x.依据 || ''}`);
          }
        } catch { /* 检查器不可用则跳过 */ }
      }
      if (!c.yearLabel) out.push('缺年号（yearLabel 为空）。');
      if (!c.gregorianYear) out.push('缺公元年（gregorianYear 为空）。');
      return out;
    },
  },
  {
    id: 'dead',
    name: '主角已故却仍在场',
    run(s) {
      const out = [];
      const p = s.protagonist || {};
      const y = Number(s.clock && s.clock.gregorianYear) || 0;
      const died = p.died ?? (s.figureDossier && s.figureDossier.died) ?? null;
      if (died != null && y && Number(y) > Number(died) && !s.protagonistDead) {
        // protagonistDead 已置位说明引擎已接手（改由继承人/旧部叙事），不算故障
        out.push(`${p.name}卒于 ${died} 年，存档却在 ${y} 年继续用他，且未标记 protagonistDead——` +
                 `叙事会让他这个死人继续出场。`);
      }
      return out;
    },
  },
  {
    id: 'season',
    name: '季节与月份一致',
    run(s) {
      const out = [];
      const c = s.clock || {};
      const m = Number(c.month) || 0;
      if (!m || !c.season) return out;
      const want = events.SEASON_TABLE[(m - 1) % 12];
      if (c.season !== want) {
        out.push(`clock 写 ${m} 月为「${c.season}」，按统一季节表应为「${want}」——` +
                 `两份季节表并存过，旧档留下了矛盾值（会导到冬天闹蝗灾）。`);
      }
      return out;
    },
  },
  {
    id: 'opening-shock',
    name: '开局被天灾砸脸',
    run(s) {
      const out = [];
      const hasGm = (s.log || []).some(l => l.speaker === 'GM');
      const evs = s.eventLog || [];
      if (!hasGm && evs.length) {
        out.push(`还没有任何 GM 发言（未真正开局），eventLog 里却已塞了 ${evs.length} 条事件：` +
                 evs.slice(0, 3).map(e => `「${e.text}」`).join('、') + '。玩家一睁眼先吃灾。');
      }
      if (!hasGm && s.currentEvent) {
        out.push(`未开局即带 currentEvent：「${s.currentEvent.text}」（${s.currentEvent.season || '?'}季）。`);
      }
      // 同文重复
      const seen = new Map();
      for (const e of evs) seen.set(e.text, (seen.get(e.text) || 0) + 1);
      for (const [t, n] of seen) if (n > 1) out.push(`同一句事件重复 ${n} 次：「${t.slice(0, 24)}…」`);
      // 季节与事件族相悖
      const season = (s.clock && s.clock.season) || '';
      if (season === '冬') {
        const bad = evs.filter(e => ['locust', 'flood', 'drought', 'hail', 'plague'].includes(e.family));
        if (bad.length) out.push(`冬季出现了不该发生的事件族：${bad.map(e => e.familyName).join('、')}。`);
      }
      return out;
    },
  },
  {
    id: 'dup-year',
    name: '时间字段叠字（太清二年年）',
    run(s) {
      const out = [];
      const arcs = (s.plot && s.plot.arcs) || [];
      for (const a of arcs) {
        const t = a.layers && a.layers.L1背景 && a.layers.L1背景.时间;
        if (typeof t === 'string' && /年年/.test(t)) out.push(`剧情 ${a.id} 背景时间写成「${t}」。`);
      }
      return out;
    },
  },
  {
    id: 'archive',
    name: '档案馆',
    run(s) {
      const out = [];
      // 档案馆是按需建的：从未真正玩过（无日志、回合 0）的档为空属正常，不算故障
      if (!played(s)) return out;
      const ar = s.archive;
      if (!ar || !Object.keys(ar).length) {
        out.push('已开局却无档案馆——旧版每个回合各算一份、互不联通，删档也不跟着删。');
      }
      return out;
    },
  },
  {
    id: 'place-string',
    name: '地点写法',
    run(s) {
      const out = [];
      const full = String((s.location && s.location.full) || '');
      if (!full) return out;
      const segs = full.split(/[\s·、,，]+/).filter(Boolean);
      // 「两浙路 常州 晋陵县 常州州衙」里常州出现两次
      const dup = segs.filter((x, i) => segs.findIndex(y => y.replace(/(州衙|县衙|府衙|治所)$/, '') === x.replace(/(州衙|县衙|府衙|治所)$/, '')) !== i);
      if (dup.length) out.push(`地点串重复：「${full}」（重复段：${dup.join('、')}）`);
      // 事件正文把整个地址串塞了进去
      for (const e of (s.eventLog || [])) {
        if (segs.length > 1 && String(e.text || '').includes(full)) {
          out.push(`事件正文塞进了完整地址串：「${String(e.text).slice(0, 40)}…」，应只写「${events.shortPlace(full)}」。`);
        }
      }
      return out;
    },
  },
  {
    id: 'plot',
    name: '剧情线',
    run(s) {
      const out = [];
      const p = s.plot || {};
      const arcs = p.arcs || [];
      // 同上：剧情线也是按需生成，没玩过的不算故障
      if (!arcs.length) {
        if (played(s)) out.push('已开局却没有任何剧情线。');
        return out;
      }
      const titles = new Map();
      for (const a of arcs) titles.set(a.title, (titles.get(a.title) || 0) + 1);
      for (const [t, n] of titles) if (n > 1) out.push(`剧情标题重复 ${n} 次：「${t}」。`);
      const future = (s.eraEventsPending || []).length;
      for (const a of arcs) {
        const g = JSON.stringify(a.layers || {});
        for (const f of (s.eraEventsPending || [])) {
          if (f.text && g.includes(String(f.text).slice(0, 12))) {
            out.push(`剧情 ${a.id} 把尚未发生的事（${f.y}年 ${String(f.text).slice(0, 20)}）当成了既成事实。`);
          }
        }
      }
      if (future) out.push(`（本档有 ${future} 条未来事件留作后台，不得写进正文）`);
      return out;
    },
  },
  {
    id: 'opening-leak',
    name: '开场泄漏导演指令',
    run(s) {
      const out = [];
      const o = String(s.opening || '');
      if (!o) return out;
      if (/开场须|不得开篇|严禁一上来|远方大事只能经由|GM 须知|提示词|你不是在写剧情/.test(o)) {
        out.push('开场文本里混入了导演指令（「' + (o.match(/开场须[^。；]+/)?.[0] || '不得开篇…') + '」），玩家界面会直接看到提示词。');
      }
      return out;
    },
  },
  {
    id: 'economy',
    name: '经济数据有无史料依据',
    run(s) {
      const out = [];
      const e = s.economy;
      // 经济账本是开局时按需生成的；没玩过的档（turn 0、无日志）根本还没有账本，
      // 那些会按现行算法在建档时正确生成（已带 estimate 标注），不算故障。
      if (!e) { if (played(s)) out.push('已开局却未登记经济账本。'); return out; }
      const ov = e.historicalOverrides;
      const src = JSON.stringify(e);
      if (!ov || !ov.length) {
        out.push('经济数字全部来自公式估算，无史料数字覆盖（米价等若为写死的常数需重点核）。');
      }
      const g = e.market && e.market.grainWenPerShi;
      const gs = e.market && e.market.grainSource;
      if (g === 300 && gs !== 'estimate') out.push('米价为写死常数 300 文/石，未标注来源——这是可搜到的数字，应据史核定。');
      if (!gs) out.push('米价未标注来源（grainSource 缺失）——应标为 estimate 并在启用检索后据史核定。');
      if (!/来源|src|依据|source|estimate|推算|估算/.test(src)) out.push('经济账本未标注任何来源或「估算」字样。');
      return out;
    },
  },
];

/* ------------------------------ 修复 ------------------------------ */
function fixSave(id, s, issues) {
  const changed = [];
  // 1) 未开局却塞了事件：清空（玩家还没落笔，不该有天灾）
  const hasGm = (s.log || []).some(l => l.speaker === 'GM');
  if (!hasGm) {
    if ((s.eventLog || []).length) {
      const n = s.eventLog.length;
      s.eventLog = [];
      changed.push(`清空未开局就塞进来的 ${n} 条事件`);
    }
    if (s.currentEvent) {
      changed.push(`清掉未开局的 currentEvent「${s.currentEvent.text}」`);
      s.currentEvent = null;
    }
  }
  // 2) 同文重复事件只留一条
  if ((s.eventLog || []).length) {
    const seen = new Set(), keep = [];
    for (const e of s.eventLog) {
      const k = `${e.family}|${e.text}`;
      if (seen.has(k)) continue;
      seen.add(k); keep.push(e);
    }
    if (keep.length !== s.eventLog.length) {
      changed.push(`事件去重 ${s.eventLog.length} → ${keep.length}`);
      s.eventLog = keep;
    }
  }
  // 3) 时间叠字
  for (const a of ((s.plot && s.plot.arcs) || [])) {
    const L = a.layers && a.layers.L1背景;
    if (L && typeof L.时间 === 'string' && /年年/.test(L.时间)) {
      const before = L.时间;
      L.时间 = L.时间.replace(/年年+/g, '年');
      changed.push(`背景时间叠字修正：「${before}」→「${L.时间}」`);
    }
  }
  // 4) 季节与月份矛盾：按统一表改正
  const m = Number(s.clock && s.clock.month) || 0;
  if (m && s.clock.season) {
    const want = events.SEASON_TABLE[(m - 1) % 12];
    if (s.clock.season !== want) {
      changed.push(`季节按统一表修正：${m}月 ${s.clock.season} → ${want}`);
      s.clock.season = want;
    }
  }
  // 5) 开场泄漏导演指令：用现行的 historyOpening 重算（只重生成开场，不动别的）
  if (/开场须|不得开篇|严禁一上来|远方大事只能经由|GM 须知|提示词|你不是在写剧情/.test(String(s.opening || ''))) {
    try {
      const wg = require('./core/worldgen');
      const threads = (s.threads && s.threads.slice()) || [];
      const fresh = wg.historyOpening(s, () => 0.5, threads);
      if (fresh && fresh !== s.opening) {
        changed.push('开场重算（去掉泄漏的导演指令）');
        s.opening = fresh;
      }
    } catch (e) { changed.push('开场重算失败：' + e.message); }
  }
  // 6) 米价来源标注：没有就补上「estimate」，不再以裸常数冒充
  if (played(s) && s.economy && s.economy.market) {
    const m = s.economy.market;
    if (!m.grainSource) {
      m.grainSource = 'estimate';
      m.grainNote = '米价为引擎按朝代量级推算的中值，非史实定值；启用检索后可据史核定覆盖。';
      changed.push('补米价来源标注为 estimate');
    }
    if (m.grainBaseline == null) {
      const eb = require('./core/economy').grainBaselineByEra(s.clock && s.clock.gregorianYear);
      m.grainBaseline = eb.value;
      changed.push(`补米价朝代基准 ${eb.value}（${eb.label}量级）`);
    }
  }
  // 7) 冬季事件族相悖的条目剔除
  const season = (s.clock && s.clock.season) || '';
  if (season === '冬' && (s.eventLog || []).length) {
    const before = s.eventLog.length;
    s.eventLog = s.eventLog.filter(e => !['locust', 'flood', 'drought', 'hail', 'plague'].includes(e.family));
    if (s.eventLog.length !== before) changed.push(`剔除 ${before - s.eventLog.length} 条与冬季相悖的事件`);
  }
  return changed;
}

/* ------------------------------ 主流程 ------------------------------ */
function main() {
  const files = fs.readdirSync(SAVE_DIR).filter(f => f.endsWith('.json'));
  const report = [];
  let totalIssues = 0;

  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(SAVE_DIR, f), 'utf8')); }
    catch { console.log(`\n### ${f}\n  ！无法解析，损坏存档`); totalIssues++; continue; }

    const id = (s.meta && s.meta.id) || f.replace(/\.json$/, '');
    const p = s.protagonist || {};
    const c = s.clock || {};
    console.log(`\n### ${id}`);
    console.log(`    ${p.name || '?'}　${c.yearLabel || '?'}${c.gregorianYear ? '（' + c.gregorianYear + '年）' : ''}　` +
                `${(s.location && s.location.full) || '?'}　回合 ${s.turn}　日志 ${(s.log || []).length} 条`);

    const issues = [];
    for (const chk of CHECKS) {
      let found = [];
      try { found = chk.run(s) || []; }
      catch (e) { found = [`检查器 ${chk.id} 自身报错：${e.message}`]; }
      for (const m of found) issues.push({ chk: chk.name, msg: m });
    }

    if (!issues.length) { console.log('    ✓ 未发现已知故障'); continue; }
    for (const i of issues) console.log(`    ✗ [${i.chk}] ${i.msg}`);
    totalIssues += issues.length;

    if (FIX) {
      const changed = fixSave(id, s, issues);
      if (changed.length) {
        fs.mkdirSync(QUAR_DIR, { recursive: true });
        fs.copyFileSync(path.join(SAVE_DIR, f), path.join(QUAR_DIR, `${id}.before-doctor-${Date.now()}.json`));
        s.meta = s.meta || {}; s.meta.updatedAt = new Date().toISOString();
        fs.writeFileSync(path.join(SAVE_DIR, f), JSON.stringify(s, null, 2), 'utf8');
        console.log('    → 已修复：' + changed.join('；'));
      } else {
        console.log('    → 本档故障需人工判断，未自动改');
      }
    }
    report.push({ id, n: issues.length });
  }

  console.log('\n========================================');
  console.log(`共 ${files.length} 个存档，发现 ${totalIssues} 处已知故障。`);
  if (!FIX) console.log('（只体检未改档。加 --fix 会自动修复可安全修复的项，并先备份）');
  console.log('========================================');
}

main();
