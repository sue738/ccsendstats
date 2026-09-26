/**
 * sendstats.js — ccsendstats の解析ロジック(純関数・依存ゼロ・完全テスト可能)。
 *
 * 設計の要:
 * - 「総送信トークン」は transcript に記録された API usage の実測値
 *   (input + cache_read + cache_creation)。ここは概算ではない。
 * - 「内訳」は transcript に写っている中身からのバイト概算(≈4 bytes/token)。
 *   system prompt とツール定義はメッセージとしては transcript に写らないので、
 *   実測総量 − 可視分の概算 = 不可視オーバーヘッド、として導出する。
 *   attachment 行は rendered(送った文字列)があるものだけ可視に数える(attachmentTexts)。
 * - assistant エントリは同一 message.id が複数行に分かれ usage が重複するため、
 *   リクエスト集計は message.id で必ず重複排除する。
 */
'use strict';

const T = require('./vendor/transcript.js');

// No field in the transcript records which context window applied to a given
// call, so a fixed constant was tried first (200,000, Claude's legacy
// window) — real data immediately falsified it: peaks came back at 450-500%
// on every single day, never once near 100%, which a wrong denominator
// explains and an actual overflow does not (a request that big would have
// forced auto-compact long before reaching it). ~/.claude.json confirms
// 200,000 and 1,000,000 are both real, currently-configured window tiers
// (tengu_amber_moleskin) — so instead of guessing one constant, infer per
// batch of turns from a hard physical lower bound: the window can never be
// smaller than the largest request actually sent through it.
const KNOWN_WINDOWS = [200000, 1000000];
function inferWindow(peakTokens) {
  return KNOWN_WINDOWS.find((w) => w >= peakTokens) || KNOWN_WINDOWS[KNOWN_WINDOWS.length - 1];
}
/**
 * Local calendar day 'YYYY-MM-DD' of a ms timestamp. Transcript timestamps
 * are UTC; slicing the ISO string named the UTC day, so east of UTC anything
 * before the offset hour (09:00 in Tokyo) landed on the day before.
 */
function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function pctOfWindow(tokens, window) { return +((tokens / window) * 100).toFixed(1); }

/** バイト長からの概算トークン(英語主体 ≈ 4 bytes/token)。実トークナイザではない。 */
function estTokens(s) {
  if (!s) return 0;
  return Math.round(Buffer.byteLength(String(s), 'utf8') / 4);
}

/*
 * User turns Claude Code writes itself are not your words: background-task
 * reports (<task-notification>, promptSource 'system'/'sdk'), slash-command
 * echoes, and bash-mode (`!cmd`) input/output. They used to fall into
 * "your own words", and a session opened with `!ls` reported that as your
 * first message. bash-input is typed by a person but asks the model nothing,
 * so it is runtime context here too (the same rule as agstats).
 */
const INJECTED_RE = /<system-reminder>[\s\S]*?<\/system-reminder>|<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>|<local-command-(?:std(?:out|err)|caveat)>[\s\S]*?<\/local-command-(?:std(?:out|err)|caveat)>|<(task-notification|bash-(?:input|stdout|stderr)|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;

/** テキストを { injected, rest } に分ける(リマインダ・フック・コマンドエコー vs 本文)。 */
function splitInjected(text) {
  let injected = '';
  const rest = String(text == null ? '' : text).replace(INJECTED_RE, (m) => { injected += m; return ''; });
  return { injected, rest: rest.trim() };
}

/*
 * `type: "attachment"` lines. Newer Claude Code (seen from 2.1.263) writes
 * the context it adds to a request — skill listings, MCP instructions,
 * deferred-tool and agent lists, CLAUDE.md / memory, edited-file snippets,
 * date and token reminders, queued prompts — as attachment lines, not inside
 * a user message. They were skipped, so all of it landed in "invisible
 * overhead" (~210k tokens in one real session).
 *
 * The rule: an attachment counts only through its `rendered` list — each
 * item's `content` is the text that went into the request (on the author's
 * machine every one is a <system-reminder>, none repeats a user message's
 * text). No `rendered`, no count: that covers client-side state the model
 * never reads (prompt_snapshot — Claude Code's own copy of the system prompt
 * and tool schemas, which the request carries as system/tools, not as a
 * message — deferred_tools_record, credential_org, hook_success,
 * batching_reminder_sent, thinking_drop …) and every attachment written
 * before `rendered` existed. Those older ones were sent, but guessing their
 * wire text from the structured fields would be inventing it, so they stay
 * in the remainder: undercount, never invent. Each item is estimated on its
 * own (per-block rounding), and it all goes to `injected` — a prompt you
 * queued while a turn ran arrives this way too, wrapped in a reminder, so it
 * is counted as injected rather than as your words. Same rule as agstats.
 */
function attachmentTexts(e) {
  if (!e || e.type !== 'attachment' || !Array.isArray(e.rendered)) return [];
  const out = [];
  for (const r of e.rendered) {
    const c = r && r.content;
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) out.push(c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n'));
  }
  return out;
}

function resultText(b) {
  const c = b && b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && x.text) || '').join('\n');
  return '';
}

/**
 * API リクエスト一覧(= usage を持つ main-loop の assistant メッセージ、message.id で重複排除)。
 * 各要素: { id, entryIndex, ts, model, realIn, uncached, cacheRead, cacheWrite,
 *          cacheWrite1h, cacheWrite5m, out }
 * realIn は usage 由来の実測値。cacheWrite1h/5m は cacheWrite の内訳(TTL別)。
 */
function requestsOf(entries) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!T.isMainLoop(e) || !T.isAssistant(e)) continue;
    const m = e.message || {};
    const u = m.usage;
    if (!u) continue;
    const id = m.id || e.uuid || String(i);
    if (seen.has(id)) continue;
    seen.add(id);
    const uncached = u.input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const cacheWrite = u.cache_creation_input_tokens || 0;
    // cache_creation_input_tokens 自体はTTL別の内訳を持たない(1h/5mの合計値)。
    // 内訳は usage.cache_creation にだけ入っている — 無ければ古いレスポンス
    // 形式か非対応で、cacheWrite全体を5m(デフォルトTTL)側に落とす。
    const cc = u.cache_creation || {};
    const cacheWrite1h = cc.ephemeral_1h_input_tokens || 0;
    const cacheWrite5m = cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null
      ? (cc.ephemeral_5m_input_tokens || 0)
      : cacheWrite;
    out.push({
      id,
      entryIndex: i,
      ts: e.timestamp || null,
      model: m.model || '',
      realIn: uncached + cacheRead + cacheWrite,
      uncached,
      cacheRead,
      cacheWrite,
      cacheWrite1h,
      cacheWrite5m,
      out: u.output_tokens || 0,
    });
  }
  return out;
}

const EMPTY_BREAKDOWN = () => ({
  userText: 0,       // ユーザーが実際に打った(あるいは貼った)本文
  injected: 0,       // system-reminder・フック・コマンドエコー・attachment(rendered)等の注入分
  toolResults: 0,    // ツール実行結果
  assistantText: 0,  // アシスタントの本文
  thinking: 0,       // thinking ブロック(同一モデル継続時は再送される)
  toolInputs: 0,     // tool_use の入力 JSON
  total: 0,
});

/**
 * transcript に写っている中身のカテゴリ別概算トークン。
 * `upto` を渡すとそのエントリ index 未満だけを集計(ターン間 diff 用)。
 */
function visibleBreakdown(entries, upto) {
  const b = EMPTY_BREAKDOWN();
  const end = upto == null ? entries.length : Math.min(upto, entries.length);
  for (let i = 0; i < end; i++) {
    const e = entries[i];
    if (!T.isMainLoop(e)) continue;
    if (e.type === 'attachment') {
      for (const t of attachmentTexts(e)) b.injected += estTokens(t);
    } else if (T.isUser(e)) {
      const content = (e.message || {}).content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : T.blocksOf(e);
      for (const blk of blocks) {
        if (blk.type === 'tool_result') b.toolResults += estTokens(resultText(blk));
        else if (blk.type === 'text') {
          const { injected, rest } = splitInjected(blk.text);
          b.injected += estTokens(injected);
          b.userText += estTokens(rest);
        }
      }
    } else if (T.isAssistant(e)) {
      for (const blk of T.blocksOf(e)) {
        if (blk.type === 'text') b.assistantText += estTokens(blk.text);
        else if (blk.type === 'thinking') b.thinking += estTokens(blk.thinking);
        else if (blk.type === 'tool_use') b.toolInputs += estTokens(JSON.stringify(blk.input || {}));
      }
    }
  }
  b.total = b.userText + b.injected + b.toolResults + b.assistantText + b.thinking + b.toolInputs;
  return b;
}

/** 最初の「人間のプロンプト」の概算トークン(注入分を除いた本文)。 */
function firstPromptEst(entries) {
  for (const e of entries) {
    if (!T.isMainLoop(e) || !T.isUser(e)) continue;
    const content = (e.message || {}).content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : T.blocksOf(e);
    let text = '';
    for (const blk of blocks) {
      if (blk.type === 'text') text += splitInjected(blk.text).rest;
      if (blk.type === 'tool_result') return null; // ツール結果ターンは人間の発話ではない
    }
    if (text.trim()) return { est: estTokens(text), chars: text.trim().length };
  }
  return null;
}

/**
 * セッション全体の解析。
 * - requests: 実測トークン付きの全リクエスト
 * - visible: 全期間の可視カテゴリ概算
 * - baseline: 最初のリクエストで「最初の一言の前に」送られた実測トークン
 * - invisible: 最終リクエストの実測総量 − 可視概算(= system prompt・ツール定義など)
 */
function analyze(entries) {
  const requests = requestsOf(entries);
  const last = requests[requests.length - 1] || null;
  const first = requests[0] || null;
  const visible = last ? visibleBreakdown(entries, last.entryIndex) : visibleBreakdown(entries);
  const prompt = firstPromptEst(entries);
  const baseline = first ? Math.max(0, first.realIn - (prompt ? prompt.est : 0)) : null;
  const invisible = last ? Math.max(0, last.realIn - visible.total) : null;
  return { requests, visible, firstPrompt: prompt, baseline, invisible, last, first };
}

/**
 * 直近2リクエスト間の差分: カテゴリ別の増分と、新しく現れた大きなブロック。
 */
function diffLast(entries) {
  const requests = requestsOf(entries);
  if (requests.length < 2) return null;
  const prev = requests[requests.length - 2];
  const last = requests[requests.length - 1];
  const before = visibleBreakdown(entries, prev.entryIndex);
  const after = visibleBreakdown(entries, last.entryIndex);
  const delta = {};
  for (const k of Object.keys(EMPTY_BREAKDOWN())) delta[k] = after[k] - before[k];

  const newBlocks = [];
  for (let i = prev.entryIndex; i < last.entryIndex; i++) {
    const e = entries[i];
    if (!T.isMainLoop(e)) continue;
    if (e.type === 'attachment') {
      const kind = `attachment:${(e.attachment && e.attachment.type) || '?'}`;
      for (const text of attachmentTexts(e)) {
        const est = estTokens(text);
        if (est >= 200) newBlocks.push({ kind, est, preview: String(text).replace(/\s+/g, ' ').slice(0, 80) });
      }
      continue;
    }
    const blocks = T.isUser(e) && typeof (e.message || {}).content === 'string'
      ? [{ type: 'text', text: e.message.content }]
      : T.blocksOf(e);
    for (const blk of blocks) {
      let kind = null; let text = '';
      if (blk.type === 'tool_result') { kind = 'tool_result'; text = resultText(blk); }
      else if (blk.type === 'text') { kind = T.isUser(e) ? 'user_text' : 'assistant_text'; text = blk.text || ''; }
      else if (blk.type === 'tool_use') { kind = `tool_use:${blk.name || '?'}`; text = JSON.stringify(blk.input || {}); }
      else continue;
      const est = estTokens(text);
      if (est >= 200) newBlocks.push({ kind, est, preview: String(text).replace(/\s+/g, ' ').slice(0, 80) });
    }
  }
  newBlocks.sort((a, b) => b.est - a.est);
  return { prev, last, realDelta: last.realIn - prev.realIn, delta, newBlocks: newBlocks.slice(0, 8) };
}

module.exports = {
  estTokens, splitInjected, attachmentTexts, requestsOf, visibleBreakdown, firstPromptEst, analyze, diffLast,
  KNOWN_WINDOWS, inferWindow, pctOfWindow, dayKey,
};
