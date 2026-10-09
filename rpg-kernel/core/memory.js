'use strict';
/**
 * 记忆分层与检索（《设计书》§8.6、§8.7）。
 *   热：上一轮正文原文（引擎原有的「最近三轮叙事」已给）；
 *   温：每回合 ≤150 字摘要（模型在 turnSummary 里交，没交就由代码截正文）；
 *   冷：每十回合由模型合并成一段小结——**代码校验**小结里的人名、数字、地名必须在原摘要/名册里出现过，
 *       出现了没来源的视为编造，退回到代码拼接版；
 *   硬事实：年龄、账目、关系值、伏笔、线索……一律在各自的台账里，不进摘要。
 * 检索：玩家提到旧事（上次、前日、那封、那个……或点名某人）时，按关键词在摘要与回合原文里找最相关的三条注入。
 */

function ensureMemory(state) {
  if (!state.memory) state.memory = { turns: [], blocks: [] };
  state.memory.turns = state.memory.turns || [];
  state.memory.blocks = state.memory.blocks || [];
  return state.memory;
}

/* 采纳时：记一条回合摘要 */
function onAccept(state, draft, input) {
  const M = ensureMemory(state);
  let s = String((draft && draft.turnSummary) || '').trim();
  if (!s) s = String((draft && draft.scene) || '').replace(/\s+/g, '').slice(0, 150);
  M.turns.push({ turn: state.turn || 0, input: String(input || '').slice(0, 60), summary: s.slice(0, 160),
    date: state.clock ? `${state.clock.yearLabel}${state.clock.month}月${state.clock.day}日` : '' });
  if (M.turns.length > 400) M.turns = M.turns.slice(-400);
}

/* 未压缩的回合满十条，就该压了 */
function pendingCompression(state) {
  const M = ensureMemory(state);
  const done = M.blocks.length ? M.blocks[M.blocks.length - 1].to : -1;
  const rest = M.turns.filter(t => t.turn > done);
  return rest.length >= 10 ? rest.slice(0, 10) : null;
}

/* 小结校验：出现的人名（名册）、数字、地名必须在原摘要里出现过 */
function validateBlock(text, sources, state) {
  const src = sources.map(t => t.summary + t.input).join(' ');
  const bad = [];
  for (const m of String(text).match(/[\d一二三四五六七八九十百千万]{2,}(?:石|贯|人|匹|里|户|两|斛)/g) || []) if (!src.includes(m)) bad.push(m);
  const roster = [...(state.npcs || []).map(n => n.name), (state.protagonist || {}).name].filter(Boolean);
  // 名册外的人名不好判；只查「名册里有、但这十轮摘要里从没出现过」的人被写进小结（张冠李戴）
  for (const n of roster) if (String(text).includes(n) && !src.includes(n)) bad.push(n);
  return bad;
}

/* 在 runTurn 里调用（那里有模型适配器）：压缩一段；模型失败或校验不过就用代码拼接版 */
async function compressIfDue(state, adapter, config) {
  const batch = pendingCompression(state);
  if (!batch) return null;
  const M = ensureMemory(state);
  const fallback = batch.map(t => `第${t.turn}轮：${t.summary.slice(0, 40)}`).join('；').slice(0, 420);
  let text = '', bad = [];
  if (adapter) {
    try {
      const r = await adapter.call({
        system: '你是史官式的记录员。只合并下面的回合摘要，不新增任何人名、地名、数字，不评价，不修辞。',
        prompt: `把下面十个回合摘要合并成一段不超过 400 字的小结，只写事实：谁做了什么、谁表了什么态、什么变了。\n\n${batch.map(t => `第${t.turn}轮（${t.date}）玩家：${t.input}｜${t.summary}`).join('\n')}`,
        temperature: 0.2, maxTokens: 800,
      }, config || {});
      text = String((r && r.text) || '').trim().slice(0, 450);
      bad = validateBlock(text, batch, state);
    } catch (_) { text = ''; }
  }
  const ok = text && !bad.length;
  M.blocks.push({ from: batch[0].turn, to: batch[batch.length - 1].turn, text: ok ? text : fallback, by: ok ? 'model' : 'code', rejected: bad });
  return M.blocks[M.blocks.length - 1];
}

/* 检索旧事：玩家输入里有「上次/前日/那封/那个/之前/当初」或点名某人时，取最相关的三条 */
function retrieve(state, input) {
  const M = ensureMemory(state);
  const q = String(input || '');
  const names = [...(state.npcs || []).map(n => n.name)].filter(n => n && q.includes(n));
  const recall = /上次|上回|前日|前些日|那封|那个|那件|之前|当初|先前|曾经|还记得/.test(q);
  if (!recall && !names.length) return [];
  // 关键词：点名的人 + 输入里的二字词片段（去掉虚词）
  const stop = /^(上次|上回|那个|那件|那封|之前|当初|先前|曾经|还记|记得|我们|你们|他们|这个|什么|怎么|如何|一下|再去|还有)$/;
  const grams = new Set(names);
  for (let i = 0; i < q.length - 1; i++) { const g = q.slice(i, i + 2); if (/^[一-龥]{2}$/.test(g) && !stop.test(g)) grams.add(g); }
  const pool = [
    ...M.turns.map(t => ({ turn: t.turn, text: `${t.input}｜${t.summary}` })),
    ...((state.log || []).filter(l => l.speaker === 'GM').map(l => ({ turn: l.turn, text: String(l.text || '').slice(0, 600) }))),
  ];
  const scored = pool.map(p => ({ ...p, score: [...grams].reduce((s, g) => s + (p.text.includes(g) ? (names.includes(g) ? 3 : 1) : 0), 0) }))
    .filter(p => p.score >= 2).sort((a, b) => b.score - a.score || b.turn - a.turn);
  const seen = new Set(); const out = [];
  for (const p of scored) { if (seen.has(p.turn)) continue; seen.add(p.turn); out.push(p); if (out.length >= 3) break; }
  return out;
}

function renderMemory(state, input) {
  const M = ensureMemory(state);
  const lines = [];
  const blocks = M.blocks.slice(-3);
  if (blocks.length) { lines.push('【前情小结（每十回合一段）】'); for (const b of blocks) lines.push(`· 第${b.from}–${b.to}轮：${b.text}`); }
  const recent = M.turns.slice(-10);
  if (recent.length) { lines.push('【近十回合摘要】'); for (const t of recent) lines.push(`· 第${t.turn}轮${t.input ? `（玩家：${t.input}）` : ''}：${t.summary}`); }
  const hits = retrieve(state, input);
  if (hits.length) { lines.push('【玩家提到的旧事——档案里查到的原文，写时须与之一致】'); for (const h of hits) lines.push(`· 第${h.turn}轮：${h.text.slice(0, 220)}`); }
  return lines.length ? '=== 记忆（档案馆，不靠模型记性） ===\n' + lines.join('\n') : '';
}

module.exports = { ensureMemory, onAccept, compressIfDue, retrieve, renderMemory, validateBlock, pendingCompression };
