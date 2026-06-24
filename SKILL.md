---
name: orchestra
description: Multi-agent build orchestrator for any repo/stack — Opus designs + reviews (read-only), MiMoCode builds the code, Gemini optional. Use when the user invokes /orchestra, or asks to build/implement a coding task "through the orchestra/orchestrator", "Opus plan + mimo build", a multi-agent build pipeline, a consilium, or wants a designed-and-reviewed implementation. Self-bootstraps its CLIs on any machine.
---

# Orchestra v2.1 — multi-agent build orchestrator

A self-contained pipeline that builds a coding task in **any** project: **Opus** turns the task into a UI-aware spec and strictly reviews the diff (read-only); **MiMoCode** writes the code; **Gemini** is an optional alternate builder / 2nd reviewer. See `README.md` and `DESIGN.md` for full detail.

## When to run it

Invoke when the user types `/orchestra <task>` or asks to build/fix/implement something "via the orchestra / orchestrator / Opus+mimo / consilium". For a trivial one-line edit do it directly; the orchestra shines on real features where a design→build→review loop adds value.

## How to run it

1. **Determine the target project root** (absolute path). It must be a git work tree (reviewer diffs vs `HEAD`).
2. **Check the working tree is clean** (`git status --short`). If dirty, warn the user.
3. **Launch the bundled launcher:**

   ```powershell
   & "C:\Users\Administrator\.claude\skills\orchestra\run.ps1" --dir "<ABSOLUTE_PROJECT_PATH>" "<the task>"
   ```

   Run in background if the task may take a while. The launcher prints progress and writes artifacts to `runs/<timestamp>/`.

4. **Report the result**: read the `== RESULT ==` line (`APPROVED ✅` / `NOT APPROVED ❌`), the cost summary (`cost: $X.XX …`), and point the user at the artifacts dir. Summarize what changed (`git status` / `git diff` in the target).

## Flags

### Core

| Flag | Effect |
|------|--------|
| `--dir <path>` | target repo (default: caller cwd) |
| `--max-iters N` | execute→review cycles (default 4) |
| `--verify "<cmd>"` | build/test command; output goes to the reviewer |
| `--executor gemini` | build with Gemini instead of MiMoCode |
| `--model <prov/model>` | override executor model |
| `--no-review` | one executor pass, skip review |
| `--dry-run` | print plan prompt only |

### Cost control (v2.1)

| Flag | Effect |
|------|--------|
| `--planner-model sonnet` | Sonnet as planner (~50% cheaper); Opus still reviews |
| `--escalate-reviewer` | Sonnet does first review pass; escalates to Opus when score < 70 or blocking issues found |
| `--budget <usd>` | hard spend ceiling; optional phases disabled at 90%, aborts at ceiling |

### Multi-candidate (v2.1)

| Flag | Effect |
|------|--------|
| `--lite-consilium` | dual mimo+gemini on heavy steps, read-only Opus arbiter picks winner via `git apply` |
| `--parallel-exec` | dual candidates on every iteration |
| `--lock-mimo` | file-based mutex preventing CPU contention across concurrent Orchestra runs |

### Run management (v2.1)

| Flag | Effect |
|------|--------|
| `--resume <run-dir>` | resume interrupted run; loads spec.json + last verdict, skips DESIGN-SCAN+PLAN |

### Optional phases

| Flag | Effect |
|------|--------|
| `--tdd` | Opus designs acceptance tests first (C3) |
| `--dual-review` | Gemini second-reviews, Opus arbitrates (C2) |
| `--render` | screenshot + visual review (A) |
| `--ref-dir <path>` | reference images for visual fidelity check (D2) |
| `--audit` | a11y/perf/security/i18n audit passes (C4) |
| `--ux-copy` | Opus authors user-facing copy (B4) |
| `--consilium` | heavy steps built by mimo+gemini+opus, Opus arbitrates and writes (E; requires `roles.orchestrator.canWrite:true`) |

PowerShell launcher flags (before the task): `-SkipSetup`, `-WithGemini`, `-Update`.

## What's new in v2.1

- **`--planner-model sonnet`** — cheaper PLAN phase, no quality loss on decomposition
- **`--escalate-reviewer`** — tiered review: Sonnet first, Opus only when needed
- **`--lite-consilium`** — dual candidates without requiring `canWrite`
- **`--parallel-exec`** — dual candidates every iteration
- **`--budget`** — hard USD ceiling per run
- **`--resume`** — resume interrupted runs
- **`--lock-mimo`** — prevents CPU contention across concurrent runs
- **Executor trap memory** — blocking issues from rejected iterations injected into next retry
- **Adaptive early-exit** — auto-approve at score ≥ 95, abort at score < 20 with no diff
- **Cost summary** in every RESULT line
- **Prompt-cache warming** — shared prefix between PLAN and REVIEW calls

## Notes

- **Read-only by default**: Opus cannot edit files except in `--consilium` with `canWrite:true`.
- **Auth**: claude uses desktop session creds; mimo uses free anonymous MiMo Auto; gemini needs `GEMINI_API_KEY` in `.env.local`.
- **Timeouts**: executor 15 min, Opus 10 min (configurable via `cfg.limits`).
- **Concurrent runs**: use `--lock-mimo` or run sequentially — parallel mimo runs contend for CPU and time out.
- **Resume**: interrupted run? Pass `--resume runs/<timestamp>` from the prior run directory.
- Do **not** paste secrets into the task text; the task is written to artifact files.
