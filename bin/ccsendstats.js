#!/usr/bin/env node
/**
 * ccsendstats 🔌 — see what your Claude Code session actually sends to the API.
 *
 * Every request re-sends the system prompt, tool definitions, and the whole
 * conversation. The transcript records the *real* token totals (from API
 * usage) — this tool breaks them down: how much is your words, how much is
 * tool output, and how much is overhead you never see.
 *
 *   ccsendstats                # latest session of the project you're in
 *   ccsendstats 657f           # a session by id prefix, any project
 *   ccsendstats --turns 10     # per-request token growth
 *   ccsendstats --diff         # what the last request added
 *   ccsendstats proxy          # live: the bytes a transcript can't show you
 *   ccsendstats proxy-report   # summarize what the proxy has logged
 */
'use strict';

const path = require('path');
const T = require('../lib/vendor/transcript.js');
const W = require('../lib/sendstats.js');
const P = require('../lib/proxy.js');

if (process.argv[2] === 'proxy') { P.serve(); return; }
if (process.argv[2] === 'proxy-report') { P.report(); process.exit(0); }

// 出力言語: 既定は英語、ロケールが日本語のときだけ日本語(CCSENDSTATS_LANGで明示指定も可)
const JA = /^ja/i.test(process.env.CCSENDSTATS_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const L = (en, ja) => (JA ? ja : en);

const HELP = `ccsendstats — what your Claude Code session actually sends to the API

Usage: ccsendstats [session-id-prefix] [options]
  (no args)      latest session of the project in your cwd
  --project S    latest session whose project dir matches S
  --turns N      show the last N requests (real tokens, growth per turn)
  --diff         what the last request added vs the previous one
  --json         structured output
  --base-dir D   transcript root (default ~/.claude/projects)

  --daily        cross-session: peak/avg request size per day, as % of the
                 context window (how close you got to auto-compact, not
                 what one session sent)
  --days N       with --daily/--breakdown, only sessions whose last request
                 falls in the last N days
  --breakdown    with --daily: category share across all sessions in range
                 instead of a day-by-day peak (where your context budget is
                 actually going, not how full it got) — slower, since it
                 reads full session content instead of just usage totals
  --cache        with --daily: per-day split of input tokens into uncached /
                 cache-write-1h / cache-write-5m / cache-read (billing-rate
                 mix, not content category — pairs with --breakdown, doesn't
                 replace it)
  --baseline     with --daily: avg tokens sent before your first word, per
                 day a new session started — is your always-on overhead
                 (system prompt + CLAUDE.md + memory + tool defs) growing or
                 shrinking over time? Also reads full session content.
  --interrupt    with --daily: share of prompts sent while the previous turn
                 was still running (promptSource=queued), per day — a
                 behaviour metric, not a token one; cheap (reads timestamps
                 and promptSource only, not full content).

  proxy          observe live traffic (the only way to see system prompt +
                 tool definition bytes, which never reach the transcript)
  proxy-report   summarize what the proxy has logged so far

Totals are REAL (from API usage in the transcript). The category breakdown is
a byte-based estimate (~4 bytes/token) of what is visible in the transcript;
the remainder — system prompt, tool definitions, anything not recorded — is
reported as invisible overhead. Attachment lines (skill listings, MCP
instructions, reminders) count as injected context when they record the text
they sent (\`rendered\`, Claude Code 2.1.263+); older ones stay in the remainder.
--daily's window isn't recorded anywhere, so it's inferred per day from the
data itself: the smallest of ${W.KNOWN_WINDOWS.map((w) => w.toLocaleString()).join('/')}
tokens that's still at least as big as that day's largest request.`;

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') o.project = argv[++i];
    else if (a === '--turns') o.turns = Math.max(1, parseInt(argv[++i], 10) || 10);
    else if (a === '--diff') o.diff = true;
    else if (a === '--json') o.json = true;
    else if (a === '--base-dir') o.baseDir = argv[++i];
    else if (a === '--daily') o.daily = true;
    else if (a === '--days') o.days = +argv[++i];
    else if (a === '--breakdown') o.breakdown = true;
    else if (a === '--cache') o.cache = true;
    else if (a === '--baseline') o.baseline = true;
    else if (a === '--interrupt') o.interrupt = true;
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (!a.startsWith('-') && !o.session) o.session = a;
    else if (a.startsWith('-')) {
      // 知らないフラグを黙って捨てると、typo(--dyas 1)が「全期間の集計」として
      // 成功し、間違った数字を正しい答えだと思って読むことになる(初見レビューで
      // 実際に踏まれた)。知らないものは受け取らない。
      console.error(L(`unknown option: ${a}`, `知らないオプション: ${a}`));
      console.error(L('try --help', '--help を参照してください'));
      process.exit(2);
    }
  }
  // --days -3 put the cutoff in the future and reported "no requests";
  // --days abc was dropped and every day was counted.
  if (o.days != null && !(Number.isFinite(o.days) && o.days > 0)) {
    console.error(L('--days: expected a positive number', '--days: 正の数で指定してください'));
    process.exit(2);
  }
  return o;
}

function fmt(n) {
  if (n == null) return '?';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function pct(part, whole) {
  if (!whole) return '';
  return (100 * part / whole).toFixed(1) + '%';
}
function pad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

/** セッション解決: prefix 指定 > cwd のプロジェクト最新 > 全体最新 */
function resolveSession(o) {
  const all = T.locate({ baseDir: o.baseDir });
  if (!all.length) return null;
  if (o.session) return all.find((s) => s.session.startsWith(o.session)) || null;
  if (o.project) return all.find((s) => s.projectDir.toLowerCase().includes(o.project.toLowerCase())) || null;
  const cwdName = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
  return all.find((s) => s.projectDir === cwdName) || all[0];
}

async function loadEntries(file) {
  const entries = [];
  for await (const e of T.readEntries(file)) entries.push(e);
  return entries;
}

const CAT_LABELS = () => ([
  ['toolResults', L('tool results', 'ツール実行結果')],
  ['assistantText', L('assistant text', 'アシスタント本文')],
  ['thinking', L('thinking blocks', 'thinking ブロック')],
  ['toolInputs', L('tool call inputs', 'ツール呼び出し入力')],
  ['injected', L('injected context (reminders, hooks)', '注入コンテキスト(リマインダ・フック)')],
  ['userText', L('your own words', 'ユーザー本文')],
]);

function printOverview(info, a) {
  const { last, visible, baseline, firstPrompt, invisible } = a;
  console.log(`ccsendstats — ${info.session.slice(0, 8)} · ${T.projectName(info.projectDir)} · ${a.requests.length} ${L('requests', 'リクエスト')}${last && last.model ? ' · ' + last.model : ''}`);
  if (!last) { console.log(L('no API requests found in this transcript', 'この transcript に API リクエストが見つかりません')); return; }

  console.log('');
  console.log(`${L('Last request', '最終リクエスト')}: ${fmt(last.realIn)} ${L('tokens sent (real, from API usage)', 'トークン送信(API usage の実測値)')}`);
  const cacheBits = [
    `${pct(last.cacheRead, last.realIn)} ${L('cache-read', 'キャッシュ読取')}`,
    `${pct(last.cacheWrite, last.realIn)} ${L('cache-write', 'キャッシュ書込')}`,
    `${pct(last.uncached, last.realIn)} ${L('uncached', '非キャッシュ')}`,
  ];
  console.log(`  ${L('cache', 'キャッシュ')}: ${cacheBits.join(' · ')}`);

  console.log('');
  console.log(`  ${L('visible in transcript (est.)', 'transcript から見える分(概算)')}: ${fmt(visible.total)}  ${pct(visible.total, last.realIn)}`);
  for (const [key, label] of CAT_LABELS()) {
    if (!visible[key]) continue;
    console.log(`    ${label.padEnd(JA ? 24 : 36)} ${pad(fmt(visible[key]), 9)}  ${pad(pct(visible[key], last.realIn), 6)}`);
  }
  if (invisible != null) {
    console.log(`  ${L('invisible overhead (est.)', '不可視オーバーヘッド(概算)')}: ${fmt(invisible)}  ${pct(invisible, last.realIn)}`);
    console.log(`    ${L('system prompt + tool definitions + anything not recorded in the transcript', 'system prompt+ツール定義+transcript に記録されないもの')}`);
  }

  if (baseline != null && firstPrompt) {
    console.log('');
    console.log(`${L('First request', '最初のリクエスト')}: ${fmt(baseline)} ${L('tokens went out before your first message', 'トークンが最初の一言より前に送信')} (${L('your message', 'あなたの一言')}: ${firstPrompt.chars} ${L('chars', '文字')} ≈ ${fmt(firstPrompt.est)} tok)`);
  }
}

function printTurns(a, n) {
  const reqs = a.requests.slice(-n);
  console.log('');
  console.log(`${L('turn', 'ターン')}   ${pad(L('sent (real)', '送信(実測)'), 12)}  ${pad('Δ', 8)}  ${pad(L('output', '出力'), 8)}  ${pad(L('cache-read', 'キャッシュ読取'), 10)}`);
  const offset = a.requests.length - reqs.length;
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    const prev = a.requests[offset + i - 1];
    const d = prev ? r.realIn - prev.realIn : null;
    console.log(`${pad(offset + i + 1, 4)}   ${pad(fmt(r.realIn), 12)}  ${pad(d == null ? '—' : (d >= 0 ? '+' : '') + fmt(d), 8)}  ${pad(fmt(r.out), 8)}  ${pad(pct(r.cacheRead, r.realIn), 10)}`);
  }
}

function printDiff(d) {
  console.log('');
  if (!d) { console.log(L('need at least 2 requests for --diff', '--diff には2リクエスト以上が必要です')); return; }
  console.log(`${L('Last request vs previous', '最終リクエストと直前の差分')}: ${d.realDelta >= 0 ? '+' : ''}${fmt(d.realDelta)} ${L('tokens (real)', 'トークン(実測)')}`);
  for (const [key, label] of CAT_LABELS()) {
    if (!d.delta[key]) continue;
    console.log(`  ${label.padEnd(JA ? 24 : 36)} ${pad((d.delta[key] >= 0 ? '+' : '') + fmt(d.delta[key]), 9)} (${L('est.', '概算')})`);
  }
  if (d.newBlocks.length) {
    console.log(`  ${L('largest new blocks', '新たに載った大きなブロック')}:`);
    for (const b of d.newBlocks) console.log(`    ${pad(fmt(b.est), 7)} tok  ${b.kind}  "${b.preview}"`);
  }
}

function bar(pct, w) {
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return '█'.repeat(filled) + '·'.repeat(Math.max(0, w - filled));
}

/**
 * --daily: 単一セッションの深掘りではなく、全セッション横断でリクエストの
 * 「実測サイズ」を日別に集計する。ピークはauto-compactにどれだけ近づいたか、
 * 平均は普段の水準 — どちらもrequestsOf()が返すrealIn(実測入力トークン)を
 * そのままウィンドウ比%に変換するだけで、独自のトークン推定は増やさない。
 */
function median(sorted) {
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// p50単独よりp25-p75の帯を添えた方が「典型的な使い方の幅」が見える(実測:
// peakと違ってp75/p90も日によって動く — p50だけでは分布の広がりが消える)。
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return sorted[idx];
}

async function collectDaily(o) {
  const sinceMs = o.days ? Date.now() - o.days * 86400000 : undefined;
  const files = T.locate({ baseDir: o.baseDir, project: o.project, sinceMs });
  const byDay = new Map();
  for (const f of files) {
    const entries = await loadEntries(f.file);
    for (const r of W.requestsOf(entries)) {
      if (!r.ts) continue;
      const t = Date.parse(r.ts);
      if (sinceMs !== undefined && (Number.isNaN(t) || t < sinceMs)) continue;
      // the local day, not the UTC day of the ISO string (an unparseable stamp keeps its old label)
      const day = Number.isNaN(t) ? r.ts.slice(0, 10) : W.dayKey(t);
      // peakは「その日一番長く続いたセッション」で決まりがちで、セッション数が
      // 多い日ほど構造的に上限へ張り付く(実測: ほぼ毎日90%台で固定)。avgも
      // ターン数で単純加重するとセッション内の後半(値が大きい)に引きずられる。
      // 分布の中央値(p50)は「典型的な1ターン」を代表しやすいので、値そのものを
      // 全部保持しておいて後でソートする。
      if (!byDay.has(day)) byDay.set(day, { peak: 0, values: [], turns: 0 });
      const d = byDay.get(day);
      d.turns += 1;
      d.values.push(r.realIn);
      if (r.realIn > d.peak) d.peak = r.realIn;
    }
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, d]) => {
    // 窓はその日のピークから推定する(実測できないので下限として)。同じ日の
    // avg/p50もこの日自身の推定窓で割る — 日をまたいで窓が変わりうる(プラン
    // 変更・一時的な拡張)ため、全期間で1つの窓に固定しない。
    const window = W.inferWindow(d.peak);
    const sum = d.values.reduce((a, v) => a + v, 0);
    const avgTokens = d.turns ? Math.round(sum / d.turns) : 0;
    const sorted = [...d.values].sort((a, b) => a - b);
    const p50Tokens = Math.round(median(sorted));
    return {
      date,
      turns: d.turns,
      window,
      peakTokens: d.peak,
      peakPct: W.pctOfWindow(d.peak, window),
      avgTokens,
      avgPct: W.pctOfWindow(avgTokens, window),
      p50Tokens,
      p50Pct: W.pctOfWindow(p50Tokens, window),
      p25Pct: W.pctOfWindow(percentile(sorted, 25), window),
      p75Pct: W.pctOfWindow(percentile(sorted, 75), window),
    };
  });
}

function printDaily(daily) {
  console.log(`=== ccsendstats --daily ===`);
  if (!daily.length) { console.log(L('(no requests recorded)', '(記録されたリクエストなし)')); return; }
  for (const d of daily) {
    console.log(`  ${d.date}  peak ${pad(d.peakPct + '%', 6)}  ${bar(d.peakPct, 24)}  p25 ${d.p25Pct}%  p50 ${d.p50Pct}%  p75 ${d.p75Pct}%  (${d.turns} ${L('turns', 'ターン')}, ${L('window', '推定窓')} ${(d.window / 1000)}k)`);
  }
}

/**
 * --daily --cache: 入力トークンを課金レート別(非キャッシュ/キャッシュ書込1h/
 * キャッシュ書込5m/キャッシュ読込)に日別集計する。内容のカテゴリ(--breakdown)
 * とは別軸 — 同じrequestsOf()の別フィールドを足すだけで、新しい推定は増やさない。
 */
async function collectCache(o) {
  const sinceMs = o.days ? Date.now() - o.days * 86400000 : undefined;
  const files = T.locate({ baseDir: o.baseDir, project: o.project, sinceMs });
  const byDay = new Map();
  for (const f of files) {
    const entries = await loadEntries(f.file);
    for (const r of W.requestsOf(entries)) {
      if (!r.ts) continue;
      const t = Date.parse(r.ts);
      if (sinceMs !== undefined && (Number.isNaN(t) || t < sinceMs)) continue;
      // the local day, not the UTC day of the ISO string (an unparseable stamp keeps its old label)
      const day = Number.isNaN(t) ? r.ts.slice(0, 10) : W.dayKey(t);
      if (!byDay.has(day)) byDay.set(day, { uncached: 0, write1h: 0, write5m: 0, read: 0, turns: 0 });
      const d = byDay.get(day);
      d.turns += 1;
      d.uncached += r.uncached;
      d.write1h += r.cacheWrite1h;
      d.write5m += r.cacheWrite5m;
      d.read += r.cacheRead;
    }
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, d]) => {
    const total = d.uncached + d.write1h + d.write5m + d.read || 1;
    return {
      date, turns: d.turns,
      uncached: d.uncached, write1h: d.write1h, write5m: d.write5m, read: d.read,
      uncachedPct: +((d.uncached / total) * 100).toFixed(1),
      write1hPct: +((d.write1h / total) * 100).toFixed(1),
      write5mPct: +((d.write5m / total) * 100).toFixed(1),
      readPct: +((d.read / total) * 100).toFixed(1),
    };
  });
}

function printCache(daily) {
  console.log('=== ccsendstats --daily --cache ===');
  if (!daily.length) { console.log(L('(no requests recorded)', '(記録されたリクエストなし)')); return; }
  console.log(`  ${L('date', '日付').padEnd(12)} ${pad(L('uncached', '非キャッシュ'), 10)} ${pad('write-1h', 10)} ${pad('write-5m', 10)} ${pad(L('read', '読込'), 10)}`);
  for (const d of daily) {
    console.log(`  ${d.date.padEnd(12)} ${pad(d.uncachedPct + '%', 10)} ${pad(d.write1hPct + '%', 10)} ${pad(d.write5mPct + '%', 10)} ${pad(d.readPct + '%', 10)}`);
  }
}

/**
 * --daily --breakdown: どこに払っているかを全セッション横断で集計する。
 * セッション単体の analyze() が既に持つ visible/invisible をそのまま合算するだけ —
 * カテゴリ推定ロジックを増やさない。分母は各セッション最終リクエストの実測値の合計
 * (invisibleも同じ土俵に乗るのはここだけ)。
 */
async function collectBreakdown(o) {
  const sinceMs = o.days ? Date.now() - o.days * 86400000 : undefined;
  const files = T.locate({ baseDir: o.baseDir, project: o.project, sinceMs });
  const totals = { userText: 0, injected: 0, toolResults: 0, assistantText: 0, thinking: 0, toolInputs: 0 };
  let totalReal = 0, totalInvisible = 0, sessions = 0;
  for (const f of files) {
    const entries = await loadEntries(f.file);
    const a = W.analyze(entries);
    if (!a.last) continue;
    if (sinceMs !== undefined) {
      if (!a.last.ts) continue;
      const t = Date.parse(a.last.ts);
      if (Number.isNaN(t) || t < sinceMs) continue;
    }
    sessions += 1;
    totalReal += a.last.realIn;
    totalInvisible += a.invisible || 0;
    for (const k of Object.keys(totals)) totals[k] += a.visible[k] || 0;
  }
  const denom = totalReal || 1;
  const rows = Object.entries(totals)
    .map(([key, tokens]) => ({ key, tokens, pct: +((tokens / denom) * 100).toFixed(1) }))
    .sort((a, b) => b.tokens - a.tokens);
  rows.push({ key: 'invisible', tokens: totalInvisible, pct: +((totalInvisible / denom) * 100).toFixed(1) });
  return { sessions, totalReal, rows };
}

function printBreakdown(b) {
  console.log(`=== ccsendstats --daily --breakdown (${b.sessions} ${L('sessions', 'セッション')}) ===`);
  if (!b.sessions) { console.log(L('(no requests recorded)', '(記録されたリクエストなし)')); return; }
  const labels = Object.assign({ invisible: L('invisible overhead (est.)', '不可視オーバーヘッド(概算)') },
    Object.fromEntries(CAT_LABELS()));
  for (const r of b.rows) {
    console.log(`  ${(labels[r.key] || r.key).padEnd(JA ? 24 : 36)} ${pad(fmt(r.tokens), 12)}  ${pad(r.pct + '%', 6)}  ${bar(r.pct, 24)}`);
  }
}

/**
 * --daily --baseline: 「会話が始まる前に、すでに何トークン送られているか」
 * (analyze()のbaseline — system prompt + CLAUDE.md + メモリ + ツール定義など、
 * 最初の一言より前の分)をセッションの開始日ごとに集計する。--daily/--cacheの
 * 「そのターンの文脈量」とは別の質問 — こちらは会話の中身に関係なく常に
 * 乗っている固定費が、日を追って増えているか減っているかを見る。
 * --breakdownと同じく、baselineの算出にfirstPromptEst含む全文が要るので
 * セッション全文を読む(usage合計だけでは出せない)。
 */
async function collectBaseline(o) {
  const sinceMs = o.days ? Date.now() - o.days * 86400000 : undefined;
  const files = T.locate({ baseDir: o.baseDir, project: o.project, sinceMs });
  const byDay = new Map();
  for (const f of files) {
    const entries = await loadEntries(f.file);
    const a = W.analyze(entries);
    if (a.baseline == null || !a.first || !a.first.ts) continue;
    const t = Date.parse(a.first.ts);
    if (sinceMs !== undefined && (Number.isNaN(t) || t < sinceMs)) continue;
    const day = Number.isNaN(t) ? a.first.ts.slice(0, 10) : W.dayKey(t);
    if (!byDay.has(day)) byDay.set(day, { sum: 0, sessions: 0, min: Infinity, max: 0 });
    const d = byDay.get(day);
    d.sum += a.baseline;
    d.sessions += 1;
    if (a.baseline < d.min) d.min = a.baseline;
    if (a.baseline > d.max) d.max = a.baseline;
  }
  return [...byDay.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([date, d]) => ({
    date,
    sessions: d.sessions,
    avgBaseline: Math.round(d.sum / d.sessions),
    minBaseline: d.min,
    maxBaseline: d.max,
  }));
}

function printBaseline(daily) {
  console.log('=== ccsendstats --daily --baseline ===');
  if (!daily.length) { console.log(L('(no sessions recorded)', '(記録されたセッションなし)')); return; }
  for (const d of daily) {
    console.log(`  ${d.date}  avg ${pad(fmt(d.avgBaseline), 9)} tok  (${L('range', '範囲')} ${fmt(d.minBaseline)}-${fmt(d.maxBaseline)}, ${d.sessions} ${L('new sessions', '新規セッション')})`);
  }
}

/**
 * --daily --interrupt: 実行中に次のプロンプトを送った割合(promptSource='queued')
 * を日別に見る。tokenの話ではなく行動の話 — usage合計やbaseline算出のような
 * 全文読み込みは不要で、各エントリのtimestamp/promptSourceだけを見れば済む
 * (ccflakyの--dailyと同じ、エントリ単位でsinceMsを切る境界処理)。
 */
async function collectInterrupt(o) {
  const sinceMs = o.days ? Date.now() - o.days * 86400000 : undefined;
  const files = T.locate({ baseDir: o.baseDir, project: o.project, sinceMs });
  const byDay = new Map();
  for (const f of files) {
    for await (const e of T.readEntries(f.file)) {
      if (!T.isMainLoop(e) || e.type !== 'user') continue;
      if (!e.timestamp || typeof e.timestamp !== 'string') continue;
      const src = e.promptSource;
      if (src !== 'typed' && src !== 'queued') continue;
      const t = Date.parse(e.timestamp);
      if (sinceMs !== undefined && (Number.isNaN(t) || t < sinceMs)) continue;
      const day = Number.isNaN(t) ? e.timestamp.slice(0, 10) : W.dayKey(t);
      if (!byDay.has(day)) byDay.set(day, { typed: 0, queued: 0 });
      byDay.get(day)[src]++;
    }
  }
  return [...byDay.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([date, d]) => {
    const total = d.typed + d.queued;
    return { date, typed: d.typed, queued: d.queued, total, interruptRate: total ? Math.round((d.queued / total) * 1000) / 10 : 0 };
  });
}

function printInterrupt(daily) {
  console.log('=== ccsendstats --daily --interrupt ===');
  if (!daily.length) { console.log(L('(no prompts recorded)', '(記録されたプロンプトなし)')); return; }
  for (const d of daily) {
    console.log(`  ${d.date}  ${pad(`${d.interruptRate}%`, 6)}  (${d.queued}/${d.total} ${L('queued', '実行中に送信')})`);
  }
}

async function main() {
  const o = parseArgs(process.argv);
  if (o.daily && o.breakdown) {
    const b = await collectBreakdown(o);
    if (o.json) { console.log(JSON.stringify(b, null, 2)); return; }
    printBreakdown(b);
    return;
  }
  if (o.daily && o.cache) {
    const daily = await collectCache(o);
    if (o.json) { console.log(JSON.stringify({ daily }, null, 2)); return; }
    printCache(daily);
    return;
  }
  if (o.daily && o.baseline) {
    const daily = await collectBaseline(o);
    if (o.json) { console.log(JSON.stringify({ daily }, null, 2)); return; }
    printBaseline(daily);
    return;
  }
  if (o.daily && o.interrupt) {
    const daily = await collectInterrupt(o);
    if (o.json) { console.log(JSON.stringify({ daily }, null, 2)); return; }
    printInterrupt(daily);
    return;
  }
  if (o.daily) {
    const daily = await collectDaily(o);
    if (o.json) { console.log(JSON.stringify({ knownWindows: W.KNOWN_WINDOWS, daily }, null, 2)); return; }
    printDaily(daily);
    return;
  }
  const info = resolveSession(o);
  if (!info) {
    console.error(L('no transcripts found', 'transcript が見つかりません'));
    process.exit(1);
  }
  const entries = await loadEntries(info.file);
  const a = W.analyze(entries);

  if (o.json) {
    const out = { session: info.session, project: T.projectName(info.projectDir), ...a };
    if (o.diff) out.diffLast = W.diffLast(entries);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  printOverview(info, a);
  if (o.turns) printTurns(a, o.turns);
  if (o.diff) printDiff(W.diffLast(entries));
}

main().catch((e) => { console.error('ccsendstats:', e.message); process.exit(1); });
