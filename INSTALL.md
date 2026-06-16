# Orchestra skill — install & run

Universal multi-agent build orchestrator. **Opus** designs + reviews (read-only), **MiMoCode** builds, **Gemini** optional. Works on any repo/stack and self-bootstraps its CLIs.

## Install (any machine)
1. Requirements: **Node.js (LTS)**, **Git**, and **Claude Code**. `mimo` (and `gemini` on demand) are auto-installed on first run.
2. Clone into your Claude skills folder:
   ```
   git clone <REPO_URL> "%USERPROFILE%\.claude\skills\orchestra"
   ```
   (Windows PowerShell: `git clone <REPO_URL> "$env:USERPROFILE\.claude\skills\orchestra"`.) It then appears as **/orchestra** in Claude Code.
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
Flags after the task: `--max-iters N`, `--verify "<cmd>"`, `--dual-review`, `--tdd`, `--render`, `--audit`, `--ux-copy`, `--consilium`, `--executor gemini`, `--dry-run`. Launcher flags before the task: `-SkipSetup`, `-WithGemini`, `-Update`.

## Notes
- Target must be a **clean git repo** (the reviewer diffs vs `HEAD`).
- Gemini needs `GEMINI_API_KEY` in `.env.local` (copy `.env.local.example`).
- Full reference: `README.md`. Architecture: `DESIGN.md`.
