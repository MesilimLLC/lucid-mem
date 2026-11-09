# lucid-mem

**The memory layer for agents that do real work.**

[Mesalim LLC](https://github.com/mesalimllc)

AI coding agents are extraordinary inside one session and forget everything after it. lucid-mem gives them durable, git-backed memory that follows the work across sessions, repositories, and tools — automatically. It implements the [Agent Memory Repo spec](https://cognition.com/agent-memory-repo) and adds the harness that makes the loop trustworthy: deterministic retrieval, judged saves, reviewable maintenance, and a measured save rate.

We think memory is infrastructure, not a chat feature. That is the bet behind Mesalim LLC.

## The gap

Every team deploying agents hits the same wall: the agent rediscovers the architecture, re-learns a preference, and repeats a mistake it already fixed, because the context window ends and the knowledge goes with it. Longer context helps for an hour; it does not compound.

The market has plenty of transcript dumps, vector stores, and per-tool notes. They fail in predictable ways. Retrieval is fuzzy. Saving is unmeasured. Memory turns into an event log. Every host stores it differently. The hard problem is not storage — it is deciding what deserves to be remembered, keeping it clean as it grows, and proving the loop works.

## Why now

- Agents are moving from autocomplete to autonomous, multi-hour work, where context is the binding constraint.
- Context windows are getting larger and cheaper, but they still reset. Memory is how knowledge compounds.
- The host landscape has fragmented across a dozen tools. Memory that works everywhere is more valuable than another per-tool notes feature.

## What lucid-mem does

lucid-mem runs underneath the agent's normal workflow in four moves:

- **Retrieve deterministically.** Session-start hooks inject a ranked digest. No model judgment in the read path.
- **Save with judgment.** Host rules teach the agent what is durable; saving is one command, with secret checks and near-duplicate protection.
- **Maintain continuously.** Session-end work and scheduled dreams dedupe, compact, expire transient state, and queue ambiguous learnings for review.
- **Measure the result.** `amr coverage` replays transcripts, finds durable signals the agent missed, and reports a save rate. The loop is observable, not aspirational.

## The bounded-memory release

This release closes the loop on growth: entries expire by default, retired ones can leave zero trace, context ranks by relevance to the work at hand, and the store proposes its own merges before the digest budget runs out.

| Area | What shipped | Why it matters |
|---|---|---|
| **Quieter reflection** | `amr reflect` fires only after real work — six or more changing actions (edits, or shell commands that write, commit, or push), or twenty tool calls of any kind, which also catches investigation-only sessions — and runs as a detached background judge. Nothing prints in the session. | Memory improves without interrupting the person doing the work. |
| **Reviewable learning** | Judge proposals land in `dreams/pending-reflections.md` and surface at the next session. Adds can auto-save; updates always wait for review. Overflow/expired items archive to `dreams/reflection-archive.md` instead of being dropped. | The agent can learn without silently rewriting what you know. |
| **Kinds and expiry** | Entries carry `pitfall`, `decision`, `preference`, `fact`, `howto`, or `state`. Everything expires by default: `state` in two days, hosting/deploy facts in 14, other kinds in 30 (`--ttl N` overrides, `--durable` opts out). Expired entries drop out of context and recall; `amr update` renews the clock, and `dream --fix` renews recently used ones instead of dropping them. | Memory ages like knowledge does; nothing has to be manually swept. |
| **Stable identity** | Every entry gets a short id such as `a3f9`: `amr update <id>`, `amr supersede <id>`, `amr delete <id>`, `amr used <id>`, `amr ids`. | Memory can be corrected, retired, removed, and credited instead of appended forever. |
| **Ranked context** | `amr context` ranks by kind, recency (60-day half-life), explicit use, and relevance to the current work (project, cwd, branch, recent files, transcript tail) inside a shared 6,000-character budget (`--budget`, `contextBudget`). `--full` opts out. | The digest stays small and relevant as the corpus grows. |
| **Budget-pressure consolidation** | When a live file's entries cross ~80% of the digest budget, `amr add` and `amr dream` queue concrete merge/delete proposals (`[consolidate]` items) into the pending-candidates review queue instead of letting the next write silently rank out. | The store consolidates before it hits the wall, and nothing is rewritten without review. |
| **Backlog triage** | `amr dream --triage` asks the judge to keep, rewrite, or archive legacy state-like entries. It writes a plan to `dreams/triage-plan.json`; `--apply` executes it. | Legacy untyped memory can become useful again — with a review step. |
| **Better judge input** | The judge sees existing memory, failing tool output, and both the head and tail of long transcripts. Credential values in tool output are redacted first; anything still secret-shaped is dropped. | The model judges with the evidence that actually explains a lesson. |
| **Wider coverage** | Gemini CLI and Zed join the host matrix. Gemini CLI shares `GEMINI.md` with Antigravity; Zed's JSONC settings are preserved. | One memory follows the engineer across more of their tools. |

Triage rewrites archive their original wording. Superseded entries move to `archive/superseded.md`. `amr delete` is the one irreversible-looking operation — it removes the entry from the tree entirely — and even then git history keeps it (`amr search --history`). The system is designed to be reversible.

## About

- **16 hosts, one install.** Cursor, Claude Code, Windsurf, Devin, Copilot, Codex, Cline, Muse, Hermes Agent, Claude Desktop, Antigravity, Gemini CLI, Zed, OpenCode, CommandCode, and Freebuff. Hooks where hosts expose them; rules and MCP where they do not.
- **The save loop is measured.** `amr coverage` reports a save rate against real transcripts, logs a trend, queues misses, and can sample unflagged messages through a judge to estimate its own false-negative rate.
- **Real judge, real transcripts.** Reflection and triage run against installed `claude` or `codex` CLIs, not a mock. In one dry run on a real memory repo, triage classified 91 of 92 legacy entries — 7 keep, 69 rewrite, 15 archive — with originals archived.
- **Boring where it matters.** A zero-runtime-dependency Node CLI, git as the storage engine, atomic writes, a write lock, bounded hook timeouts, and `exit 0` on soft failure. A memory hook should never break a session.
- **Open and inspectable.** MIT-licensed, spec-driven, no hosted service in the path. Your memory is a repo you own.

## Quick start

Requires Node.js 18+ and git.

```sh
npm i -g lucid-mem
amr ensure                  # create the memory repo (~/agent-memory; override with $AMR_HOME)
amr install                 # wire detected hosts: rules, hooks, MCP
amr doctor                  # verify the install
```

Start a session in any wired host; the digest is already in context. To try it directly:

```sh
amr context
amr add "prefer pnpm over npm in this repo" --kind preference --project
```

Point the memory repo at a **private** remote to make it durable and multi-machine:

```sh
amr remote set git@github.com:you/your-memory.git
amr sync
```

## How the loop works

| Direction | Mechanism | Guarantee |
|---|---|---|
| **Retrieve** | Session-start hooks run `amr context`; other hosts get the same digest through rules and MCP. | Deterministic, bounded, no model in the read path. |
| **Save** | An always-on rule block plus the digest's save affordance. `amr add` refuses secrets and warns on ephemeral detail. | One command, with guardrails. |
| **Reflect** | A gated Stop hook asks a background judge what durable lesson was missed, then queues it for review. | Learns from the session without interrupting it. |
| **Maintain** | `amr dream` dedupes, compacts, expires state, and triages backlogs; session-end hooks keep the repo clean. | Memory stays small and reviewable. |
| **Sync** | Every write commits; `amr sync` does pull-rebase and push; session-end hooks flush leftovers. | Durable across machines and teammates. |
| **Measure** | `amr coverage` compares transcript signals with the corpus and reports a save rate. | The system can prove it is working. |

## Commands

| Command | What it does |
|---|---|
| `amr ensure` | Idempotent init: `git init`, `MEMORY.md`, first commit. Never touches global git config. |
| `amr context [dir]` | Ranked session digest. Project-scoped inside a known repo; global plus a pooled digest outside. `--budget N`, `--also a,b`, `--full`. Budget is spent on the current project's entries first, then pooled projects, then globals. As a Claude Code SessionStart hook (`--hook`), an unchanged compaction re-injection is suppressed and a changed one sends only new entries. |
| `amr recall ["error"]` | Failure-triggered recall: at most two entries possibly relevant to a real tool failure, or nothing. Wired as a Claude Code `PostToolUseFailure` (Bash) hook with `--hook`; also runnable by hand. Acts only on a failure (a failure event, `is_error`, a non-zero exit code, `interrupted`), never for read-only tools (`Read`, `Grep`, `Glob`), and scores only the lines that report the failure (error lines plus 2 lines of context, about 2 KB), never the tool input. Entries tagged with a project fire only in that project (or a linked one); a non-trigger match needs two shared words, one of them rare (in 2 or fewer live entries); near-duplicate hits collapse to one. An entry already shown is not re-injected into the same session. |
| `amr unhelpful <id...> ["error"]` | Mute a recalled entry for that kind of error (learned from its last recall, or from the error text given). Local to the machine, never committed. |
| `amr add "text"` | Save a memory. `--project[=name]`, `--file topic`, `--kind`, `--ttl N` days (default 30, 14 for hosting/deploy facts, 2 for `state`; `0` = durable), `--durable` to opt out of expiry, `--verify "<cmd>"` to attach a command that re-checks the fact (shown with the entry, never run). Refuses secret-shaped input, warns on session-state detail, and when a similar entry exists in any live file offers `amr supersede <id>` / `amr update <id>` instead of saving a copy (`--new` overrides). |
| `amr update <id> "text"` | Replace an entry by id or unique text match, preserving metadata. Rolls the entry's expiry forward (`--ttl N`, `--durable` to change it). |
| `amr supersede <id> ["text"]` | Retire an entry to `archive/superseded.md`, optionally with a replacement. Provenance-preserving. |
| `amr delete <id>` (`rm`) | Remove an entry entirely — nothing stays in the tree. Recovery path is git history: `amr search --history "term"`. |
| `amr used <id...>`, `amr ids` | Credit entries that helped; backfill ids for legacy entries. |
| `amr search "term"`, `amr index` | Search every memory file (`--history` also greps past commits); rebuild the `MEMORY.md` index. |
| `amr link`, `amr unlink`, `amr peer`, `amr policy` | Attach sibling repos, teammates' memory repos, and per-repo privacy policy. |
| `amr remote`, `amr sync` | Show or set the private git remote; pull-rebase and push. |
| `amr dream` | Health report, including per-file digest-budget pressure. `--fix` dedupes, drops or renews expired entries, and queues consolidation proposals past the threshold; `--compact` archives overflow; `--triage [--apply]` sorts a legacy backlog into keep/rewrite/archive. |
| `amr coverage` | The save-rate metric. Replays transcripts, diffs durable signals against memory, logs a trend, and queues misses. `--judge` accepts `claude`, `codex`, or `env`. |
| `amr reflect` | The gated Stop hook. `AMR_REFLECT=block` restores the in-session prompt; `AMR_REFLECT_AUTOSAVE=1` lets new adds save directly. |
| `amr harvest`, `amr discover` | List transcripts, extract normalized user messages, and find hot repos with missing memory. |
| `amr install`, `amr uninstall` | Merge rules, hooks, and MCP into detected hosts, with backups. Idempotent and reversible. |
| `amr serve` | stdio MCP server: `memory_context`, `memory_add`, `memory_search`, `memory_update`, `memory_delete`. |
| `amr doctor` | Repo health, PATH, dead config keys, and per-host wiring. |

## Host wiring

`amr install` merges, never clobbers, into each detected host and backs up every file it touches.

| Host | Rules | Hooks | MCP |
|---|---|---|---|
| Cursor | `.cursor/rules/lucid-mem.mdc` | `sessionStart`/`sessionEnd` | `mcp.json` |
| Claude Code | `~/.claude/CLAUDE.md` | `SessionStart`/`SessionEnd`, `PostToolUseFailure` recall (Bash), `Stop` reflect | `~/.claude.json` |
| Windsurf | `global_rules.md` | `sessionStart`/`sessionEnd` | `mcp_config.json` |
| Devin CLI | `devin/AGENTS.md` | `SessionStart` context, `PostToolUse` recall, `Stop` reflect, `SessionEnd` sync/dream/coverage in the user `config.json` | user `config.json` (`mcpServers`) |
| Copilot CLI | `~/.copilot/AGENTS.md` | - | - |
| Codex | `~/.codex/AGENTS.md` | - | `config.toml` |
| Cline | `~/Documents/Cline/Rules/`, `~/.cline/AGENTS.md` | - | `~/.cline/mcp.json` |
| Muse | `~/.config/muse/AGENTS.md` | `SessionStart` context, `PostToolUseFailure` recall, `Stop` reflect, `SessionEnd` sync/dream/coverage in `settings.json` | `settings.json` (`mcpServers`) |
| Hermes Agent | `SOUL.md` (`$HERMES_HOME`) | shell hooks in `config.yaml`: `pre_llm_call` inject, `post_compaction` re-arm | `config.yaml` (`mcp_servers`) |
| Claude Desktop | - | - | `claude_desktop_config.json` |
| Antigravity | `~/.gemini/GEMINI.md` | - | `mcp_config.json` |
| Gemini CLI | `~/.gemini/GEMINI.md` | - | `~/.gemini/settings.json` (`mcpServers`) |
| Zed | `~/.config/zed/AGENTS.md` or `%APPDATA%\Zed\AGENTS.md` | - | `settings.json` (`context_servers`) |
| OpenCode | `~/.config/opencode/AGENTS.md` | - | `opencode.json` (`mcp` schema) |
| CommandCode | `~/.commandcode/AGENTS.md` | - | `mcp.json` |
| Freebuff | `~/.freebuff/AGENTS.md`, `manicode/AGENTS.md` | - | - (manifest-managed registry) |

Rules-only hosts rely on the agent reading its global instruction file each session. MCP is additive where hooks exist; for Claude Desktop it is the only channel.

## Multi-repo memory

One memory repo serves every project. Project files live at `projects/<name>-<hash>.md`, where the name and hash both derive from the origin remote URL, so two clones or worktrees of one remote share memory (whatever their checkout dirs are called) and two unrelated repos with the same name do not collide. Files created under the older checkout-dir naming still attach as a fallback.

- `amr context` is project-scoped inside a repo with a memory file, and global-plus-pooled outside one.
- `amr link` attaches another repo's memory directionally and transitively.
- `private` means unlinked reachability only: a project attaches through your link graph or explicit `--also`, but never contributes to the pooled outside digest.
- `amr peer add <url>` clones a teammate's memory repo read-only and composes its global digest plus its copy of the current project's memory.
- Unknown links and dead `amr.json` keys surface in context markers and `amr doctor`.

## Safety and privacy

- Memory is local-first: a git repo you own, optionally synced to a **private** remote. No hosted service, no vendor-side store.
- A secret denylist (`sk-`, `ghp_`, `github_pat_`, `AKIA`, key blocks, `xox*`, JWTs) runs before every write; `--allow-secret` is explicit.
- Retrieved memory is data, never instructions.
- Hooks are bounded and quiet. Install fails closed on unknown hosts and broken configs; runtime hooks fail open so a session is never blocked.
- Writes are atomic and serialized by `.git/amr.lock`; a write that cannot acquire the lock fails closed instead of racing another writer, and stale locks are broken. Interrupted runs leave a recoverable tree, never a truncated file.
- Triage and compaction move entries to `archive/`; they do not silently delete them. `amr delete` is the explicit hard-delete path and leaves no stub or archive copy.

## Honest limits

- **Pre-1.0.** The CLI is 0.9.x; commands and config keys can still move.
- **Saving is probabilistic.** The rule block and reflection improve adherence; they cannot guarantee it. That is why `amr coverage` exists.
- **Judges cost quota.** Reflection and triage are opt-in and use an installed agent CLI. Deterministic coverage works without them.
- **Host coverage is uneven.** Hooks exist only where a host exposes them; some hosts are rules-only or MCP-only. Windsurf's Cascade transcripts are not harvested.
- **Team memory is early.** Peer memory repos are read-only git clones, not a hosted collaboration layer.
- **No hosted service yet.** Sync is git; there is no managed control plane.

## Company snapshot

| | |
|---|---|
| Company | Mesalim LLC |
| Product | lucid-mem — open-source agent memory layer |
| Category | Memory infrastructure for AI agents |
| Wedge | Coding agents across 15 hosts |
| Distribution | MIT, npm, host-native install |
| Differentiation | Measured save rate; judged reflection; reversible triage |
| Stage | Pre-1.0, open-source first; commercial layer not yet released |

## Where this goes

- **Policy that travels with the repo.** Team-level rules for what may be remembered, shared, or retained.
- **Provenance and audit.** Every durable claim traceable to the session that taught it.
- **Benchmarks, not anecdotes.** A public save-rate benchmark across hosts and models.
- **Managed team memory.** Optional sync and curation for organizations that want the loop without running the git plumbing.

These are the next problems we intend to solve, not shipped features.

## Why Mesalim

Mesalim LLC is building the reliability layer for agent memory.

The open-source harness is the adoption engine: one spec, one install path, and one measurable loop across every host a team already uses. The company's opportunity is the layer above it — memory policy, team curation, provenance and audit, retention, and operations for organizations that cannot afford an agent to forget a decision or relearn a mistake. The core stays MIT-licensed and local-first.

We are early, and direct about it. The category is still forming, the product is pre-1.0, and the right memory policies will be discovered with real teams. What we have today is a working loop that measures itself, distribution into 15 agent hosts, and a clear view of the hard problems left.

If you invest in or deploy agent infrastructure, we want to compare notes: [github.com/mesalimllc/lucid-mem](https://github.com/mesalimllc/lucid-mem).

## Format

`MEMORY.md` is the small entry point every session reads. Entries are one-line bullets with `[key: value]` metadata; `[[path]]` cross-links make the repo a wiki. The full format lives in [SPEC.md](SPEC.md) and upstream at [cognition.com/agent-memory-repo](https://cognition.com/agent-memory-repo).

## Repository layout

```text
lucid-mem/
  SPEC.md                          upstream spec (format only)
  lucid-mem-plan.md                autonomy design doc
  cli/                             amr: zero-dependency Node CLI
    lib/rule-block.md              canonical instruction block stamped into hosts
    lib/rank.mjs                   kind/recency/usage ranking and context budget
    lib/ids.mjs                    stable entry ids, supersede, usage
    lib/pending.mjs                pending reflection and save queues
    lib/reflect.mjs                gated background reflection
    lib/triage.mjs                 judge-backed backlog plan/apply
  adapters/
    windows/install-dream-task.ps1 Task Scheduler dream tasks
    posix/install-dream.sh         systemd/cron dream schedules
  dreams/DREAMER.md                maintenance workflow for the dreaming agent
  skills/lucid-mem/SKILL.md        manual-ops fallback skill
```

## Open development

Agent Memory Repo was originally developed by Cognition and released as an open standard. lucid-mem implements the spec and adds the autonomous harness on top. Spec changes go upstream at [AgentMemoryRepo/agentmemoryrepo](https://github.com/AgentMemoryRepo/agentmemoryrepo).

## License

[MIT](LICENSE)
