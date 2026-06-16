# Orchestra v2 — Architecture

Universal multi-agent build orchestrator. Opus designs + reviews (read-only), MiMoCode builds, Gemini is the alternate builder / 2nd reviewer. The full locked design lives in `_design/00_SYNTHESIS.md`; this is the short reference.

## Module map

| File | Responsibility |
|------|----------------|
| `orchestrate.mjs` | Pipeline state machine; wires all modules; owns the iteration loop, gates, exit codes. |
| `lib/agents.mjs` | `runCli` (Windows-safe spawn: `.exe` direct, `.cmd/.bat` via `cmd.exe /d /s /c`), `git`, `extractJson` (brace-balanced), `callOpus` (read-only), `callOpusWrite` (consilium), `callMimo`, `callGemini`. Unconditional `stdin.end()`, timeout tree-kill, 64MB buffer cap, envelope/usage parsing. |
| `lib/detect.mjs` | `detectStack` (marker ruleset, never throws → `generic`), `resolveDesignFiles` (per-stack globs + universal carriers, ignoreDirs/caps), `detectVerifyCmd`. Self-contained shallow glob (`**`,`*`,`{a,b}`), no npm deps. |
| `lib/tokens.mjs` | `extractDesignTokens` (pure; per-stack regex parsers → normalized token object), `proposeGreenfieldTokens`. |
| `lib/prompts.mjs` | `SCHEMAS` (planner/review/audit/consilium/uxCopy/reference/testPlan), `SCHEMA(name)`, all prompt builders. Universal (not app-specific); every JSON prompt embeds its schema + "JSON only, no fences". |
| `lib/render.mjs` | `render` / `ingestReferences` / `compareToReference` / `buildImageBundle` / `detectRenderCapability`. Never throws; graceful no-op when screenshot infra is absent; never installs or mutates the target. Opus "sees" PNGs via the Read tool (paths + `--add-dir`). |
| `lib/context.mjs` | Persistent cross-process/cross-run context file `context/<slug>.md`. Lock via `fs.open(wx)` + stale-steal + read-only degrade; atomic temp+rename. Every op non-fatal. |
| `lib/usage.mjs` | Per-call token + cost logging from the claude JSON envelope → `usage.json`/`usage.md` + savings-vs-all-Opus estimate. Never throws. |
| `preflight.ps1` | Resolve node/git/claude/mimo (+gemini on demand); auto `npm i -g` missing claude/mimo; self-heal `config.json` bins/nodeBin (no-BOM write). Prefers `.cmd` over `.ps1` (runCli can't spawn `.ps1`). |
| `run.ps1` | Detect node+git+npm dirs → PATH; load `.env.local`; run preflight; `& node orchestrate.mjs @args`; inject `--dir <cwd>` if absent. |

## Pipeline (one run)

```
[0] bootstrap (config BOM-safe, args flag>config, git baseline guard)
[S] DESIGN-SCAN  detectStack → resolveDesignFiles → extractDesignTokens → design-tokens.json   (all-local, never LLM)
[C3] test-design (opt)  Opus → test-plan.json
[1] PLAN  Opus designer → spec.json (steps[].heavy drives consilium)
 LOOP it=1..MAX:
   [2|E] EXECUTE (mimo|gemini)  OR  CONSILIUM (mimo+gemini+opus candidates → Opus arbiter applies winner)
   [diff] git diff HEAD + status   → GATE-EXEC: exit≠0 / no-op ⇒ synthetic reject, skip review
   [R] render (opt, graceful)   [V] verify (opt; POSIX /bin/sh, Win cmd.exe)
   [3] REVIEW Opus → reviewVerdict
   [C2] dual-review (opt): Gemini + Opus arbiter
   [D2] reference compare (opt)
   [C4] audits (opt, final gate): a11y/perf/security/i18n; blocking ⇒ demote approval
   [B4] ux-copy (opt)
   decision: approved = final.approved && auditsClean
[result] usage.flush + ctx.flush + snapshot ; exit 0/1/2
```

## Invariants & safety

- **Read-only Opus by default**: `callOpus` always `--permission-mode plan --allowedTools Read Grep Glob`. Write happens only in `callOpusWrite`, reachable only when `roles.orchestrator.canWrite && --consilium/heavy` (3-gate).
- **Consilium never nukes user work**: hard `git status --short` clean-check before any `reset --hard`/`clean -fd`; aborts to single-executor if dirty.
- **Never-throw modules**: context, usage, render, and all `extractJson`/agent calls degrade gracefully; failures log + continue, never change exit code.
- **Self-healing toolchain**: stale/absent CLI paths are re-resolved and written back to `config.json` each run → portable to any machine.
- **Exit codes**: `0` approved · `1` not-approved / parse-fail / fatal · `2` no task / not a git tree.

## Token economics

Bulk codegen runs on MiMo Auto (free) / Gemini; billed Opus tokens are confined to design + review + arbitration. `usage.json` reports measured spend and an honest savings estimate (noting that separate CLI processes forgo cross-call prompt caching).
