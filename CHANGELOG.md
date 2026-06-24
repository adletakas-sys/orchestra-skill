# Changelog

All notable changes to Orchestra are documented here.
Format: [Semantic Versioning](https://semver.org). Breaking changes marked **BREAKING**.

---

## [2.1.0] — 2026-06-25

### New features

- **`--planner-model <model>`** — use a cheaper model (e.g. `sonnet`) for the PLAN phase only; Opus stays as reviewer. Reduces per-run cost 30–50% on decomposition-heavy tasks with no measurable quality loss.
- **`--escalate-reviewer`** — tiered review: Sonnet does the first pass; escalates to Opus only when score < threshold (default 70) or blocking issues found. Configurable via `config.json → roles.reviewer.escalateModel/escalateThreshold`.
- **`--lite-consilium`** — dual mimo+gemini candidates on heavy steps with a read-only Opus arbiter; winner applied via `git apply`. No `canWrite:true` required.
- **`--parallel-exec`** — dual candidates on **every** iteration, not just heavy steps.
- **`--budget <usd>`** — hard spend ceiling per run. Optional phases (audit, dual-review) are disabled at 90% consumed; run aborts when ceiling is breached. Override of `config.json → budget.maxUsd`.
- **`--resume <run-dir>`** — resume an interrupted run: loads `spec.json` + last `review.N.json` from a prior run directory, skips DESIGN-SCAN and PLAN, continues from the next iteration.
- **`--lock-mimo`** — file-based mutual exclusion (`mimo.lock` in the skill root) prevents CPU contention when multiple Orchestra instances run concurrently. Auto-steals stale locks after executor-timeout + 1 min.

### Pipeline improvements

- **Spec pre-validation** — after PLAN, warns (non-fatal) if `relevant_files` don't exist in the target repo or `acceptance_criteria` is empty.
- **Adaptive early-exit** — auto-approves when `score >= earlyExitScore` (default 95) with no blocking issues; stops early when `score < abortScore` (default 20) and no diff was produced (executor not converging).
- **Executor trap memory** (`executorTraps` context section, SCHEMA_VERSION 2) — blocking issues, design violations, and a11y findings from rejected iterations are stored and injected into the next retry prompt. Executor sees its own past failures.
- **Diff-aware retry** — `executorRetryMessage` now includes a `changedFiles` hint (which files changed vs HEAD) and a `trapsBlock` (known failure patterns), making retries surgical rather than broad rewrites.
- **Prompt-cache warming** — `plannerPrompt` and `reviewerPrompt` share an identical `sharedCachePrefix(task, tokens)` prefix, maximising probability of Claude's 5-min ephemeral cache hit between the PLAN and REVIEW calls.
- **Cost summary** — `== RESULT ==` now prints `cost: $X.XX (baseline $Y.YY, savings ~Z%)`.

### Config additions (`config.json`)

- `roles.planner` — model field + `--planner-model` override comment
- `roles.reviewer.escalateModel` / `roles.reviewer.escalateThreshold`
- `execution.mimoLockTimeoutMs` / `execution.earlyExitScore` / `execution.abortScore`
- `budget.maxUsd`
- `pricing.claude-sonnet-4-6` entry

### Versioning

- Added root `package.json` (`"version": "2.1.0"`, `"type": "module"`)
- Added `CHANGELOG.md`

---

## [2.0.0] — 2026-05 (baseline for this changelog)

Initial tracked release. Core pipeline:

- DESIGN-SCAN → C3 → PLAN(Opus) → EXECUTE(mimo) → diff → GATE → RENDER → VERIFY → REVIEW(Opus) → C2 → D2 → C4 → B4 → RESULT
- Consilium mode (mimo+gemini+opus, requires `canWrite:true`)
- Design-system token extraction (9 stacks)
- Context file between agents (`lib/context.mjs`, SCHEMA_VERSION 1)
- Usage/cost tracking (`lib/usage.mjs`)
- Visual review via Playwright/Roborazzi (`--render`, `--ref-dir`)
- a11y/perf/security/i18n audits (`--audit`)
- TDD mode (`--tdd`), dual-review (`--dual-review`), UX-copy (`--ux-copy`)
- PowerShell self-bootstrapping launcher (`run.ps1` + `preflight.ps1`)
