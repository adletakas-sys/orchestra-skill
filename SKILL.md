---
name: orchestra
description: Multi-agent build orchestrator for any repo/stack — Opus designs + reviews (read-only), MiMoCode builds the code, Gemini optional. Use when the user invokes /orchestra, or asks to build/implement a coding task "through the orchestra/orchestrator", "Opus plan + mimo build", a multi-agent build pipeline, a consilium, or wants a designed-and-reviewed implementation. Self-bootstraps its CLIs on any machine.
---

# Orchestra — multi-agent build orchestrator

A self-contained pipeline that builds a coding task in **any** project: **Opus** turns the task into a UI-aware spec and strictly reviews the diff (read-only); **MiMoCode** writes the code; **Gemini** is an optional alternate builder / 2nd reviewer. Opus only writes code in the gated *consilium* mode. See `README.md` and `DESIGN.md` in this skill folder for full detail.

## When to run it

Invoke when the user types `/orchestra <task>` or asks to build/fix/implement something "via the orchestra / orchestrator / Opus+mimo / consilium". For a trivial one-line edit you can just do it yourself; the orchestra shines on real features where a design→build→review loop adds value.

## How to run it

1. **Determine the target project root** — the user's current repo (absolute path). It must be a git work tree (the reviewer diffs vs `HEAD`).
2. **Check the working tree is clean** (`git status --short`). If dirty, tell the user the reviewer will see unrelated changes and offer to proceed or stop. (Consilium aborts on a dirty tree by design.)
3. **Launch the bundled launcher** with the PowerShell tool (it auto-bootstraps the CLIs via `preflight.ps1` and self-heals `config.json` paths — nothing to install manually):

   ```powershell
   & "C:\Users\Administrator\.claude\skills\orchestra\run.ps1" --dir "<ABSOLUTE_PROJECT_PATH>" "<the task>"
   ```

   Run it in the background if it may take a while (real runs invoke Opus + mimo and can take minutes). The launcher prints progress and writes artifacts.
4. **Report the result**: read the tail of the output (the `== RESULT ==` line: `APPROVED ✅` / `NOT APPROVED ❌`) and point the user at the artifacts dir (`runs/<timestamp>/` inside this skill folder: `spec.json`, `diff.N.patch`, `review.N.json`, `usage.json`/`usage.md`). Summarize what changed in their repo (`git status` / `git diff` in the target).

## Flags (append after the task, passed through to the engine)

| Flag | Effect |
|------|--------|
| `--dir <path>` | target repo (default: caller cwd) |
| `--max-iters N` | execute→review cycles (default 4) |
| `--verify "<cmd>"` | build/test command; output goes to the reviewer (else auto-detected per stack) |
| `--executor gemini` | build with Gemini instead of MiMoCode (needs `GEMINI_API_KEY` in `.env.local`) |
| `--dual-review` | Gemini second-reviews, Opus arbitrates |
| `--tdd` | Opus designs acceptance tests first |
| `--render` | screenshot + visual review (needs screenshot infra in the project; degrades gracefully) |
| `--ref-dir <path>` | reference images to match (visual fidelity) |
| `--audit` | a11y / perf / security / i18n audit passes |
| `--ux-copy` | Opus authors user-facing copy |
| `--consilium` | heavy steps built by mimo+gemini+opus, Opus arbitrates (requires `roles.orchestrator.canWrite:true` in config.json — Opus writes code) |
| `--dry-run` | print the plan prompt only, invoke nothing |

PowerShell launcher flags (must come **before** the task): `-SkipSetup` (skip install, still self-heals config), `-WithGemini` (also ensure gemini installed), `-Update` (force-upgrade claude/mimo).

## Notes

- **Read-only by default**: Opus cannot edit files except in `--consilium` with `canWrite:true`. The executor (mimo/gemini) makes all normal edits, only inside `--dir`.
- **Auth**: claude uses the desktop session creds; mimo uses free anonymous MiMo Auto (`mimo providers login -p mimo` if it 401s); gemini needs `GEMINI_API_KEY` in this folder's `.env.local` (see `.env.local.example`).
- **Per-call timeouts**: executor 15 min, Opus 10 min (raise `cfg.limits.*` for unusually long steps). A genuinely stuck single call is tree-killed; the overall multi-iteration run is not time-limited.
- **You cannot dry-test mimo interactively** — it hangs on an open stdin; only the engine (which closes stdin) drives it correctly.
- Do **not** paste secrets into the task text; the task is written to artifact files.
