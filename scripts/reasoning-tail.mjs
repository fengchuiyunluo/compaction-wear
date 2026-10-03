#!/usr/bin/env node
// reasoning-tail.mjs —— 思考链尾部打平 + 哑火预兆读数 v2(自留件,版本无关)
//
// v2 口径(2026-10-04 用户校准):短词/短句多 = 她的正常风格,不算征兆;
//   【短词过多甚至短词爆发】才是征兆。故不设绝对阈值,改测三样形态:
//     A. 尾部塌缩:最后25%文本的超短句(<=6字)占比 - 全文占比,>30pp = 尾部突然变碎
//     B. 词塌缩:尾部高频词 top1 集中度 >=35% = 同一词反复(指令空转,如"動手。"连发)
//     C. 句长收缩:后半平均句长 - 前半,<-8字且句数>=20 = 越写越碎
//   短句基线仅展示,供与健康样本对比(标定:跑健康区间)。
// v1->v2 变更:删"短句占比>50%即黄"的绝对阈值(误报,那是她的基线)。
//
// 用法:
//   node reasoning-tail.mjs <session.jsonl.zstd> [-n 轮数] [--meta] [--mono]
//
// 判据来源:读数是排程信号(预兆→排程→预取→压缩),不是诊断;裁决权在用户。

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

function collectTurns(rows) {
  const turns = new Map();
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

const SELFQ_RE = /[?？]s*$/;
function metrics(text) {
  const sentences = String(text).split(/[。！？!?\u000A]+/).map(s => s.trim()).filter(Boolean);
  const n = sentences.length || 1;
  const shortRatio = sentences.filter(s => s.length <= 12).length / n;

  // A. 尾部塌缩
  const cut = Math.floor(sentences.length * 0.75);
  const head = sentences.slice(0, cut), tail = sentences.slice(cut);
  const ultra = arr => arr.filter(s => s.length <= 6).length / (arr.length || 1);
  const tailCollapse = ultra(tail) - ultra(head);

  // B. 词塌缩(尾部)
  const freq = {};
  tail.forEach(s => { const w = s.replace(/[s,，.。;；!！?？、]/g, ''); if (w) freq[w] = (freq[w] || 0) + 1; });
  const freqArr = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  const topWord = freqArr[0] || ['-', 0];
  const wordCollapse = tail.length >= 8 ? topWord[1] / tail.length : 0;

  // C. 句长收缩
  const mid = Math.floor(sentences.length / 2);
  const avg = arr => arr.reduce((s2, x) => s2 + x.length, 0) / (arr.length || 1);
  const shrink = sentences.length >= 20 ? (avg(sentences.slice(mid)) - avg(sentences.slice(0, mid))) : 0;

  // D. 繁体污染率
  const TRAD='\u52d5\u8a08\u756b\u6642\u9593\u78ba\u8a8d\u9084\u6703\u8a71\u88e1\u5be6\u8b93\u500b\u7c21\u9304\u9ebc\u904e\u9019\u8aaa\u5c0d\u958b\u95dc\u9580\u5f8c\u767c\u898b\u8eca\u99ac\u9ce5\u8a9e\u8b80\u5beb\u5b78\u9ad4\u9ede\u9577\u6a02\u8ce3\u8cb7\u66f8\u696d\u6771\u5169\u56b4\u8acb\u70ba\u4f86\u61c9\u8b8a\u807d\u5167\u8655\u8fa6\u4e26\u50b7\u5132\u5beb\u5c64\u5c6c\u5e2b\u5e36\u5e7e\u5ee0\u5f37\u5fb5\u61b6\u61f7\u8b77\u8b9a\u5ee2\u5fb9\u64ca\u640d\u64da\u71df\u904b\u7121\u71d2\u7e23\u8c50\u8f49\u9060\u96fb\u58d3\u969b\u97ff\u9867\u98db\u990a\u9a5a\u9f4a';
  const tradSet=new Set(TRAD.split(''));
  let cjk=0, tr=0;
  for(const ch of String(text)){ const c=ch.codePointAt(0); if(c>=0x4e00&&c<=0x9fff){cjk++; if(tradSet.has(ch))tr++;} }
  const tradPct = cjk? tr/cjk*100 : 0;

  let flags = 0, why = [];
  if (tailCollapse > 0.3) { flags++; why.push('尾部塌缩+' + Math.round(tailCollapse * 100) + 'pp'); }
  if (wordCollapse >= 0.35) { flags++; why.push('词塌缩:' + topWord[0] + '×' + topWord[1] + '(' + Math.round(wordCollapse * 100) + '%)'); }
  if (shrink < -8) { flags++; why.push('句长收缩' + Math.round(shrink) + '字'); }
  const selfQ = sentences.filter(s => SELFQ_RE.test(s)).length / n;
  if (selfQ > 0.3) { flags++; why.push('自问句' + Math.round(selfQ * 100) + '%'); }
  if (tradPct > 5) { flags++; why.push('繁体污染' + tradPct.toFixed(1) + '%'); }
  else if (tradPct > 2) { flags++; why.push('繁体渗入' + tradPct.toFixed(1) + '%'); }
  const level = flags >= 2 ? '🔴 警报' : flags === 1 ? '🟡 注意' : '🟢 正常';
  return {
    sentences: n,
    shortPct: Math.round(shortRatio * 100),
    tailCollapsePct: Math.round(tailCollapse * 100),
    topTailWord: topWord[0] + '×' + topWord[1],
    shrink: Math.round(shrink),
    tradPct,
    level, why: why.join(' · ') || '无'
  };
}

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('-'));
const ni = args.indexOf('-n');
const N = ni >= 0 ? parseInt(args[ni + 1] || '5', 10) : 5;
const metaOnly = args.includes('--meta');
const mono = args.includes('--mono');

if (!file || !fs.existsSync(file)) {
  console.log('用法: node reasoning-tail.mjs <session.jsonl.zstd> [-n 轮数] [--meta] [--mono]');
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
  console.log('★ 读不出任何思考链。坏帧:', badFrames, '——格式可能已变(强升?),跑 --meta。');
  process.exit(2);
}

const tail = turns.slice(-N);
const knownPct = turns.filter(t => t.fromKnown).length / turns.length;
console.log('思考链轮次:全文件 ' + turns.length + ' 轮(结构化命中 ' + Math.round(knownPct * 100) + '%),显示最近 ' + tail.length + ' 轮 | 坏帧:' + badFrames);
if (knownPct < 0.5) console.log('★ 结构化命中率 <50%:格式可能已变,跑 --meta 核对!');
console.log('='.repeat(72));

for (const t of tail) {
  const m = metrics(t.reasoning);
  const u = t.usage;
  const mute = u && u.output_tokens != null && u.reasoning_tokens != null && Number(u.output_tokens) === Number(u.reasoning_tokens) && Number(u.output_tokens) > 0;
  const flag = (m.level.includes('警报') || mute) ? '🔴' : m.level.includes('注意') ? '🟡' : '·';
  console.log(flag + ' 第 ' + t.no + ' 轮 | 预兆:' + m.level + ' | ' + m.why + (mute ? ' | ⚠️ 疑似哑火(output==reasoning)' : '') + ' | 链长 ' + t.reasoning.length + ' 字');
  console.log('   短句基线 ' + m.shortPct + '% | 尾部塌缩 ' + m.tailCollapsePct + 'pp | 尾部高频 ' + m.topTailWord + ' | 句长趋势 ' + m.shrink + '字 | 繁体污染 ' + m.tradPct.toFixed(1) + '%');
  if (!mono) {
    const show = t.reasoning.length > 2400
      ? t.reasoning.slice(0, 1200) + '\n   ……(中略 ' + (t.reasoning.length - 2400) + ' 字)……\n' + t.reasoning.slice(-1200)
      : t.reasoning;
    console.log('   ' + show.split('\n').join('\n   '));
  }
  console.log('-'.repeat(72));
}
console.log('提示:读数是排程信号(预兆→排程→预取→压缩),不是诊断;裁决权在用户。--mono 扫苗头。');
