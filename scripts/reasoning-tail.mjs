#!/usr/bin/env node
// _reasoning-tail.mjs —— 思考链尾部打平 + 哑火预兆读数(自留件,版本无关)
//
// 干什么:
//   1. 从 session.jsonl.zstd 把最近 N 轮的【思考链原文】按时间顺序打平输出
//      —— 不经过任何 UI(0.1 的 ⊘ Think / 0.2 的四重卷轴都无关),盘上是什么就出什么
//   2. 对每轮思考链算【预兆读数】(依据 协作/哑火与压缩-实测事实.md(判据源留协作)):
//      · 短句占比   —— 预兆:思考链先变形,短句变多
//      · 连接词密度 —— 预兆:词在重复
//      · 空转自问   —— 预兆:自问句密集(只问不答)
//      三项合成 正常 / 注意 / 警报 三档;再并上 usage 判哑火轮(output==reasoning)
//   3. 防强升:已知帧读不出思考链时,列出帧类型分布并打 UNRECOGNIZED 提醒,绝不静默漏读
//
// 已核格式(2026-10-04,session-e5b8d8f5 实测):
//   assistant/message → data.message.content[] → {type:"reasoning", text}
//   旁证流:reasoning-chunks(dt+texts 分片,仅作 fallback 拼接)
//
// 用法:
//   node _reasoning-tail.mjs <session.jsonl.zstd>            # 最近 5 轮
//   node _reasoning-tail.mjs <session.jsonl.zstd> -n 12      # 最近 12 轮
//   node _reasoning-tail.mjs <session.jsonl.zstd> --meta     # 帧类型分布(格式探测)
//   node _reasoning-tail.mjs <...> --mono                    # 只出读数,不出原文(扫苗头用)
//
// 判据来源:读数只是排程信号(预兆→排程→预取→压缩),不是诊断;裁决权在用户。

import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeFrames(file) {
  const buf = fs.readFileSync(file);
  const lines = [];
  let badFrames = 0;
  let i = 0;
  while (i < buf.length - 4) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      let j = buf.indexOf(MAGIC, i + 4);
      if (j === -1) j = buf.length;
      try {
        const raw = zlib.zstdDecompressSync(buf.subarray(i, j)).toString('utf8');
        for (const L of raw.split('\n')) if (L.trim()) lines.push(L);
      } catch { badFrames++; }
      i = j;
    } else if (buf[i] === 0x50 && buf[i + 1] === 0x2a && buf[i + 2] === 0x4d && buf[i + 3] === 0x18) {
      const sz = buf.readUInt32LE(i + 4);
      if (sz > buf.length) break;
      i = i + 8 + sz;
    } else i++;
  }
  return { rows: lines.map((L) => { try { return JSON.parse(L); } catch { return null; } }).filter(Boolean), badFrames };
}

// ---------- 提取:按 turn 聚合思考链 + usage ----------
// 已知主路径:assistant/message.data.message.content[] 里的 reasoning 块
// 防强升 fallback:reasoning-chunks 流(texts 拼接),按 data.turn 分组
function collectTurns(rows) {
  const turns = new Map();   // turnNo -> {reasoning, usage, fromKnown}
  const bump = (no, field, val) => {
    if (!turns.has(no)) turns.set(no, { reasoning: '', usage: null, fromKnown: false });
    const t = turns.get(no);
    if (field === 'reasoning') t.reasoning += (t.reasoning ? '\n' : '') + val;
    if (field === 'usage') t.usage = val;
    if (field === 'known') t.fromKnown = true;
  };

  for (const r of rows) {
    if (r.type === 'assistant/message') {
      const no = r.data && r.data.turn;
      const msg = r.data && r.data.message;
      if (no == null || !msg) continue;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        if (b.type === 'reasoning' && b.text) bump(no, 'reasoning', b.text);
      }
      if (msg.usage) bump(no, 'usage', msg.usage);
      bump(no, 'known', true);
    }
  }
  // fallback:有 reasoning 流但没有 message 落地的 turn(被打断的轮)
  const chunkTurns = new Map();
  for (const r of rows) {
    if (r.type === 'reasoning-chunks') {
      const no = r.data && r.data.turn;
      const texts = r.data && r.data.texts;
      if (no == null || !Array.isArray(texts)) continue;
      if (!chunkTurns.has(no)) chunkTurns.set(no, '');
      chunkTurns.set(no, chunkTurns.get(no) + texts.join(''));
    }
  }
  for (const [no, txt] of chunkTurns) {
    if (!turns.has(no)) turns.set(no, { reasoning: txt, usage: null, fromKnown: false });
  }

  return [...turns.entries()].sort((a, b) => a[0] - b[0]).map(([no, t]) => ({ no, ...t }));
}

// ---------- 预兆读数 ----------
const CONNECTIVES = ['然后', '所以', '但是', '不过', '而且', '另外', '总之', '也就是说', '接下来', '其实', '那么', '可能', '应该', '也许', '或者', '以及'];
const SELFQ_RE = /[?？]\s*$/;
function metrics(text) {
  const sentences = String(text).split(/[。！？!?\n]+/).map(s => s.trim()).filter(Boolean);
  const n = sentences.length || 1;
  const short = sentences.filter(s => s.length <= 12).length / n;
  const connCount = {};
  for (const c of CONNECTIVES) {
    const m = text.split(c).length - 1;
    if (m > 0) connCount[c] = m;
  }
  const connTotal = Object.values(connCount).reduce((a, b) => a + b, 0);
  const connPerSent = connTotal / n;
  const topConn = Object.entries(connCount).sort((a, b) => b[1] - a[1])[0] || null;
  const selfQ = sentences.filter(s => SELFQ_RE.test(s)).length / n;

  let flags = 0;
  if (short > 0.5) flags++;
  if (connPerSent > 0.8) flags++;
  if (selfQ > 0.3) flags++;
  const level = flags >= 2 ? '🔴 警报' : flags === 1 ? '🟡 注意' : '🟢 正常';
  return { sentences: n, shortPct: (short * 100).toFixed(0), connPerSent: connPerSent.toFixed(2), topConn: topConn ? topConn[0] + '×' + topConn[1] : '-', selfQPct: (selfQ * 100).toFixed(0), level };
}

// ---------- 主流程 ----------
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('-'));
const ni = args.indexOf('-n');
const N = ni >= 0 ? parseInt(args[ni + 1] || '5', 10) : 5;
const metaOnly = args.includes('--meta');
const mono = args.includes('--mono');

if (!file || !fs.existsSync(file)) {
  console.log('用法: node _reasoning-tail.mjs <session.jsonl.zstd 绝对路径> [-n 轮数] [--meta] [--mono]');
  process.exit(1);
}

const { rows, badFrames } = decodeFrames(file);

if (metaOnly) {
  const kinds = {};
  for (const r of rows) kinds[r.type || '?'] = (kinds[r.type || '?'] || 0) + 1;
  console.log('总记录:', rows.length, '| 坏帧:', badFrames);
  console.log('帧类型分布:', JSON.stringify(kinds, null, 2));
  process.exit(0);
}

const turns = collectTurns(rows);

if (!turns.length) {
  console.log('★ 读不出任何思考链。坏帧:', badFrames, '——格式可能已变(强升?),跑 --meta 看帧类型分布。');
  console.log('  已知格式:assistant/message → data.message.content[] → {type:"reasoning"}(2026-10-04 核)');
  process.exit(2);
}

const tail = turns.slice(-N);
const totalText = turns.reduce((s, t) => s + t.reasoning.length, 0);
const knownPct = turns.filter(t => t.fromKnown).length / turns.length;
console.log(`思考链轮次:全文件 ${turns.length} 轮(结构化命中 ${(knownPct * 100).toFixed(0)}%,其余来自 chunk 流兜底),显示最近 ${tail.length} 轮 | 坏帧:${badFrames}`);
if (knownPct < 0.5) console.log('★ 结构化命中率 <50%:格式可能已变,跑 --meta 核对!');
console.log('='.repeat(72));

for (const t of tail) {
  const m = metrics(t.reasoning);
  const u = t.usage;
  const mute = u && u.output_tokens != null && u.reasoning_tokens != null && Number(u.output_tokens) === Number(u.reasoning_tokens) && Number(u.output_tokens) > 0;
  const flag = m.level.includes('警报') || mute ? '🔴' : m.level.includes('注意') ? '🟡' : '·';
  console.log(`${flag} 第 ${t.no} 轮 | 预兆:${m.level}${mute ? ' | ⚠️ 疑似哑火(output==reasoning)' : ''} | 链长 ${t.reasoning.length} 字`);
  console.log(`   句子 ${m.sentences} | 短句 ${m.shortPct}% | 连接词/句 ${m.connPerSent}(最高 ${m.topConn}) | 自问句 ${m.selfQPct}%`);
  if (!mono) {
    const show = t.reasoning.length > 2400
      ? t.reasoning.slice(0, 1200) + `\n   ……(中略 ${t.reasoning.length - 2400} 字)……\n` + t.reasoning.slice(-1200)
      : t.reasoning;
    console.log('   ' + show.split('\n').join('\n   '));
  }
  console.log('-'.repeat(72));
}
console.log('提示:读数是排程信号(预兆→排程→预取→压缩),不是诊断;裁决权在用户。--mono 扫苗头,默认带原文。');
