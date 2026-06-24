# Orchestra skill — install & run (v2.1)

Universal multi-agent build orchestrator. **Opus** designs + reviews (read-only by default), **MiMoCode** builds, **Gemini** optional. Self-bootstraps its CLIs on any machine.

## Install (any machine)

1. Requirements: **Node.js ≥ 18 LTS**, **Git**, and **Claude Code**. `mimo` (and `gemini` on demand) are auto-installed on first run.
2. Clone into your Claude skills folder:
   ```powershell
   git clone https://github.com/adletakas-sys/orchestra-skill "$env:USERPROFILE\.claude\skills\orchestra"
   ```
   It then appears as **/orchestra** in Claude Code.
3. First run auto-bootstraps: `preflight.ps1` resolves/installs the CLIs and self-heals `config.json` paths for this machine. Nothing to configure by hand.

## Run

### Via Claude Code (recommended)

```
/orchestra <your task>
```

e.g. `/orchestra add a /health endpoint returning {status:"ok"}`. Claude runs the pipeline on your current repo and reports the verdict + artifacts.

### Direct (PowerShell)

```powershell
& "$env:USERPROFILE\.claude\skills\orchestra\run.ps1" --dir "C:\path\to\repo" "<task>"
```

**Core flags:**

| Flag | Effect |
|------|--------|
| `--max-iters N` | execute→review cycles (default 4) |
| `--verify "<cmd>"` | build/test command sent to the reviewer |
| `--executor gemini` | build with Gemini instead of MiMoCode |
| `--dry-run` | print the plan prompt only, invoke nothing |
| `--resume <run-dir>` | resume an interrupted run (skips DESIGN-SCAN + PLAN) |

**Cost-control flags (v2.1):**

| Flag | Effect |
|------|--------|
| `--planner-model sonnet` | Sonnet as planner (~50% cheaper); Opus still reviews |
| `--escalate-reviewer` | Sonnet does first review pass; escalates to Opus only when score < 70 or blocking issues found |
| `--budget <usd>` | hard spend ceiling; optional phases disabled at 90%, run aborts at ceiling |

**Multi-candidate flags (v2.1):**

| Flag | Effect |
|------|--------|
| `--lite-consilium` | dual mimo+gemini candidates on heavy steps, read-only Opus arbiter picks winner |
| `--parallel-exec` | dual candidates on every iteration |
| `--lock-mimo` | file-based mutex to prevent CPU contention across concurrent Orchestra runs |

**Optional phase flags:**

| Flag | Effect |
|------|--------|
| `--tdd` | Opus designs acceptance tests first |
| `--dual-review` | Gemini second-reviews, Opus arbitrates |
| `--render` | screenshot + visual review |
| `--ref-dir <path>` | reference images to match |
| `--audit` | a11y / perf / security / i18n audit passes |
| `--ux-copy` | Opus authors user-facing copy |
| `--consilium` | heavy steps built by mimo+gemini+opus, Opus arbitrates and writes (requires `roles.orchestrator.canWrite:true`) |

**PowerShell launcher flags** (must come before all other args): `-SkipSetup`, `-WithGemini`, `-Update`.

## Auth

| CLI | How |
|-----|-----|
| **claude** | current Claude session creds. If 401 — run `claude` once interactively. |
| **mimo** | `mimo providers login -p mimo` if it 401s (MiMo Auto is free + anonymous). |
| **gemini** | `GEMINI_API_KEY=...` in `.env.local` (copy `.env.local.example`). Only for `--executor gemini` / `--dual-review`. |

## Notes

- Target must be a **clean git repo** (the reviewer diffs vs `HEAD`). If working tree is dirty, the reviewer sees unrelated changes.
- Full reference: `README.md`. Architecture: `DESIGN.md`. Version history: `CHANGELOG.md`.
