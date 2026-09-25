# ccsendstats 🔌

**See what your Claude Code session actually sends to the API — and how much of it you never wrote.**

`ccusage` tells you how much you spent. ccsendstats tells you **what each
request was made of** — and how much of it you never wrote. Different question,
different numbers: the per-category split, per-request context-window fill, and
the 1h/5m cache-write split ([which `ccusage` does not report](#--daily---cache-what-rate-is-your-input-actually-billed-at))
all live here, not there.

Every request re-sends the system prompt, every tool definition, and the whole
conversation so far. You see none of that. People noticed — and got loud about
it: *"Claude Code sends 33k tokens before reading the prompt."* ccsendstats answers
the question locally, from your own transcripts:

```
$ ccsendstats

ccsendstats — 657fb6c1 · private · 142 requests · claude-fable-5

Last request: 184,230 tokens sent (real, from API usage)
  cache: 91.2% cache-read · 7.9% cache-write · 0.9% uncached

  visible in transcript (est.): 121,400  65.9%
    tool results                          88,100   47.8%
    assistant text                        14,200    7.7%
    thinking blocks                        6,800    3.7%
    tool call inputs                       5,900    3.2%
    injected context (reminders, hooks)    4,300    2.3%
    your own words                         2,100    1.1%
  invisible overhead (est.): 62,830  34.1%
    system prompt + tool definitions + anything not recorded in the transcript

First request: 34,979 tokens went out before your first message (your message: 66 chars ≈ 17 tok)
```

That last line is the point: the gap between what you typed and what went out
is measured from your own data, not from a blog post.

> Also for Codex CLI, Gemini CLI and Cursor: [agstats](https://github.com/sue738/agstats) reads every agent's transcripts side by side (`npx agstats sends`).

## Honest limitations — read this first

- **Totals are real; the breakdown is an estimate.** Per-request totals come
  from the API `usage` fields recorded in the transcript (input +
  cache-read + cache-creation) — those are the provider's own numbers. The
  category split uses a byte-based estimate (~4 bytes/token), not a real
  tokenizer, so category lines are approximate and "visible" vs "invisible"
  can be off by a few percent.
- **It reads transcripts, not the wire.** The default command does not proxy or
  capture network traffic. Anything that never lands in
  `~/.claude/projects/**/*.jsonl` (the system prompt itself, tool schemas) is
  inferred as the remainder, not observed. It's the zero-setup 95% answer.
- **Thinking blocks** are counted as visible history (they are re-sent when a
  session continues on the same model).

## Install / run

```sh
npm install -g ccsendstats
```

Or run it once without installing: `npx ccsendstats`. To build from source:
`git clone https://github.com/sue738/ccsendstats.git && cd ccsendstats && npm link`.

```bash
ccsendstats                      # latest session of the project you're in
ccsendstats 657f                 # session by id prefix
ccsendstats --turns 10          # last 10 requests: real tokens, growth per turn
ccsendstats --diff              # what the last request added (and the biggest new blocks)
ccsendstats --json              # everything, machine-readable
ccsendstats --daily             # cross-session: peak/avg request size per day, as % of window
ccsendstats --daily --days 7    # last 7 days only
ccsendstats --daily --breakdown # cross-session: category share (where the budget actually goes)
ccsendstats --daily --cache     # cross-session: billing-rate mix (uncached/cache-write-1h/5m/cache-read)
ccsendstats --daily --baseline  # cross-session: avg tokens sent before your first word, by day
```

Output language: English by default, Japanese when your locale is `ja`
(`CCSENDSTATS_LANG=ja|en` to force).

### `--daily`: how close did you get to auto-compact?

A single session's turns tell you what one conversation sent. `--daily` scans
every session and buckets requests by day, reporting the peak and average
request size as a percentage of the context window — the number that predicts
whether the next tool result risks tripping auto-compact.

The window itself is never recorded in a transcript, so it's inferred per day
from the data: the smallest of 200,000 / 1,000,000 tokens that's still at
least as big as that day's largest request actually sent. A fixed 200,000
guess was tried first and immediately falsified by real data — every day came
back at 450-500%, which a wrong denominator explains and an actual overflow
does not (a request that size would have forced auto-compact long before
reaching it).

### `--daily --breakdown`: where does the waste actually come from?

`--daily` tells you how full the window got. It doesn't say why. `--breakdown`
sums each session's own category breakdown (tool results, injected context,
thinking, tool inputs, your words, invisible overhead) across every session in
range, so you get one aggregate share per category — the number that tells you
what to actually go fix (large tool results → narrow your reads/greps; high
injected → a hook is noisy; high invisible overhead → too many tool
definitions on the wire).

Reuses the same estimate `ccsendstats`'s single-session view already makes — no new
guessing logic — but it reads full session content instead of just the usage
totals `--daily` needs, so it's slower over a long `--days` range.

### `--daily --cache`: what rate is your input actually billed at?

Same "input" total, different axis: not what it's made of, but what it costs.
Every request's input tokens land in one of four buckets — uncached, a fresh
cache write (1h or 5m TTL), or a cache read — and each has its own price.
`--cache` sums those per day across every session, as a percentage of that
day's total input.

`ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` aren't in `ccusage`'s
own breakdown (it only reports a combined `cacheCreationTokens`) — this reads
`usage.cache_creation` straight out of the transcript for the split.

### `--daily --baseline`: is your always-on overhead growing?

`baseline` (from the single-session view: tokens sent *before* your first
word) isolates the part of every request that has nothing to do with what
you're actually saying — system prompt, `CLAUDE.md`, memory files, tool and
skill definitions. `--daily --baseline` averages it across every new session
per day, so a rising line means that fixed cost is genuinely growing (a memory
file getting bigger, more skills installed), not that a conversation just
got longer. On real data this moved from ~33k to ~52k tokens over 9 days —
actual movement, not noise.

## The other 5%: `ccsendstats proxy`

The transcript never records the system prompt or the tool schemas — they're
resent on every request but never written to disk. The only way to see those
bytes is to actually watch the traffic:

```bash
ccsendstats proxy &                                   # observe on :8789
ANTHROPIC_BASE_URL=http://localhost:8789 claude   # use Claude Code as usual
ccsendstats proxy-report                               # what it saw
```

Byte-for-byte passthrough — nothing is modified, auth headers are never
logged. Binds to `127.0.0.1` only and rejects anything but requests to
its own forward target, so nothing else on your network can reach or
relay through it. This needs the session actually routed through it,
which is real friction, so reach for it only when the default command's
estimate isn't enough and you need the literal number.

## Why you'd run it

- **"What am I actually paying for?"** — see the cache-read share (cheap) vs
  fresh tokens per request.
- **"Why is my context so big?"** — the category table names the culprit
  (usually tool results, not your prompts).
- **"What is being sent that I didn't write?"** — invisible overhead +
  injected-context lines quantify exactly that, per session.

## Security & trust

A tool that inspects your sessions deserves maximum suspicion, so:

- **Zero dependencies, no postinstall, no build step** — read it first, it's short
- **Fully local** — nothing leaves your machine, no telemetry
- **Read-only** — it never modifies a transcript (`ccsendstats proxy` is the one
  opt-in exception: it relays your own traffic to the API, bound to
  `127.0.0.1` only)
- Paranoid path: `git clone https://github.com/sue738/ccsendstats.git && node ccsendstats/bin/ccsendstats.js`
