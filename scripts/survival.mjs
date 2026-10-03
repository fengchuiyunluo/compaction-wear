#!/usr/bin/env node
// _survival.mjs —— 通用「压缩存活率」统计
//
// 干什么：给一个会话文件，找出它最后一次 compaction/summary，
//         统计【压缩点之前】四类记录有多少进了摘要、多少没进。
//
// 用法：
//   node _survival.mjs <session.jsonl.zstd>            # 只看总表
//   node _survival.mjs <session.jsonl.zstd> --list     # 附未存活清单
//   node _survival.mjs <session.jsonl.zstd> --list --max 80
//
// 口径（详见同目录 README.md）：
//   ① 原话  = 归一化后逐字出现在摘要里
//   ② 实体  = 原文里的标识符（路径/文件/数字/英文词）≥50% 出现在摘要里
//   ③ 无    = 以上都不满足（注意：③ 里大量是寒暄、感叹词，本来就不该进摘要）
//
// ⚠️ 这个统计是纯字面活，不要交给模型跑：脚本秒级且可复现，模型慢且不可复现。

import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeFrames(file) {
  const buf = fs.readFileSync(file);
  const lines = [];
  let i = 0;
  while (i < buf.length - 4) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      let j = buf.indexOf(MAGIC, i + 4);
      if (j === -1) j = buf.length;
      try {
        const raw = zlib.zstdDecompressSync(buf.subarray(i, j)).toString('utf8');
        for (const L of raw.split('\n')) if (L.trim()) lines.push(L);
      } catch { /* 坏帧跳过 */ }
      i = j;
    } else if (buf[i] === 0x50 && buf[i + 1] === 0x2a && buf[i + 2] === 0x4d && buf[i + 3] === 0x18) {
      const sz = buf.readUInt32LE(i + 4);
      if (sz > buf.length) break;
      i = i + 8 + sz;
    } else i++;
  }
  return lines.map((L) => { try { return JSON.parse(L); } catch { return null; } }).filter(Boolean);
}

const ENT_RE = /[A-Za-z][A-Za-z0-9_.\-]{2,}|[0-9]+(?:\.[0-9]+)?/g;
const norm = (s) => String(s || '').replace(/[\s\u3000]+/g, '');
const entities = (s) => [...new Set((String(s).match(ENT_RE) || []).map((x) => x.toLowerCase()))];

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const wantList = args.includes('--list');
const mi = args.indexOf('--max');
const maxN = mi >= 0 ? parseInt(args[mi + 1] || '40', 10) : 40;

if (!file || !fs.existsSync(file)) {
  console.log('用法: node _survival.mjs <session.jsonl.zstd 绝对路径> [--list] [--max N]');
  process.exit(1);
}

const recs = decodeFrames(file);
const sums = recs.filter((r) => r.type === 'compaction/summary');
if (!sums.length) {
  console.log('该会话没有 compaction/summary 事件 —— 它没被压缩过。');
  process.exit(1);
}
const sum = sums[sums.length - 1];
const sumRaw = (sum.data.summary || []).map((x) => x.text || '').join('\n');
// 剥掉行内代码：摘要里反引号包着的是代码/路径/节名，不是「引用」
const sumText = sumRaw.replace(/`[^`]*`/g, '\u3014C\u3015');
const sumN = norm(sumText);
const sumEnt = new Set(entities(sumText));

const items = { user: [], assistant: [], reasoning: [], tool: [] };
for (const r of recs) {
  if (r.time > sum.time) continue;
  if (r.type === 'agent/inbox/spliced') {
    for (const ins of (r.data?.inserted || [])) {
      if (ins?.source?.kind !== 'user') continue;
      const t = (ins.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (t) items.user.push({ t, time: r.time });
    }
  } else if (r.type === 'assistant/message') {
    const c = r.data?.message?.content || [];
    const t = c.filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim();
    const rr = c.filter((x) => x.type === 'reasoning').map((x) => x.text || '').join('\n').trim();
    if (t) items.assistant.push({ t, time: r.time });
    if (rr) items.reasoning.push({ t: rr, time: r.time });
  } else if (r.type === 'tool/result') {
    const t = JSON.stringify(r.data || {});
    if (t) items.tool.push({ t, time: r.time });
  }
}

function stat(arr) {
  const rows = [];
  let q = 0, e = 0, n = 0;
  for (const x of arr) {
    const nn = norm(x.t);
    let mark = '\u2462\u65e0';
    if (nn.length >= 4 && sumN.includes(nn)) { mark = '\u2460\u539f\u8bdd'; q++; }
    else {
      const ent = entities(x.t);
      if (ent.length && ent.filter((v) => sumEnt.has(v)).length / ent.length >= 0.5) { mark = '\u2461\u5b9e\u4f53'; e++; }
      else n++;
    }
    rows.push({ ...x, mark, len: nn.length });
  }
  return { q, e, n, total: arr.length, rows };
}

const sessionId = (recs.find((r) => r.type === 'session')?.id) || '(未知)';
console.log('会话 ' + sessionId);
console.log('记录 ' + recs.length + ' 条 ｜ 压缩点 ' + new Date(sum.time).toLocaleString('zh-CN'));
console.log('摘要 ' + sumRaw.length + ' 字符 ｜ 压缩点之前记录 ' +
  (items.user.length + items.assistant.length + items.reasoning.length + items.tool.length) + ' 条\n');

const labels = { user: 'user/message', assistant: 'assistant/message', reasoning: 'reasoning', tool: 'tool/result' };
const out = {};
console.log('\u7c7b\u522b'.padEnd(20) + '\u6761\u6570'.padStart(8) + '   ' +
  '\u2460\u539f\u8bdd'.padStart(16) + '   ' + '\u2461\u5b9e\u4f53'.padStart(10) + '   ' + '\u2462\u65e0'.padStart(10));
for (const k of ['user', 'assistant', 'reasoning', 'tool']) {
  const s = stat(items[k]);
  out[k] = s;
  const pct = (v) => s.total ? (v / s.total * 100).toFixed(1) + '%' : '-';
  console.log(labels[k].padEnd(20) + String(s.total).padStart(8) + '   ' +
    (s.q + ' (' + pct(s.q) + ')').padStart(16) + '   ' +
    (s.e + ' (' + pct(s.e) + ')').padStart(10) + '   ' +
    (s.n + ' (' + pct(s.n) + ')').padStart(10));
}

if (wantList) {
  for (const k of ['user', 'assistant', 'reasoning', 'tool']) {
    const rows = out[k].rows.filter((r) => r.mark !== '\u2460\u539f\u8bdd').sort((a, b) => b.len - a.len).slice(0, maxN);
    if (!rows.length) continue;
    console.log('\n=== ' + labels[k] + ' 未存活（前 ' + rows.length + ' 条，按长度降序）===');
    for (const r of rows) {
      const when = new Date(r.time).toLocaleString('zh-CN');
      console.log('  ' + r.mark + '  ' + when + '  (' + r.len + ')  ' + r.t.replace(/\s+/g, ' ').slice(0, 110));
    }
  }
}
