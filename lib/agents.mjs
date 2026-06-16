// lib/agents.mjs — process runners + agent invocations + permission modes.
// PROCESS + PREFLIGHT specialist module. Pure: no module-level project state.
//
// Roles (LOCKED):
//   callOpus      -> Opus DESIGNER/REVIEWER, READ-ONLY  (--permission-mode plan)
//   callOpusWrite -> Opus CONSILIUM ARBITER, WRITE      (--permission-mode acceptEdits) — gated by caller
//   callMimo      -> primary EXECUTOR
//   callGemini    -> alternate EXECUTOR / 2nd reviewer
//
// runCli resolves (never rejects); callers inspect .code / .timedOut.
// All state (cwd, dir, runDir, *Bin) is passed in — no file globals — so this module is unit-testable.

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const IS_WIN = process.platform === "win32";
const MAX_BUF = 64 * 1024 * 1024; // 64 MB cap (RISK 9): keep tail bytes, mark head truncation.

// ---------------------------------------------------------------------------
// runCli — cross-platform spawn.
//   Windows:  .exe        -> direct spawn  (CreateProcess handles spaces in path)
//             .cmd/.bat    -> cmd.exe /d /s /c <bin> ...args   (batch can't be spawned directly)
//   POSIX:    direct spawn of bin.
//   stdin:    ALWAYS child.stdin.end() — unconditional — or claude/mimo/gemini HANG.
//   timeout:  tree-kill on Windows (taskkill /T) so mimo/gemini grandchildren don't orphan;
//             surfaces timedOut:true so the caller can distinguish timeout from exit.
// Resolves (never rejects). { code, stdout, stderr, timedOut, signal }
// ---------------------------------------------------------------------------
export function runCli(bin, cliArgs, { cwd, input, timeoutMs = 600000 } = {}) {
  return new Promise((res) => {
    let child;
    const isCmdBatch = IS_WIN && /\.(cmd|bat)$/i.test(bin);
    try {
      if (isCmdBatch) {
        // /d = skip AutoRun, /s = preserve quoting rules, /c = run then exit.
        child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", bin, ...cliArgs], {
          cwd, windowsHide: true, env: process.env, shell: false,
        });
      } else {
        child = spawn(bin, cliArgs, { cwd, windowsHide: true, env: process.env, shell: false });
      }
    } catch (e) {
      // spawn threw synchronously (e.g. bad bin) — resolve as an error, never reject.
      res({ code: -1, stdout: "", stderr: String(e), timedOut: false, signal: null });
      return;
    }

    let stdout = "", stderr = "", timedOut = false;

    const killer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > MAX_BUF) stdout = "...[head truncated]...\n" + stdout.slice(-MAX_BUF);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > MAX_BUF) stderr = "...[head truncated]...\n" + stderr.slice(-MAX_BUF);
    });

    // CRITICAL stdin-hang fix: write (if any) then end() UNCONDITIONALLY.
    // mimo run / claude -p / gemini -p all block forever on an open stdin.
    child.stdin.on("error", () => {}); // ignore EPIPE if child died early
    if (input != null) { try { child.stdin.write(input); } catch {} }
    try { child.stdin.end(); } catch {}

    child.on("close", (code, signal) => {
      clearTimeout(killer);
      res({ code, stdout, stderr, timedOut, signal: signal || null });
    });
    child.on("error", (e) => {
      clearTimeout(killer);
      res({ code: -1, stdout, stderr: stderr + String(e), timedOut, signal: null });
    });
  });
}

// ---------------------------------------------------------------------------
// killTree — kill a process subtree so grandchildren (mimo/gemini spawn node/git
// subprocesses) don't orphan. Accepts either a pid (number/string) OR a child object
// with a .pid (internal runCli usage). Defensive: never throws.
//   Windows: taskkill /PID <pid> /T /F  (whole tree, forced)
//   POSIX:   SIGKILL the process / process group
// ---------------------------------------------------------------------------
export function killTree(pidOrChild) {
  try {
    if (pidOrChild == null) return;
    const isChild = typeof pidOrChild === "object";
    const pid = isChild ? pidOrChild.pid : pidOrChild;
    if (pid == null) return;
    if (IS_WIN) {
      try {
        // Detached + stdio:ignore so taskkill can't inherit our stdin or block.
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true, stdio: "ignore",
        });
      } catch {
        if (isChild) { try { pidOrChild.kill("SIGKILL"); } catch {} }
      }
    } else {
      if (isChild) { try { pidOrChild.kill("SIGKILL"); } catch {} }
      else { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    }
  } catch { /* never throw */ }
}

// git helper — short 60s timeout, separate from the 600s CLI timeout. gitBin may be ".exe" path.
export function git(cwd, cliArgs, gitBin = "git") {
  return runCli(gitBin, cliArgs, { cwd, timeoutMs: 60000 });
}

// ---------------------------------------------------------------------------
// extractJson — brace-balanced, string-aware. Returns first balanced {...} parsed, or null.
// Handles escaped quotes and braces inside strings. (Preserved verbatim from v1.)
// ---------------------------------------------------------------------------
export function extractJson(text) {
  if (!text) return null;
  // Models often prepend prose that itself contains braces (e.g. a code example
  // `function f() { return "hi"; }`). Don't anchor on the FIRST "{" and bail on a
  // parse failure — scan every "{" start, balance it (string/escape aware), and keep
  // the LARGEST substring that JSON.parses (the real object is the biggest one).
  let best = null, bestLen = -1;
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            const slice = text.slice(start, i + 1);
            if (slice.length > bestLen) {
              try { const obj = JSON.parse(slice); best = obj; bestLen = slice.length; } catch {}
            }
            break; // balanced region for this start handled; advance to the next "{"
          }
        }
      }
    }
  }
  return best;
}

// Parse the {type:'result', result, usage, total_cost_usd, ...} envelope from claude --output-format json.
// Returns normalized { text, usage, envelope } for lib/usage.mjs.
function parseClaudeEnvelope(stdout) {
  const env = extractJson(stdout);
  let text = stdout, usage = null;
  if (env) {
    if (typeof env.result === "string") text = env.result;
    // claude exposes token usage + cost in the envelope; normalize for lib/usage.mjs.
    usage = {
      input_tokens:  env.usage?.input_tokens  ?? env.usage?.inputTokens  ?? null,
      output_tokens: env.usage?.output_tokens ?? env.usage?.outputTokens ?? null,
      cache_read_input_tokens:     env.usage?.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: env.usage?.cache_creation_input_tokens ?? null,
      total_cost_usd: env.total_cost_usd ?? env.cost_usd ?? null,
      num_turns: env.num_turns ?? null,
      is_error: env.is_error ?? (env.subtype && env.subtype !== "success") ?? false,
    };
  }
  return { text, usage, envelope: env };
}

// ---------------------------------------------------------------------------
// callOpus — READ-ONLY Opus (DESIGNER / REVIEWER). LOCKED default.
//   claude -p --model <m> --output-format json
//          --permission-mode plan
//          --allowedTools Read Grep Glob        <- THREE separate argv tokens, never comma-joined
//          --add-dir <dir> [--add-dir <d>]*     <- addDirs lets Opus Read PNGs in runDir/refs
//   prompt via STDIN. Optional images: reviewed by instructing Opus to Read the PNG path
//   (no API image embedding) — we append the paths to the prompt; the Read tool renders them.
//   addDirs (synthesis §2): extra dirs (RUN_DIR, refs) so Read can open screenshots outside TARGET.
// Returns { raw, text, usage, envelope }.
// ---------------------------------------------------------------------------
export async function callOpus(model, prompt, label, { dir, images, runDir, claudeBin = "claude", addDirs } = {}) {
  let fullPrompt = prompt;
  if (Array.isArray(images) && images.length) {
    fullPrompt += "\n\n# Screenshots to review\n" +
      "Use the Read tool to open each of these PNG paths and inspect them visually:\n" +
      images.map((p) => `- ${p}`).join("\n");
  }
  const cliArgs = [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--permission-mode", "plan",          // read-only: Opus cannot Edit/Write
    "--allowedTools", "Read", "Grep", "Glob",
    "--add-dir", dir,
  ];
  // Append extra readable dirs (RUN_DIR / refs) so Opus can Read screenshot PNGs outside TARGET.
  if (Array.isArray(addDirs)) {
    for (const d of addDirs) {
      if (d && d !== dir) cliArgs.push("--add-dir", d);
    }
  }
  const r = await runCli(claudeBin, cliArgs, { cwd: dir, input: fullPrompt, timeoutMs: 600000 });
  if (runDir) {
    try {
      writeFileSync(join(runDir, `${label}.raw.txt`),
        (r.stdout || "") + "\n----STDERR----\n" + (r.stderr || "") +
        (r.timedOut ? "\n----TIMED OUT----\n" : ""));
    } catch {}
  }
  const { text, usage, envelope } = parseClaudeEnvelope(r.stdout);
  return { raw: r, text, usage, envelope };
}

// ---------------------------------------------------------------------------
// callOpusWrite — CONSILIUM ARBITER. WRITE-CAPABLE Opus. NOT the default.
//
//   SAFETY GATING (caller MUST enforce before calling this; documented contract):
//     callOpusWrite is invoked ONLY when ALL of:
//       1. cfg.roles.orchestrator.canWrite === true   (config opt-in)
//       2. --consilium flag present on the CLI         (explicit per-run opt-in)
//       3. step.heavy === true                         (planner flagged THIS step heavy)
//     The orchestrator keeps callOpus (read-only) as the default for every other path.
//
//   Differs from callOpus ONLY in:
//       --permission-mode acceptEdits   (was: plan)
//       --allowedTools Read Grep Glob Edit Write   (adds Edit, Write)
//   Scope is still bounded to --add-dir <dir>; Opus can only write under that dir.
// Returns { raw, text, usage, envelope }.
// ---------------------------------------------------------------------------
export async function callOpusWrite(prompt, label, { dir, runDir, model = "opus", claudeBin = "claude" } = {}) {
  const cliArgs = [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--permission-mode", "acceptEdits",   // WRITE: Opus may apply edits autonomously
    "--allowedTools", "Read", "Grep", "Glob", "Edit", "Write",
    "--add-dir", dir,
  ];
  const r = await runCli(claudeBin, cliArgs, { cwd: dir, input: prompt, timeoutMs: 600000 });
  if (runDir) {
    try {
      writeFileSync(join(runDir, `${label}.raw.txt`),
        (r.stdout || "") + "\n----STDERR----\n" + (r.stderr || "") +
        (r.timedOut ? "\n----TIMED OUT----\n" : ""));
    } catch {}
  }
  const { text, usage, envelope } = parseClaudeEnvelope(r.stdout);
  return { raw: r, text, usage, envelope };
}

// ---------------------------------------------------------------------------
// callMimo — PRIMARY EXECUTOR.
//   mimo run [-c] --agent <agent> -m <model> --dangerously-skip-permissions [-f <msgfile> "<inline>"]
//   stdin MUST be closed (runCli does this) or mimo hangs.
//
//   BUG 6 reconciliation: ground-truth contract is `mimo run ... -f <msgfile> "<inline instruction>"`.
//   v1 wrote msgFile but never passed -f (dead audit write). v2 default: pass -f <msgFile> AND inline
//   arg AND stdin (mimo accepts all; -f is the documented contract, stdin is the proven one).
//   useFileFlag lets the orchestrator toggle if a mimo version rejects -f.
//   Date.now() gives a unique msg filename per call.
// Returns { code, stdout, stderr, timedOut, msgFile }.
// ---------------------------------------------------------------------------
// npm CLI shims on Windows are .cmd files that just invoke a bundled native .exe:
//   @echo off
//   "C:\...\mimocode-windows-x64\bin\mimo.exe" %*
// Direct-spawning that .exe BYPASSES cmd.exe entirely, so the message goes through Node's
// native argv quoting (no cmd.exe metacharacter re-parsing → no command injection, no
// truncation at & | " etc., and a 32K cmdline limit instead of cmd.exe's ~8K).
function resolveExe(bin) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(bin)) {
    try {
      const txt = readFileSync(bin, "utf8");
      const m = txt.match(/"([^"]+\.exe)"\s*%\*/i) || txt.match(/([A-Za-z]:\\[^"\r\n]+?\.exe)/i);
      if (m && existsSync(m[1])) return m[1];
    } catch { /* fall through to the shim */ }
  }
  return bin;
}

export async function callMimo(message, isContinue, model, {
  cwd, runDir, mimoBin = "mimo", agent = "build", useFileFlag = true,
} = {}) {
  let msgFile = null;
  if (runDir) {
    msgFile = join(runDir, `exec.msg.${Date.now()}.md`);
    try { writeFileSync(msgFile, message); } catch { msgFile = null; }
  }
  const bin = resolveExe(mimoBin);
  const viaExe = !(IS_WIN && /\.(cmd|bat)$/i.test(bin)); // true once resolved to the native .exe
  const cliArgs = ["run"];
  if (isContinue) cliArgs.push("-c");
  cliArgs.push("--agent", agent, "-m", model, "--dangerously-skip-permissions");
  if (cwd) cliArgs.push("--dir", cwd);
  if (viaExe) {
    // Clean argv via direct .exe spawn — `message` is mimo's positional prompt (run [message..]).
    cliArgs.push(message);
  } else if (msgFile) {
    // .cmd fallback (couldn't resolve the .exe): never put the raw message in cmd.exe argv (injection).
    // A short fixed instruction (positional, BEFORE -f so the greedy -f array grabs only the file) +
    // the full message attached as a file.
    cliArgs.push("Implement the attached specification/feedback by editing the repository files directly. Make minimal, focused changes. Do not ask questions, then stop.");
    cliArgs.push("-f", msgFile);
  } else {
    cliArgs.push(message);
  }
  // stdin is closed unconditionally by runCli (mimo hangs on an open stdin).
  const r = await runCli(bin, cliArgs, { cwd, timeoutMs: 900000 });
  return { ...r, msgFile };
}

// ---------------------------------------------------------------------------
// callGemini — ALTERNATE EXECUTOR / 2nd reviewer.
//   gemini -p --approval-mode yolo --skip-trust -m <model>
//   prompt via stdin; needs GEMINI_API_KEY in env (run.ps1 loads it from .env.local).
//   stdin MUST be closed (runCli does this).
// Returns { code, stdout, stderr, timedOut }.
// ---------------------------------------------------------------------------
export async function callGemini(message, model, { cwd, runDir, geminiBin = "gemini" } = {}) {
  const cliArgs = ["-p", "--approval-mode", "yolo", "--skip-trust", "-m", model];
  const r = await runCli(geminiBin, cliArgs, { cwd, input: message, timeoutMs: 900000 });
  if (runDir) {
    try {
      writeFileSync(join(runDir, `gemini.${Date.now()}.raw.txt`),
        (r.stdout || "") + "\n----STDERR----\n" + (r.stderr || ""));
    } catch {}
  }
  return r;
}
