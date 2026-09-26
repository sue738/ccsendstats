/** test.js — ccsendstats の解析ロジックと CLI を fixture で検証(環境非依存)。 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const W = require('../lib/sendstats.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n); } };

// ---------------------------------------------------------------- fixture
// 2リクエスト構成。assistant は同一 message.id の分割エントリを含む(重複排除の検証)。
const A = 'a'.repeat(400);   // est 100 tok
const RESULT = 'r'.repeat(2000); // est 500 tok
const entries = [
  { type: 'user', message: { role: 'user', content: 'hello world, please do the thing' }, timestamp: 't0' },
  { type: 'assistant', timestamp: 't1',
    message: { id: 'm1', model: 'claude-test', usage: { input_tokens: 100, cache_creation_input_tokens: 30000, cache_read_input_tokens: 0, output_tokens: 50 },
      content: [{ type: 'text', text: A }] } },
  { type: 'assistant', timestamp: 't1',
    message: { id: 'm1', model: 'claude-test', usage: { input_tokens: 100, cache_creation_input_tokens: 30000, cache_read_input_tokens: 0, output_tokens: 50 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hi' } }] } },
  { type: 'user', timestamp: 't2', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu1', content: RESULT },
    { type: 'text', text: '<system-reminder>' + 'x'.repeat(396) + '</system-reminder>real user words here' },
  ] } },
  { type: 'assistant', timestamp: 't3',
    message: { id: 'm2', model: 'claude-test', usage: { input_tokens: 5, cache_creation_input_tokens: 800, cache_read_input_tokens: 30100, output_tokens: 20 },
      content: [{ type: 'thinking', thinking: 'hmm'.repeat(40) }, { type: 'text', text: 'done' }] } },
  // sidechain と meta は無視されること
  { type: 'assistant', isSidechain: true, message: { id: 'm3', usage: { input_tokens: 9999 }, content: [] } },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } },
];

console.log('== estTokens / splitInjected ==');
ok('4 bytes ≈ 1 token', W.estTokens('abcd') === 1);
ok('empty → 0', W.estTokens('') === 0);
const sp = W.splitInjected('<system-reminder>abc</system-reminder>hello');
ok('injected 分離', sp.injected.includes('abc') && sp.rest === 'hello');
ok('command echo も injected', W.splitInjected('<command-name>/x</command-name>y').injected.includes('/x'));
{
  // Claude Code が自分で書く user ターンは「あなたの言葉」ではない
  const tn = W.splitInjected('<task-notification><task-id>t1</task-id>done</task-notification>');
  ok('★task-notification は injected(あなたの言葉に入れない)', tn.rest === '' && tn.injected.includes('t1'));
  const bi = W.splitInjected('<bash-input>ls -la</bash-input>');
  ok('★bash-input / bash-stdout も injected', bi.rest === '' && W.splitInjected('<bash-stdout>out</bash-stdout><bash-stderr></bash-stderr>').rest === '');
  ok('★local-command-caveat も injected', W.splitInjected('<local-command-caveat>Caveat: x</local-command-caveat>').rest === '');
  const rt = [
    { type: 'user', timestamp: '2026-09-01T00:00:00Z', message: { role: 'user', content: '<bash-input>ls -la</bash-input>' } },
    { type: 'user', timestamp: '2026-09-01T00:00:01Z', message: { role: 'user', content: '<bash-stdout>' + 'x'.repeat(400) + '</bash-stdout>' } },
    { type: 'user', timestamp: '2026-09-01T00:00:02Z', promptSource: 'typed', message: { role: 'user', content: 'hi there' } },
    { type: 'user', timestamp: '2026-09-01T00:00:03Z', promptSource: 'system', message: { role: 'user', content: '<task-notification>' + 'y'.repeat(4000) + '</task-notification>' } },
  ];
  ok('★最初の一言は runtime の行を飛ばした人間の発話', W.firstPromptEst(rt).chars === 'hi there'.length);
  const rv = W.visibleBreakdown(rt);
  ok('★あなたの言葉は人間の発話だけ', rv.userText === W.estTokens('hi there') && rv.injected > 1000);
}

console.log('== requestsOf ==');
const reqs = W.requestsOf(entries);
ok('message.id で重複排除して2件', reqs.length === 2);
ok('実測 realIn = in + read + write', reqs[0].realIn === 30100 && reqs[1].realIn === 30905);
ok('sidechain の usage は数えない', !reqs.some((r) => r.realIn === 9999));
ok('entryIndex 付与', reqs[0].entryIndex === 1 && reqs[1].entryIndex === 4);
ok('usage.cache_creation が無ければcacheWrite全額を5m側にfallback', reqs[0].cacheWrite5m === 30000 && reqs[0].cacheWrite1h === 0);
{
  const t = W.requestsOf([{ type: 'assistant', message: { id: 'ttl1', usage: {
    input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1,
    cache_creation_input_tokens: 700,
    cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 200 },
  } } }]);
  ok('usage.cache_creationがあれば1h/5mを個別に読む', t[0].cacheWrite1h === 500 && t[0].cacheWrite5m === 200);
}

console.log('== visibleBreakdown ==');
const vis = W.visibleBreakdown(entries);
ok('tool_result ≈ 500', Math.abs(vis.toolResults - 500) <= 1);
ok('assistant text > 0', vis.assistantText >= 100);
ok('thinking > 0', vis.thinking > 0);
ok('injected(リマインダ)を分離集計', vis.injected >= 100 && vis.injected < 130);
ok('userText はリマインダ除外後', vis.userText > 0 && vis.userText < 20);
ok('meta は数えない', !JSON.stringify(vis).includes('meta'));
ok('total = 各カテゴリ合計', vis.total === vis.userText + vis.injected + vis.toolResults + vis.assistantText + vis.thinking + vis.toolInputs);
const visUpto = W.visibleBreakdown(entries, 1);
ok('upto で範囲集計', visUpto.toolResults === 0 && visUpto.userText > 0);

console.log('== analyze ==');
const a = W.analyze(entries);
ok('baseline = 初回実測 − 最初の一言概算', a.baseline === 30100 - W.estTokens('hello world, please do the thing'));
ok('firstPrompt の文字数', a.firstPrompt && a.firstPrompt.chars === 'hello world, please do the thing'.length);
ok('invisible = 最終実測 − 可視概算(clamp)', a.invisible === Math.max(0, 30905 - W.visibleBreakdown(entries, 4).total));
ok('last が2件目', a.last && a.last.id === 'm2');

console.log('== diffLast ==');
const d = W.diffLast(entries);
ok('実測デルタ', d.realDelta === 30905 - 30100);
ok('tool_result の増分を検出', d.delta.toolResults >= 499);
ok('新ブロック抽出(200tok 以上)', d.newBlocks.length >= 1 && d.newBlocks[0].kind === 'tool_result');
ok('preview は80文字以内', d.newBlocks.every((b) => b.preview.length <= 80));
ok('リクエスト1件では null', W.diffLast(entries.slice(0, 3)) === null);

console.log('== attachment 行(rendered だけが送信分) ==');
{
  // 新しい Claude Code は注入コンテキストを type:"attachment" 行に書く。
  // rendered[].content が実際にリクエストに入った文字列 — これだけを数える。
  const SK = '<system-reminder>' + 's'.repeat(783) + '</system-reminder>'; // 818 B → 205 tok (204.5 を丸め)
  const DT = '<system-reminder>' + 'd'.repeat(365) + '</system-reminder>'; // 400 B → 100 tok
  const at = [
    { type: 'user', timestamp: 't0', message: { role: 'user', content: 'go' } },
    { type: 'attachment', timestamp: 't0', attachment: { type: 'skill_listing', content: 'x'.repeat(5000), skillCount: 3 }, rendered: [{ content: SK }] },
    { type: 'attachment', timestamp: 't0', attachment: { type: 'deferred_tools_delta', addedNames: ['A'] }, rendered: [{ content: DT }, { content: DT }] },
    // rendered が無い: クライアント側の状態(system prompt の写し等)か、rendered 以前の版 — 数えない
    { type: 'attachment', timestamp: 't0', attachment: { type: 'prompt_snapshot', systemPrompt: ['p'.repeat(40000)], tools: [] } },
    { type: 'attachment', timestamp: 't0', attachment: { type: 'skill_listing', content: 'o'.repeat(4000) } },
    // サイドチェーン / meta の attachment も数えない
    { type: 'attachment', isSidechain: true, attachment: { type: 'date' }, rendered: [{ content: 'q'.repeat(4000) }] },
    { type: 'assistant', timestamp: 't1', message: { id: 'r1', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] } },
  ];
  ok('★attachmentTexts: rendered の各 content、rendered が無ければ空', W.attachmentTexts(at[2]).length === 2 && W.attachmentTexts(at[3]).length === 0 && W.attachmentTexts(at[0]).length === 0);
  const av = W.visibleBreakdown(at, 6);
  ok('★rendered 付き attachment は injected(項目ごとに丸め: 205 + 100 + 100)', av.injected === 405);
  ok('★rendered の無い attachment(prompt_snapshot・旧版)とサイドチェーンは数えない', av.total === 405 + W.estTokens('go'));
  const aa = W.analyze(at);
  ok('★invisible は attachment 分だけ減る', aa.invisible === 1010 - 405 - W.estTokens('go'));
  ok('attachment は最初の一言にならない', aa.firstPrompt.chars === 2);
  const ad = W.diffLast([at[0], at[6], ...at.slice(1, 6), { ...at[6], message: { ...at[6].message, id: 'r2' } }]);
  ok('diff: 大きな attachment は種別つきで新ブロックに出る', ad.delta.injected === 405 && ad.newBlocks[0].kind === 'attachment:skill_listing' && ad.newBlocks[0].est === 205);
}

console.log('== CLI ==');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsendstats-'));
const pdir = path.join(tmp, '-home-u-demo');
fs.mkdirSync(pdir, { recursive: true });
fs.writeFileSync(path.join(pdir, 'sess-fixture.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
const BIN = path.join(__dirname, '..', 'bin', 'ccsendstats.js');
const env = Object.assign({}, process.env, { CCSENDSTATS_LANG: 'en' });
const run = (args) => execFileSync('node', [BIN, '--base-dir', tmp, ...args], { encoding: 'utf8', env });

const outJson = JSON.parse(run(['sess', '--json']));
ok('--json: requests 2件', outJson.requests.length === 2);
ok('--json: invisible あり', typeof outJson.invisible === 'number');
const outText = run(['sess', '--turns', '5', '--diff']);
ok('実測総量を表示', outText.includes('30,905'));
ok('baseline 行を表示', outText.includes('before your first message'));
ok('invisible overhead を表示', outText.includes('invisible overhead'));
ok('turns 表を表示', outText.includes('Δ'));
const outJa = execFileSync('node', [BIN, '--base-dir', tmp, 'sess'], { encoding: 'utf8', env: Object.assign({}, process.env, { CCSENDSTATS_LANG: 'ja' }) });
ok('ja 指定で日本語ラベル', outJa.includes('最終リクエスト'));

fs.rmSync(tmp, { recursive: true, force: true });

console.log('== --daily ==');
ok('KNOWN_WINDOWS は200,000と1,000,000', W.KNOWN_WINDOWS.length === 2 && W.KNOWN_WINDOWS[0] === 200000 && W.KNOWN_WINDOWS[1] === 1000000);
ok('inferWindow: 200,000以内はそのまま', W.inferWindow(160000) === 200000);
ok('inferWindow: 超えたら1,000,000に切り上げ', W.inferWindow(200001) === 1000000);
ok('inferWindow: 1,000,000も超えたら最大値にclamp', W.inferWindow(1500000) === 1000000);
ok('pctOfWindow', W.pctOfWindow(100000, 200000) === 50 && W.pctOfWindow(0, 200000) === 0);

// 2セッション・2日にまたがる fixture。「今」基準の相対日付で作る — 固定日付だと
// テスト実行日によって --days のフィルタ結果がずれる(実行時のDate.now()次第で
// 「2日前」がそもそも1日以上前かどうかが変わる)。
// day1(2日前)のピークは160,050(80.025%→80%丸め)、day2(今)は40,100(20.1%)。
// sidechain のusageは数えない。
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsendstats-daily-'));
const pdir2 = path.join(tmp2, '-home-u-demo');
fs.mkdirSync(pdir2, { recursive: true });
const nowIso = new Date().toISOString();
const twoDaysAgoIso = new Date(Date.now() - 2 * 86400000).toISOString();
// buckets are local days (W.dayKey), not the UTC day of the ISO string
const day1Date = W.dayKey(Date.parse(twoDaysAgoIso));
const day2Date = W.dayKey(Date.parse(nowIso));
const day1 = [
  { type: 'assistant', timestamp: twoDaysAgoIso,
    message: { id: 'd1a', usage: { input_tokens: 100, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 50 } } },
  { type: 'assistant', timestamp: twoDaysAgoIso,
    message: { id: 'd1b', usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 160000, output_tokens: 50 } } },
  { type: 'assistant', isSidechain: true, timestamp: twoDaysAgoIso,
    message: { id: 'd1c', usage: { input_tokens: 999999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
];
const day2 = [
  { type: 'assistant', timestamp: nowIso,
    message: { id: 'd2a', usage: { input_tokens: 100, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 50 } } },
];
fs.writeFileSync(path.join(pdir2, 'sess-day1.jsonl'), day1.map((e) => JSON.stringify(e)).join('\n') + '\n');
fs.writeFileSync(path.join(pdir2, 'sess-day2.jsonl'), day2.map((e) => JSON.stringify(e)).join('\n') + '\n');
const runDaily = (args) => execFileSync('node', [BIN, '--base-dir', tmp2, '--daily', ...args], { encoding: 'utf8', env });

const daily = JSON.parse(runDaily(['--json'])).daily;
ok('2日分のバケット', daily.length === (day1Date === day2Date ? 1 : 2));
if (day1Date !== day2Date) {
  ok('day1のピークは160,050(200,000窓で80%)', daily[0].date === day1Date && daily[0].peakTokens === 160050 && daily[0].window === 200000 && daily[0].peakPct === 80);
  ok('day1の平均は2ターン分(sidechain除外)', daily[0].turns === 2 && daily[0].avgTokens === Math.round((40100 + 160050) / 2));
  ok('day1のp50は偶数個なので中央2件の平均(avgと一致)', daily[0].p50Tokens === Math.round((40100 + 160050) / 2));
  ok('day2は1ターンのみ・200,000窓で20.1%', daily[1].date === day2Date && daily[1].turns === 1 && daily[1].window === 200000 && daily[1].peakPct === 20.1);
}
const dailyText = runDaily([]);
ok('テキスト表示に推定窓を明記', dailyText.includes('推定窓') || dailyText.includes('window'));
if (day1Date !== day2Date) ok('日付でソートして表示', dailyText.indexOf(day1Date) < dailyText.indexOf(day2Date));
ok('テキスト表示にp25/p50/p75列を明記', dailyText.includes('p25') && dailyText.includes('p50') && dailyText.includes('p75'));

const daily1d = JSON.parse(execFileSync('node', [BIN, '--base-dir', tmp2, '--daily', '--days', '1', '--json'], { encoding: 'utf8', env })).daily;
ok('--days でフィルタ(2日前を除外)', daily1d.length === 1 && daily1d[0].date === day2Date);

fs.rmSync(tmp2, { recursive: true, force: true });

// p50はavgと違う値になるべき — 少数の巨大ターンに引きずられないことの検証。
// 1回だけ長いセッション(context 190,000まで線形に育つ19ターン)+短いセッション
// 多数(context 2,000で1ターンずつ×10) という、実データが示していた
// 「長いセッションが平均を吊り上げる」構図を小さく再現する。
const tmp2b = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsendstats-p50-'));
const pdir2b = path.join(tmp2b, '-home-u-demo');
fs.mkdirSync(pdir2b, { recursive: true });
const longSession = Array.from({ length: 19 }, (_, i) => ({
  type: 'assistant', timestamp: nowIso,
  message: { id: `long${i}`, usage: { input_tokens: 0, cache_read_input_tokens: (i + 1) * 10000, cache_creation_input_tokens: 0, output_tokens: 1 } },
}));
const shortSessions = Array.from({ length: 10 }, (_, i) => ({
  type: 'assistant', timestamp: nowIso,
  message: { id: `short${i}`, usage: { input_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 1 } },
}));
fs.writeFileSync(path.join(pdir2b, 'sess-long.jsonl'), longSession.map((e) => JSON.stringify(e)).join('\n') + '\n');
fs.writeFileSync(path.join(pdir2b, 'sess-short.jsonl'), shortSessions.map((e) => JSON.stringify(e)).join('\n') + '\n');
const p50Daily = JSON.parse(execFileSync('node', [BIN, '--base-dir', tmp2b, '--daily', '--json'], { encoding: 'utf8', env })).daily;
ok('29ターン集計', p50Daily[0].turns === 29);
// 値: 2000×10 + 10000,20000,...,190000。ソート済み29件の中央値(15番目, 0-index14)は
// 2000(10件)の次から数えて5番目の長セッション値=50000。
ok('p50は多数派(短いセッション寄り)に近い値', p50Daily[0].p50Tokens === 50000);
ok('avgはp50より大きい(長いセッションの後半に引きずられる)', p50Daily[0].avgTokens > p50Daily[0].p50Tokens);
// window=200,000(peak=190,000は200,000以内)。p25はidx=floor(0.25*28)=7→2000
// (短いセッション側)。p75はidx=floor(0.75*28)=21→120,000(長いセッション側)。
ok('p25は短いセッション側(1%)', p50Daily[0].p25Pct === 1);
ok('p75は長いセッション側(60%)、p25<p50<p75の順', p50Daily[0].p75Pct === 60
  && p50Daily[0].p25Pct < p50Daily[0].p50Pct && p50Daily[0].p50Pct < p50Daily[0].p75Pct);
fs.rmSync(tmp2b, { recursive: true, force: true });

// 実データでの発見(実測: 全日の peak が450-500%で固定表示されていた)を再現する
// 回帰テスト — 200,000を超えるリクエストが実在した日は、1,000,000窓に切り替わり
// 100%を超えないこと。
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsendstats-daily-big-'));
const pdir3 = path.join(tmp3, '-home-u-demo');
fs.mkdirSync(pdir3, { recursive: true });
const bigDay = [
  { type: 'assistant', timestamp: nowIso,
    message: { id: 'e1', usage: { input_tokens: 2, cache_read_input_tokens: 460000, cache_creation_input_tokens: 0, output_tokens: 100 } } },
];
fs.writeFileSync(path.join(pdir3, 'sess-big.jsonl'), bigDay.map((e) => JSON.stringify(e)).join('\n') + '\n');
const bigDaily = JSON.parse(execFileSync('node', [BIN, '--base-dir', tmp3, '--daily', '--json'], { encoding: 'utf8', env })).daily;
ok('200,000超のリクエストがある日は1,000,000窓に切替', bigDaily[0].window === 1000000);
ok('切替後は100%を超えない(実データの回帰: 修正前は466%と表示されていた)', bigDaily[0].peakPct === 46 && bigDaily[0].peakPct <= 100);
fs.rmSync(tmp3, { recursive: true, force: true });

console.log('== --daily --breakdown ==');
// 既存の entries fixture(2リクエスト、analyze()で既に検証済み)を1セッションだけ
// 置いて実行 — 集計ロジックは analyze() をそのまま合算するだけなので、期待値は
// 独自に計算せず a.visible / a.invisible / a.last.realIn を直接使う。
const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsendstats-breakdown-'));
const pdir4 = path.join(tmp4, '-home-u-demo');
fs.mkdirSync(pdir4, { recursive: true });
fs.writeFileSync(path.join(pdir4, 'sess-fixture.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
const b = JSON.parse(execFileSync('node', [BIN, '--base-dir', tmp4, '--daily', '--breakdown', '--json'], { encoding: 'utf8', env }));
ok('1セッションを集計', b.sessions === 1);
ok('分母は最終リクエストの実測値', b.totalReal === a.last.realIn);
const rowTokens = (key) => b.rows.find((r) => r.key === key).tokens;
ok('toolResultsがanalyze()と一致', rowTokens('toolResults') === a.visible.toolResults);
ok('invisibleがanalyze()と一致', rowTokens('invisible') === a.invisible);
ok('多い順にソート', b.rows[0].tokens >= b.rows[1].tokens);
const breakdownText = execFileSync('node', [BIN, '--base-dir', tmp4, '--daily', '--breakdown'], { encoding: 'utf8', env });
ok('テキスト表示にラベルを明記', breakdownText.includes('tool results') && breakdownText.includes('invisible overhead'));

console.log('== --daily --baseline ==');
// 同じ1セッションfixtureを再利用 — baselineの値自体は既に「== analyze ==」で
// 検証済みなので、ここでは日別集計(平均・件数・レンジ)が a.baseline を
// そのまま使っていることだけ確認する。
const baseline = JSON.parse(execFileSync('node', [BIN, '--base-dir', tmp4, '--daily', '--baseline', '--json'], { encoding: 'utf8', env })).daily;
ok('1セッション1日分', baseline.length === 1 && baseline[0].sessions === 1);
ok('avgBaselineはanalyze().baselineと一致', baseline[0].avgBaseline === a.baseline);
ok('min/maxも同じ値(1セッションだけなので)', baseline[0].minBaseline === a.baseline && baseline[0].maxBaseline === a.baseline);
const baselineText = execFileSync('node', [BIN, '--base-dir', tmp4, '--daily', '--baseline'], { encoding: 'utf8', env });
ok('テキスト表示に新規セッション数を明記', baselineText.includes('new sessions') || baselineText.includes('新規セッション'));
fs.rmSync(tmp4, { recursive: true, force: true });

console.log('== --daily --cache ==');
// 1日・2リクエスト: 非キャッシュ100+キャッシュ書込(1h:500/5m:200)+読込1000。
// 合計1800のうちそれぞれの%を検算する。
const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsendstats-cache-'));
const pdir5 = path.join(tmp5, '-home-u-demo');
fs.mkdirSync(pdir5, { recursive: true });
const cacheDay = [
  { type: 'assistant', timestamp: nowIso, message: { id: 'c1', usage: {
    input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 10,
    cache_creation_input_tokens: 700,
    cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 200 },
  } } },
];
fs.writeFileSync(path.join(pdir5, 'sess-cache.jsonl'), cacheDay.map((e) => JSON.stringify(e)).join('\n') + '\n');
const cacheDaily = JSON.parse(execFileSync('node', [BIN, '--base-dir', tmp5, '--daily', '--cache', '--json'], { encoding: 'utf8', env })).daily;
ok('1日分のバケット', cacheDaily.length === 1);
ok('非キャッシュ/1h/5m/読込の実数が一致', cacheDaily[0].uncached === 100 && cacheDaily[0].write1h === 500
  && cacheDaily[0].write5m === 200 && cacheDaily[0].read === 1000);
ok('%は合計1800に対する比率', cacheDaily[0].readPct === +((1000 / 1800 * 100).toFixed(1)));
const cacheText = execFileSync('node', [BIN, '--base-dir', tmp5, '--daily', '--cache'], { encoding: 'utf8', env });
ok('テキスト表示に列見出しを明記', cacheText.includes('write-1h') && cacheText.includes('write-5m'));
fs.rmSync(tmp5, { recursive: true, force: true });

console.log('== --daily --interrupt ==');
const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsendstats-interrupt-'));
const pdir6 = path.join(tmp6, '-home-u-demo');
fs.mkdirSync(pdir6, { recursive: true });
const interruptDay = [
  { type: 'user', timestamp: nowIso, isSidechain: false, promptSource: 'typed', message: { role: 'user', content: 'a' } },
  { type: 'user', timestamp: nowIso, isSidechain: false, promptSource: 'queued', message: { role: 'user', content: 'b' } },
  { type: 'user', timestamp: nowIso, isSidechain: false, promptSource: 'typed', message: { role: 'user', content: 'c' } },
  // サブエージェント側は行動の主体が違うので除外(mainループのみ)
  { type: 'user', timestamp: nowIso, isSidechain: true, promptSource: 'queued', message: { role: 'user', content: 'd' } },
  // promptSourceが無い(古い形式・別由来)エントリは分母に入れない
  { type: 'user', timestamp: nowIso, isSidechain: false, message: { role: 'user', content: 'e' } },
];
fs.writeFileSync(path.join(pdir6, 'sess-interrupt.jsonl'), interruptDay.map((e) => JSON.stringify(e)).join('\n') + '\n');
const interruptDaily = JSON.parse(execFileSync('node', [BIN, '--base-dir', tmp6, '--daily', '--interrupt', '--json'], { encoding: 'utf8', env })).daily;
ok('1日分のバケット', interruptDaily.length === 1);
ok('typed/queuedの実数が一致(サブエージェント・promptSource欠落は除外)', interruptDaily[0].typed === 2 && interruptDaily[0].queued === 1 && interruptDaily[0].total === 3);
ok('interruptRateはqueued/totalの%', interruptDaily[0].interruptRate === +((1 / 3 * 100).toFixed(1)));
const interruptText = execFileSync('node', [BIN, '--base-dir', tmp6, '--daily', '--interrupt'], { encoding: 'utf8', env });
ok('テキスト表示にqueued件数を明記', interruptText.includes('queued') || interruptText.includes('実行中に送信'));
fs.rmSync(tmp6, { recursive: true, force: true });

console.log('== 日別の日付はローカル日(UTC ではない) ==');
{
  // 東京の 2026-09-20 08:00 は UTC では 19日 23:00
  const tmpTz = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsendstats-tz-'));
  const dir = path.join(tmpTz, '-home-u-tz');
  fs.mkdirSync(dir);
  const at = (s) => new Date(Date.parse('2026-09-19T23:00:00Z') + s * 1000).toISOString();
  const use = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 5 };
  fs.writeFileSync(path.join(dir, 'tz.jsonl'), [
    { type: 'user', timestamp: at(0), promptSource: 'typed', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', timestamp: at(1), message: { id: 'z1', model: 'x', usage: use, content: [{ type: 'text', text: 'ok' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const tzEnv = Object.assign({}, env, { TZ: 'Asia/Tokyo' });
  const day = (mode) => JSON.parse(execFileSync('node', [BIN, '--base-dir', tmpTz, '--daily', ...mode, '--json'], { encoding: 'utf8', env: tzEnv })).daily.map((d) => d.date).join(',');
  ok('★--daily は JST の当日(09-20)', day([]) === '2026-09-20');
  ok('★--daily --cache も', day(['--cache']) === '2026-09-20');
  ok('★--daily --baseline も', day(['--baseline']) === '2026-09-20');
  ok('★--daily --interrupt も', day(['--interrupt']) === '2026-09-20');
  fs.rmSync(tmpTz, { recursive: true, force: true });
}

console.log('== --days の誤りは拒否 ==');
{
  const code = (v) => { try { execFileSync('node', [BIN, '--base-dir', tmp, '--daily', '--days', v], { encoding: 'utf8', env, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  ok('★--days -3 は exit 2(「記録なし」に化けない)', code('-3') === 2);
  ok('★--days abc は exit 2(全期間に化けない)', code('abc') === 2);
  ok('--days 7 は通る', code('7') === 0);
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
