#!/usr/bin/env node
/**
 * orchestrate.mjs — universal /orchestra pipeline (v2.1).
 *
 *   Opus (claude)  : DESIGNER (PLAN) + REVIEWER (REVIEW), read-only by default.
 *                    In CONSILIUM only (and only for heavy steps), ARBITER that may WRITE.
 *   MiMoCode       : primary EXECUTOR (writes code).
 *   Gemini         : alternate executor (--executor gemini) + 2nd reviewer (--dual-review).
 *
 * Flow: DESIGN-SCAN -> [C3 test] -> PLAN -> { EXECUTE|LITE-CONSILIUM|CONSILIUM -> diff -> GATE
 *        -> RENDER -> VERIFY -> REVIEW(escalating) -> C2 -> D2 -> C4 audits -> B4 ux-copy -> ctx }*
 *        until approved or max-iters.
 *
 * v2.1 additions:
 *   --planner-model <model>  : use a cheaper model (e.g. sonnet) for the PLAN phase
 *   --escalate-reviewer      : Sonnet does first review pass; escalates to Opus if score < threshold
 *   --lite-consilium         : dual mimo+gemini candidates, read-only Opus arbiter (no canWrite needed)
 *   --parallel-exec          : dual candidates on EVERY iteration (not just heavy steps)
 *   --budget <usd>           : abort / disable optional phases when spend exceeds ceiling
 *   --resume <run-dir>       : resume from an existing run (loads spec.json + last verdict)
 *   mimo.lock                : file-based sequential lock prevents CPU contention when multiple
 *                              Orchestra instances run concurrently (--lock-mimo to enable)
 *   spec pre-validation      : warns when relevant_files don't exist in the target repo
 *   adaptive early-exit      : auto-approve at earlyExitScore, abort at abortScore with no diff
 *   cost summary             : prints spend + savings at the end of every run
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, openSync, closeSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { runCli, git as gitCli, extractJson, callOpus, callOpusWrite, callMimo, callGemini } from "./lib/agents.mjs";
import { detectStack, resolveDesignFiles, detectVerifyCmd } from "./lib/detect.mjs";
import { extractDesignTokens } from "./lib/tokens.mjs";
import { loadContext, sliceForAgent, snapshotToRun, flush as ctxFlush } from "./lib/context.mjs";
import { createUsage } from "./lib/usage.mjs";
import { render, ingestReferences, compareToReference, buildImageBundle } from "./lib/render.mjs";
import * as P from "./lib/prompts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";

// ---------- config (BOM-safe) ----------
const cfg = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8").replace(/^﻿/, ""));
// PATH guard (BUG-4): handle PATH|Path, case-insensitive, trailing-slash tolerant.
{
  const sep = IS_WIN ? ";" : ":";
  const key = process.env.PATH != null ? "PATH" : (process.env.Path != null ? "Path" : "PATH");
  const cur = process.env.PATH || process.env.Path || "";
  const norm = (s) => s.replace(/[\\/]+$/, "").toLowerCase();
  if (cfg.nodeBin && !cur.split(sep).some((p) => p && norm(p) === norm(cfg.nodeBin))) {
    process.env[key] = cfg.nodeBin + sep + cur;
  }
}

// ---------- args ----------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dry-run") a.dryRun = true;
    else if (t === "--task") a.task = argv[++i];
    else if (t === "--task-file") a.taskFile = argv[++i];
    else if (t === "--dir") a.dir = argv[++i];
    else if (t === "--max-iters") a.maxIters = parseInt(argv[++i], 10);
    else if (t === "--verify") a.verify = argv[++i];
    else if (t === "--executor") a.executor = argv[++i];      // mimo | gemini
    else if (t === "--model") a.execModel = argv[++i];
    else if (t === "--planner-model") a.plannerModel = argv[++i];  // e.g. sonnet
    else if (t === "--no-review") a.noReview = true;
    else if (t === "--tdd") a.tdd = true;
    else if (t === "--dual-review") a.dualReview = true;
    else if (t === "--render") a.render = true;
    else if (t === "--audit") a.audit = true;
    else if (t === "--ux-copy") a.uxCopy = true;
    else if (t === "--consilium") a.consilium = true;
    else if (t === "--lite-consilium") a.liteConsilium = true;   // dual candidates, read-only arbiter
    else if (t === "--parallel-exec") a.parallelExec = true;     // dual candidates on every iter
    else if (t === "--escalate-reviewer") a.escalateReviewer = true;
    else if (t === "--ref-dir") a.refDir = argv[++i];
    else if (t === "--budget") a.budget = parseFloat(argv[++i]); // USD ceiling
    else if (t === "--resume") a.resume = argv[++i];             // path to prior run dir
    else if (t === "--lock-mimo") a.lockMimo = true;             // sequential mimo lock
    else a._.push(t);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));

const TASK = (args.task || (args.taskFile ? readFileSync(resolve(args.taskFile), "utf8") : args._.join(" "))).trim();
const TARGET = resolve(args.dir || process.cwd());
const MAX_ITERS = args.maxIters || cfg.maxIterations || 4;
const EXECUTOR = args.executor || cfg.roles.executor.cli;     // mimo | gemini
const execModel = args.execModel;
const DRY = !!args.dryRun;
const REF_DIR = args.refDir || cfg.referenceDir || "";

// Planner model: --planner-model overrides config.roles.planner.model, falls back to orchestrator model
const PLANNER_MODEL = args.plannerModel || cfg.roles.planner?.model || cfg.roles.orchestrator.model;

// Escalating reviewer config
const ESCALATE_REVIEWER = args.escalateReviewer || false;
const ESCALATE_MODEL = cfg.roles.reviewer?.escalateModel || "sonnet";
const ESCALATE_THRESHOLD = cfg.roles.reviewer?.escalateThreshold ?? 70;

// Lite-consilium / parallel-exec (dual candidates without canWrite)
const LITE_CONSILIUM = args.liteConsilium || false;
const PARALLEL_EXEC = args.parallelExec || false;

// Budget ceiling
const BUDGET_USD = args.budget ?? cfg.budget?.maxUsd ?? 0;  // 0 = unlimited

// Adaptive exit thresholds
const EARLY_EXIT_SCORE = cfg.execution?.earlyExitScore ?? 95;
const ABORT_SCORE = cfg.execution?.abortScore ?? 20;

// Mimo lock
const USE_MIMO_LOCK = args.lockMimo || false;
const MIMO_LOCK_FILE = join(__dirname, "mimo.lock");
const MIMO_LOCK_TIMEOUT_MS = cfg.execution?.mimoLockTimeoutMs ?? 300000;

if (!TASK) {
  console.error('ERROR: no task. Pass a task string, --task "...", or --task-file <path>.');
  process.exit(2);
}

// ---------- run dir / logging ----------
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = join(__dirname, "runs", stamp);
mkdirSync(RUN_DIR, { recursive: true });
const logLines = [];
function log(s = "") { console.log(s); logLines.push(s); }
function artifact(name, content) { try { writeFileSync(join(RUN_DIR, name), content); } catch (e) { log("WARN: artifact " + name + " failed: " + e.message); } }
function flushLog() { try { writeFileSync(join(RUN_DIR, "run.log"), logLines.join("\n")); } catch {} }

// ---------- helpers ----------
const git = (a) => gitCli(TARGET, a, cfg.bins.git || "git");
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : (s || ""); }
function commonDir(files) {
  const abs = (files || []).filter(Boolean).map((f) => resolve(TARGET, f));
  if (!abs.length) return TARGET;
  const split = abs.map((p) => p.split(/[\\/]/));
  const first = split[0];
  const common = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (split.every((s) => s[i] === seg)) common.push(seg); else break;
  }
  let d = common.join("/");
  if (d && existsSync(d)) { try { if (statSync(d).isFile()) d = dirname(d); } catch {} }
  return d && existsSync(d) ? d : TARGET;
}

// Capture a candidate's full change set then restore tree to baseline.
async function captureCandidate() {
  await git(["add", "-A"]);
  const patch = (await git(["diff", "--cached", "HEAD"])).stdout;
  await git(["reset", "--hard", "HEAD"]);
  await git(["clean", "-fd"]);
  return patch;
}
async function applyCandidate(patchPath, it) {
  const ap = await git(["apply", "--whitespace=fix", patchPath]);
  if (ap.code !== 0) {
    log(`consilium apply FAILED (code=${ap.code}): ${(ap.stderr || "").trim()}`);
    artifact(`consilium.${it}.apply-error.log`, ap.stderr || "");
  }
  return ap.code === 0;
}
// `git diff HEAD` omits untracked NEW files — intent-to-add surfaces them.
async function captureDiff() {
  await git(["add", "-N", "."]);
  const diff = (await git(["diff", "HEAD"])).stdout;
  await git(["reset", "-q"]);
  return diff;
}
async function runExecutor(who, message, isContinue) {
  if (who === "gemini") {
    return callGemini(message, execModel || cfg.geminiExecutor.model,
      { cwd: TARGET, runDir: RUN_DIR, geminiBin: cfg.bins.gemini });
  }
  return callMimo(message, isContinue, execModel || cfg.roles.executor.model,
    { cwd: TARGET, runDir: RUN_DIR, mimoBin: cfg.bins.mimo, agent: cfg.roles.executor.agent, useFileFlag: cfg.designSystem.mimoUseFileFlag });
}

// ---------- mimo lock ----------
async function withMimoLock(fn) {
  if (!USE_MIMO_LOCK) return fn();
  const staleMs = (cfg.limits?.execTimeoutMs ?? 900000) + 60000; // exec timeout + 1 min buffer
  const start = Date.now();
  while (true) {
    try {
      const fd = openSync(MIMO_LOCK_FILE, "wx");
      try { writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}`); } catch {}
      closeSync(fd);
      try { return await fn(); }
      finally { try { unlinkSync(MIMO_LOCK_FILE); } catch {} }
    } catch (e) {
      if (e.code !== "EEXIST") { log("WARN mimo-lock: " + e.message + "; running unlocked"); return fn(); }
      // Steal stale lock
      try {
        const st = statSync(MIMO_LOCK_FILE);
        if (Date.now() - st.mtimeMs > staleMs) {
          log("mimo-lock: stealing stale lock (prior run likely died)");
          try { unlinkSync(MIMO_LOCK_FILE); } catch {}
          continue;
        }
      } catch {}
      if (Date.now() - start > MIMO_LOCK_TIMEOUT_MS) {
        log(`mimo-lock: timeout waiting (${MIMO_LOCK_TIMEOUT_MS / 1000}s); running unlocked`);
        return fn();
      }
      log("mimo-lock: locked by another instance — waiting 5s...");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------- budget checker ----------
function checkBudget(usage) {
  if (!BUDGET_USD || BUDGET_USD <= 0) return { ok: true, spent: 0, remaining: Infinity };
  const spent = usage.snapshotTotals().est_cost_usd;
  const remaining = BUDGET_USD - spent;
  if (remaining <= 0) {
    log(`BUDGET EXCEEDED: spent $${spent.toFixed(4)} / $${BUDGET_USD}`);
    return { ok: false, spent, remaining: 0 };
  }
  if (remaining < BUDGET_USD * 0.1) {
    log(`BUDGET WARNING: $${remaining.toFixed(4)} remaining of $${BUDGET_USD}`);
  }
  return { ok: true, spent, remaining };
}

// ---------- spec pre-validation ----------
function validateSpec(spec) {
  const s = spec || {};
  const missing = (s.relevant_files || []).filter((f) => f && !existsSync(resolve(TARGET, f)));
  if (missing.length) log(`WARN spec-validate: ${missing.length} relevant_file(s) not found in target: ${missing.join(", ")}`);
  if (!(s.acceptance_criteria || []).length) log("WARN spec-validate: spec has no acceptance_criteria");
}

// ---------- escalating reviewer ----------
// Calls Sonnet first; if score < ESCALATE_THRESHOLD or has blocking issues, escalates to Opus.
// Always uses the primary (Opus) model when escalation is off or escalation model matches primary.
async function callReviewer(prompt, label, opts) {
  const primaryModel = cfg.roles.reviewer.model;
  if (!ESCALATE_REVIEWER || !ESCALATE_MODEL || ESCALATE_MODEL === primaryModel) {
    return callOpus(primaryModel, prompt, label, opts);
  }
  log(`  reviewer: fast pass with ${ESCALATE_MODEL}...`);
  const fast = await callOpus(ESCALATE_MODEL, prompt, `${label}-fast`, opts);
  usage.record({ phase: `review-fast`, agent: "opus", model: ESCALATE_MODEL, envelope: fast.envelope });
  const fastVerdict = extractJson(fast.text) || {};
  const score = typeof fastVerdict.score === "number" ? fastVerdict.score : 0;
  const hasBlocking = (fastVerdict.blocking_issues || []).length > 0 || fastVerdict.approved === false;
  if (score >= ESCALATE_THRESHOLD && !hasBlocking) {
    log(`  reviewer: ${ESCALATE_MODEL} score=${score} >= ${ESCALATE_THRESHOLD}, no blocking → accepted`);
    return fast;
  }
  log(`  reviewer: ${ESCALATE_MODEL} score=${score} < ${ESCALATE_THRESHOLD} or blocking → escalating to ${primaryModel}`);
  return callOpus(primaryModel, prompt, label, opts);
}

// ---------- dual-candidate execution (lite-consilium / parallel-exec) ----------
// Runs mimo then gemini sequentially (shared working tree prevents true parallel),
// captures each patch, then read-only Opus arbiter picks the winner and applies it.
// Falls back to single executor if gemini bin is missing.
async function runDualCandidates(it, execMessage, tokens) {
  if ((await git(["status", "--short"])).stdout.trim()) {
    log("WARN dual-candidates: working tree dirty — falling back to single executor");
    return runExecutor(EXECUTOR, execMessage, it > 1);
  }
  const cands = {};
  const runners = ["mimo"];
  if (cfg.bins.gemini) runners.push("gemini"); else log("  dual-candidates: gemini bin not configured — mimo only");

  for (const who of runners) {
    log(`  dual-candidates: running ${who}...`);
    await runExecutor(who, execMessage, false);
    usage.record({ phase: `dual-${who}-${it}`, agent: who, model: execModel || "" });
    cands[who] = await captureCandidate();
    artifact(`cand.${who}.${it}.patch`, cands[who]);
  }

  if (Object.keys(cands).length < 2) {
    // Only one candidate — skip arbitration, apply directly
    const only = Object.keys(cands)[0];
    if (cands[only]) {
      await applyCandidate(join(RUN_DIR, `cand.${only}.${it}.patch`), it);
    }
    return { code: 0, timedOut: false };
  }

  // Read-only Opus arbiter picks the best candidate
  log(`  dual-candidates: Opus arbiter choosing best of [${Object.keys(cands).join(", ")}]...`);
  const arbRes = await callOpus(cfg.roles.reviewer.model,
    P.consiliumArbiterPrompt({}, [], cands, tokens),
    `dual-arbiter-${it}`, { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude });
  usage.record({ phase: `dual-arbiter-${it}`, agent: "opus", model: cfg.roles.reviewer.model, envelope: arbRes.envelope });
  const cv = extractJson(arbRes.text) || { chosen_candidate: Object.keys(cands)[0] };
  artifact(`dual-arbiter.${it}.json`, JSON.stringify(cv, null, 2));
  const winner = (cands[cv.chosen_candidate] != null) ? cv.chosen_candidate : Object.keys(cands)[0];
  log(`  dual-candidates: winner = ${winner} (${cv.rationale ? cv.rationale.slice(0, 80) : ""})`);
  await applyCandidate(join(RUN_DIR, `cand.${winner}.${it}.patch`), it);
  return { code: 0, timedOut: false };
}

// module-scope so the top-level catch can flush them
let ctx = null, usage = null;

async function main() {
  log(`# Orchestration run ${stamp}`);
  log(`target   : ${TARGET}`);
  log(`executor : ${EXECUTOR} (model ${execModel || (EXECUTOR === "gemini" ? cfg.geminiExecutor.model : cfg.roles.executor.model)})`);
  log(`planner  : ${cfg.roles.orchestrator.cli} (${PLANNER_MODEL})`);
  log(`reviewer : ${cfg.roles.reviewer.cli} (${cfg.roles.reviewer.model})${ESCALATE_REVIEWER ? " escalate=" + ESCALATE_MODEL + "@" + ESCALATE_THRESHOLD : ""}  max-iters=${MAX_ITERS}`);
  log(`phases   : tdd=${!!(args.tdd || cfg.phases.testDesigner)} dual=${!!(args.dualReview || cfg.phases.secondReviewer)} render=${!!(args.render || cfg.phases.render)} audit=${!!(args.audit || cfg.phases.audits)} ux-copy=${!!(args.uxCopy || cfg.phases.uxCopy)} consilium=${!!args.consilium} lite-consilium=${LITE_CONSILIUM} parallel-exec=${PARALLEL_EXEC}`);
  if (BUDGET_USD > 0) log(`budget   : $${BUDGET_USD}`);
  if (args.resume) log(`resume   : ${args.resume}`);
  log(`task     : ${TASK.replace(/\s+/g, " ").slice(0, 200)}`);
  log("");

  if (DRY) {
    log("[DRY RUN] No CLIs invoked. Planner prompt that WOULD be sent:\n");
    const prompt = P.plannerPrompt(TASK, {}, "", !!args.consilium);
    log(prompt);
    artifact("planner.prompt.txt", prompt);
    flushLog();
    log("\n[DRY RUN] complete. Re-run without --dry-run to execute.");
    return;
  }

  if ((await git(["rev-parse", "--is-inside-work-tree"])).stdout.trim() !== "true") {
    log(`ERROR: ${TARGET} is not inside a git work tree. The reviewer diffs against HEAD.`);
    flushLog(); process.exit(2);
  }
  const baseRef = (await git(["rev-parse", "HEAD"])).stdout.trim();
  log(`baseline HEAD: ${baseRef}\n`);

  ctx = await loadContext({ projectDir: TARGET, skillRoot: __dirname, runDir: RUN_DIR, cfg });
  usage = createUsage({ runDir: RUN_DIR, runStamp: stamp, cfg });

  // ========== RESUME: load prior spec + verdict, skip scan/plan ==========
  let spec = null;
  let lastFinal = null;
  let startIter = 1;

  if (args.resume) {
    const resumeDir = resolve(args.resume);
    const specPath = join(resumeDir, "spec.json");
    if (!existsSync(specPath)) {
      log(`ERROR: --resume: no spec.json found in ${resumeDir}`);
      flushLog(); process.exit(1);
    }
    try {
      spec = JSON.parse(readFileSync(specPath, "utf8"));
      log(`RESUME: loaded spec from ${resumeDir}`);
    } catch (e) {
      log(`ERROR: --resume: failed to parse spec.json: ${e.message}`);
      flushLog(); process.exit(1);
    }
    // Find the last completed review
    for (let ri = MAX_ITERS; ri >= 1; ri--) {
      const rp = join(resumeDir, `review.${ri}.json`);
      if (existsSync(rp)) {
        try { lastFinal = JSON.parse(readFileSync(rp, "utf8")); startIter = ri + 1; } catch {}
        break;
      }
    }
    log(`RESUME: last review was iter ${startIter - 1}, resuming from iter ${startIter}`);
    artifact("spec.json", JSON.stringify(spec, null, 2)); // copy to new run dir
  }

  // ========== [S] DESIGN-SCAN (skipped on resume) ==========
  let tokens = {};
  let VERIFY = args.verify != null ? args.verify : (cfg.verifyCommand || "");

  if (!spec) {
    log("== [S] DESIGN-SCAN ==");
    const det = await detectStack(TARGET);
    const stack = det.stack;
    log(`stack: ${stack} (confidence ${det.confidence})`);
    const files = resolveDesignFiles(TARGET, stack, cfg);
    let reused = false;
    try { reused = !!ctx.checkReuse(files); } catch {}
    tokens = extractDesignTokens(files, stack, { fillGaps: cfg.designSystem.fillGreenfieldGaps });
    artifact("design-tokens.json", JSON.stringify(tokens, null, 2));
    try { ctx.applyStack(det); ctx.applyDesignTokens(tokens); } catch (e) { log("WARN ctx scan: " + e.message); }
    log(`design files: ${files.length}${reused ? " (unchanged since last run)" : ""}  tokens: colors=${Object.keys(tokens.colors || {}).length} spacing=${Object.keys(tokens.spacing || {}).length}`);

    VERIFY = args.verify != null ? args.verify : (cfg.verifyCommand || detectVerifyCmd(TARGET, stack));
    if (VERIFY) log(`verify: ${VERIFY}`);
  } else {
    log("== [S] DESIGN-SCAN: skipped (resume mode) ==");
    // Try to load prior tokens from the resume dir for prompt cache warming
    const tokPath = join(resolve(args.resume), "design-tokens.json");
    if (existsSync(tokPath)) {
      try { tokens = JSON.parse(readFileSync(tokPath, "utf8")); } catch {}
    }
    if (VERIFY) log(`verify: ${VERIFY}`);
  }

  const refResult = REF_DIR
    ? await ingestReferences([REF_DIR], { runDir: RUN_DIR, cfg, log })
    : { ok: false, refs: [] };
  if (REF_DIR) log(`references: ${refResult.ok ? refResult.refs.length + " image(s)" : "none (" + (refResult.reason || "n/a") + ")"}`);
  log("");

  // ========== [C3] TEST-DESIGN (optional, skip on resume) ==========
  if (!spec && (args.tdd || cfg.phases.testDesigner)) {
    log("== [C3] TEST-DESIGN (Opus) ==");
    const tRes = await callOpus(cfg.roles.orchestrator.model,
      P.testDesignerPrompt(TASK, {}, tokens, sliceForAgent(ctx, "planner")),
      "00-test-plan", { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude });
    usage.record({ phase: "test-design", agent: "opus", model: cfg.roles.orchestrator.model, envelope: tRes.envelope });
    artifact("test-plan.json", JSON.stringify(extractJson(tRes.text) || { error: "unparseable" }, null, 2));
    log("");
  }

  // ========== [1] PLAN (skip on resume) ==========
  if (!spec) {
    log(`== [1] PLAN (${PLANNER_MODEL === cfg.roles.orchestrator.model ? "Opus" : PLANNER_MODEL + " (fast planner)"}) ==`);
    const planBundle = buildImageBundle({ ok: false, shots: [] }, refResult, "plan", cfg);
    const planRes = await callOpus(PLANNER_MODEL,
      P.plannerPrompt(TASK, tokens, sliceForAgent(ctx, "planner"), !!args.consilium) + (planBundle.imageManifestMd || ""),
      "01-plan", { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude, addDirs: planBundle.addDirs });
    usage.record({ phase: "plan", agent: "opus", model: PLANNER_MODEL, envelope: planRes.envelope });
    spec = extractJson(planRes.text);
    if (!spec) { log("ERROR: planner did not return parseable JSON. See 01-plan.raw.txt"); try { await usage.flush(); } catch {} try { await ctxFlush(ctx); } catch {} flushLog(); process.exit(1); }
    artifact("spec.json", JSON.stringify(spec, null, 2));
    try { ctx.applySpec(spec); } catch (e) { log("WARN ctx spec: " + e.message); }
    log("spec.summary: " + (spec.summary || ""));
    log("acceptance_criteria:\n" + (spec.acceptance_criteria || []).map((c) => "  - " + c).join("\n"));

    // Spec pre-validation (warn only — never fatal)
    validateSpec(spec);
  }

  const heavySteps = (spec.steps || []).filter((s) => s.heavy === true);
  const consiliumOn = cfg.roles.orchestrator.canWrite && !!args.consilium && heavySteps.length > 0;
  if (heavySteps.length && !consiliumOn && !LITE_CONSILIUM) {
    log(`NOTE: ${heavySteps.length} heavy step(s) flagged but consilium is OFF (needs roles.orchestrator.canWrite=true AND --consilium). Using normal executor.`);
  }
  if (consiliumOn) log(`CONSILIUM enabled (heavy steps: ${heavySteps.map((s) => s.id).join(", ")}).`);
  if (LITE_CONSILIUM) log(`LITE-CONSILIUM enabled (read-only dual candidates on heavy steps).`);
  if (PARALLEL_EXEC) log(`PARALLEL-EXEC enabled (dual candidates on every iteration).`);
  log("");

  let approved = false, finalIt = 0;

  for (let it = startIter; it <= MAX_ITERS; it++) {
    let execCode = 0, execTimedOut = false;

    // ========== Budget check before expensive executor call ==========
    const budgetState = checkBudget(usage);
    if (!budgetState.ok) { log("BUDGET: stopping — ceiling exceeded."); break; }
    // Disable optional phases if > 90% consumed
    const budgetTight = BUDGET_USD > 0 && budgetState.remaining < BUDGET_USD * 0.1;
    if (budgetTight) log("BUDGET: < 10% remaining — optional phases (audit/dual-review) disabled this iteration");

    // ========== [2|E] EXECUTE or CONSILIUM or DUAL-CANDIDATES ==========
    const useParallelThisIter = PARALLEL_EXEC || (LITE_CONSILIUM && it > 0);
    const useLiteConsil = LITE_CONSILIUM && heavySteps.length > 0;

    if (consiliumOn) {
      // --- Full CONSILIUM (canWrite, heavy steps only) ---
      log(`== [E.${it}] CONSILIUM ==`);
      if ((await git(["status", "--short"])).stdout.trim()) {
        log("ABORT consilium: working tree is dirty (would risk user work). Falling back to single executor.");
        const ex = await runExecutor(EXECUTOR, P.executorMessage(spec, TASK, sliceForAgent(ctx, "executor")), it > 1);
        execCode = ex.code; execTimedOut = !!ex.timedOut;
        artifact(`exec.${it}.log`, (ex.stdout || "") + "\n----STDERR----\n" + (ex.stderr || ""));
      } else {
        const cands = {};
        for (const who of ["mimo", "gemini"]) {
          await runExecutor(who, P.consiliumExecMsg(spec, heavySteps, lastFinal), false);
          usage.record({ phase: `consilium-${who}-${it}`, agent: who, model: execModel || "" });
          cands[who] = await captureCandidate();
          artifact(`cand.${who}.${it}.patch`, cands[who]);
        }
        const heavyRoot = commonDir(heavySteps.flatMap((s) => s.files || []));
        const cRes = await callOpusWrite(P.consiliumWritePrompt(spec, heavySteps, "opus", "fresh independent build of the heavy slice", tokens),
          `E-build-${it}`, { dir: heavyRoot, runDir: RUN_DIR, claudeBin: cfg.bins.claude });
        usage.record({ phase: `consilium-build-${it}`, agent: "opus", model: "opus", envelope: cRes.envelope });
        cands.opus = await captureCandidate();
        artifact(`cand.opus.${it}.patch`, cands.opus);

        const aRes = await callOpus(cfg.roles.reviewer.model,
          P.consiliumArbiterPrompt(spec, heavySteps, cands, tokens), `E-arbiter-${it}`,
          { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude });
        usage.record({ phase: `consilium-arbiter-${it}`, agent: "opus", model: cfg.roles.reviewer.model, envelope: aRes.envelope });
        const cv = extractJson(aRes.text) || { chosen_candidate: "mimo" };
        artifact(`consilium.${it}.json`, JSON.stringify(cv, null, 2));
        log(`consilium chooses: ${cv.chosen_candidate}`);
        if (cv.chosen_candidate === "mimo" || cv.chosen_candidate === "gemini") {
          await applyCandidate(join(RUN_DIR, `cand.${cv.chosen_candidate}.${it}.patch`), it);
        } else {
          const w = await callOpusWrite(P.consiliumWritePrompt(spec, heavySteps, cv.chosen_candidate, cv.synthesized_patch_notes || "", tokens),
            `E-materialize-${it}`, { dir: heavyRoot, runDir: RUN_DIR, claudeBin: cfg.bins.claude });
          usage.record({ phase: `consilium-materialize-${it}`, agent: "opus", model: "opus", envelope: w.envelope });
        }
      }
    } else if (PARALLEL_EXEC || (useLiteConsil)) {
      // --- LITE-CONSILIUM / PARALLEL-EXEC: dual candidates, read-only arbiter ---
      log(`== [${PARALLEL_EXEC ? "2P" : "EL"}.${it}] ${PARALLEL_EXEC ? "PARALLEL-EXEC" : "LITE-CONSILIUM"} ==`);
      const execMsg = it === 1
        ? P.executorMessage(spec, TASK, sliceForAgent(ctx, "executor"))
        : P.executorRetryMessage(spec, lastFinal, sliceForAgent(ctx, "executor"), {
            changedFiles: (await git(["status", "--short"])).stdout.trim().split(/\r?\n/).map((l) => l.slice(3)).filter(Boolean),
            trapsBlock: ctx.sections?.executorTraps,
          });
      await withMimoLock(() => runDualCandidates(it, execMsg, tokens));
      // execCode stays 0 (dual-candidates handles fallback internally)
    } else {
      // --- Normal EXECUTE ---
      log(`== [2.${it}] EXECUTE (${EXECUTOR}) ==`);
      const msg = it === 1
        ? P.executorMessage(spec, TASK, sliceForAgent(ctx, "executor"))
        : P.executorRetryMessage(spec, lastFinal, sliceForAgent(ctx, "executor"), {
            changedFiles: (await git(["status", "--short"])).stdout.trim().split(/\r?\n/).map((l) => l.slice(3)).filter(Boolean),
            trapsBlock: ctx.sections?.executorTraps,
          });
      const ex = await withMimoLock(() => runExecutor(EXECUTOR, msg, it > 1));
      execCode = ex.code; execTimedOut = !!ex.timedOut;
      artifact(`exec.${it}.log`, (ex.stdout || "") + "\n----STDERR----\n" + (ex.stderr || ""));
      usage.record({ phase: `execute-${it}`, agent: EXECUTOR, model: execModel || "", contextSliceChars: sliceForAgent(ctx, "executor").length });
    }
    log(`executor exit=${execCode}${execTimedOut ? " (timed out)" : ""}`);

    // ========== [diff] + GATE-EXEC ==========
    const diff = await captureDiff();
    const status = (await git(["status", "--short"])).stdout;
    artifact(`diff.${it}.patch`, diff);
    const changedLines = status.trim() ? status.trim().split(/\r?\n/) : [];
    const changedCount = changedLines.length;
    const changed = changedLines.map((l) => l.slice(3)).filter(Boolean);
    log("changed files: " + (changedCount || "(none)"));
    try { ctx.applyIteration(it, { execCode, changedCount }); } catch {}

    if (execCode !== 0 || execTimedOut || (!diff.trim() && !status.trim())) {
      lastFinal = {
        approved: false, score: 0, summary: "no-op / executor failure",
        feedback_for_executor: `Executor produced no changes / exited non-zero (code=${execCode}${execTimedOut ? ",timedOut" : ""}). Re-read the spec steps and edit the listed files.`,
      };
      artifact(`review.${it}.json`, JSON.stringify(lastFinal, null, 2));
      try { ctx.applyReview(it, lastFinal); } catch {}
      // Adaptive abort: if first iter produced nothing and score effectively 0, no point retrying
      if (it === 1 && (lastFinal.score || 0) < ABORT_SCORE && !diff.trim()) {
        log(`EARLY-ABORT: executor produced no diff on iter 1 — stopping early.`);
        break;
      }
      log("GATE: no usable changes — skipping review this iteration.");
      if (it < MAX_ITERS) { log(""); continue; } else break;
    }

    // ========== [R] RENDER (optional) ==========
    const rr = (args.render || cfg.phases.render)
      ? await render(TARGET, (cfg.frontMatter?.stack || "generic"), changed, { runDir: RUN_DIR, cfg, log, refImages: refResult.refs })
      : { ok: false, reason: "render-disabled", shots: [], skipped: [], warnings: [] };
    if (!rr.ok) log(`render: skipped (${rr.reason}) — text-only review.`);
    else log(`render: ${rr.shots.length} screenshot(s) via ${rr.engine}`);
    const reviewBundle = buildImageBundle(rr, refResult, "review", cfg);
    artifact(`render.${it}.json`, JSON.stringify({ result: rr, skipped: reviewBundle.skippedNote }, null, 2));

    // ========== [V] VERIFY (optional) ==========
    let verifyOut = "";
    if (VERIFY) {
      log(`-- verify: ${VERIFY}`);
      const vBin = IS_WIN ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
      const vArgs = IS_WIN ? ["/d", "/s", "/c", VERIFY] : ["-c", VERIFY];
      const v = await runCli(vBin, vArgs, { cwd: TARGET, timeoutMs: cfg.limits.execTimeoutMs });
      verifyOut = `exit=${v.code}\n` + (v.stdout || "") + (v.stderr || "");
      artifact(`verify.${it}.log`, verifyOut);
    }

    if (args.noReview) { log("[--no-review] stopping after execution."); approved = true; break; }

    // ========== [3] REVIEW (escalating: Sonnet → Opus) ==========
    log(`== [3.${it}] REVIEW${ESCALATE_REVIEWER ? " (escalating)" : " (Opus)"} ==`);
    const refNote = (refResult.ok && rr.ok) ? "reference images attached — compare visually" : "";
    const revPrompt = P.reviewerPrompt(TASK, spec, truncate(diff, cfg.diffMaxChars), truncate(verifyOut, cfg.verifyMaxChars),
      tokens, sliceForAgent(ctx, "reviewer"), reviewBundle.imageManifestMd, refNote);
    const revRes = await callReviewer(revPrompt, `03-review-${it}`,
      { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude, addDirs: reviewBundle.addDirs });
    usage.record({ phase: `review-${it}`, agent: "opus", model: cfg.roles.reviewer.model, envelope: revRes.envelope });
    const verdict = extractJson(revRes.text) || { approved: false, feedback_for_executor: "Reviewer output unparseable; re-check vs acceptance criteria." };
    artifact(`review.${it}.json`, JSON.stringify(verdict, null, 2));
    let final = verdict;
    log(`verdict: approved=${verdict.approved} score=${verdict.score ?? "?"} — ${verdict.summary || ""}`);
    if ((verdict.blocking_issues || []).length) log("blocking:\n" + verdict.blocking_issues.map((b) => "  - " + b).join("\n"));

    // Record executor failure patterns into context (used in next retry)
    if (!verdict.approved) {
      try { ctx.applyExecutorFailure(it, verdict); } catch {}
    }

    // ========== Adaptive early-exit: score >= EARLY_EXIT_SCORE + no blocking ==========
    if (!verdict.approved && typeof verdict.score === "number"
        && verdict.score >= EARLY_EXIT_SCORE && !(verdict.blocking_issues || []).length) {
      log(`EARLY-EXIT: score ${verdict.score} >= ${EARLY_EXIT_SCORE} with no blocking issues → auto-approving`);
      final = { ...verdict, approved: true, feedback_for_executor: "" };
    }

    // ========== [C2] DUAL-REVIEW (optional, skip if budget tight) ==========
    if ((args.dualReview || cfg.phases.secondReviewer) && !budgetTight) {
      log(`== [C2.${it}] SECOND REVIEW (Gemini) + arbitration (Opus) ==`);
      const g = await callGemini(P.secondReviewerPrompt(TASK, spec, truncate(diff, cfg.diffMaxChars), truncate(verifyOut, cfg.verifyMaxChars), tokens),
        cfg.geminiExecutor.model, { cwd: TARGET, runDir: RUN_DIR, geminiBin: cfg.bins.gemini });
      usage.record({ phase: `review2-${it}`, agent: "gemini", model: cfg.geminiExecutor.model });
      const gv = extractJson(g.stdout) || { approved: false };
      artifact(`review.${it}.gemini.json`, JSON.stringify(gv, null, 2));
      const arb = await callOpus(cfg.roles.reviewer.model, P.reviewArbiterPrompt(TASK, spec, verdict, gv),
        `03-review-${it}-arb`, { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude });
      usage.record({ phase: `review-arbiter-${it}`, agent: "opus", model: cfg.roles.reviewer.model, envelope: arb.envelope });
      final = extractJson(arb.text) || verdict;
      artifact(`review.${it}.final.json`, JSON.stringify(final, null, 2));
      log(`arbitrated verdict: approved=${final.approved} score=${final.score ?? "?"}`);
    }

    // ========== [D2] REFERENCE (optional) ==========
    if (refResult.ok && rr.ok && rr.shots.length) {
      log(`== [D2.${it}] REFERENCE COMPARISON ==`);
      const cmp = await compareToReference(rr.shots, refResult.refs, { runDir: RUN_DIR, cfg, log });
      const refRes = await callOpus(cfg.roles.reviewer.model,
        P.referencePrompt(TASK, spec, tokens, rr.shots.map((s) => s.path), refResult.refs.map((r) => r.path), cmp.prePixel ? JSON.stringify(cmp.prePixel) : ""),
        `reference-${it}`, { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude, addDirs: reviewBundle.addDirs });
      usage.record({ phase: `reference-${it}`, agent: "opus", model: cfg.roles.reviewer.model, envelope: refRes.envelope });
      artifact(`reference.${it}.json`, JSON.stringify(extractJson(refRes.text) || {}, null, 2));
    }

    // ========== [C4] AUDITS (optional, final gate, skip if budget tight) ==========
    let auditsClean = true;
    if ((args.audit || cfg.phases.audits) && final.approved && !budgetTight) {
      log(`== [C4.${it}] AUDITS (a11y/perf/security/i18n) ==`);
      for (const kind of ["a11y", "perf", "security", "i18n"]) {
        const budS = checkBudget(usage);
        if (!budS.ok) { log(`BUDGET: skipping audit ${kind}`); break; }
        const au = await callOpus(cfg.roles.reviewer.model,
          P.auditPrompt(kind, TASK, spec, truncate(diff, cfg.diffMaxChars), tokens),
          `audit-${it}-${kind}`, { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude });
        usage.record({ phase: `audit-${it}-${kind}`, agent: "opus", model: cfg.roles.reviewer.model, envelope: au.envelope });
        const af = extractJson(au.text) || { findings: [] };
        artifact(`audit.${it}.${kind}.json`, JSON.stringify(af, null, 2));
        const blockers = (af.findings || []).filter((f) => f.blocking === true);
        if (blockers.length) {
          auditsClean = false;
          final.feedback_for_executor = (final.feedback_for_executor || "") + "\n" + blockers.map((b) => `- [AUDIT/${kind}] ${b.remediation || b.title}`).join("\n");
          log(`  ${kind}: ${blockers.length} blocking finding(s)`);
        }
      }
    }

    // ========== [B4] UX-WRITER (optional) ==========
    if (args.uxCopy || cfg.phases.uxCopy || (spec.design && spec.design.copy_needed)) {
      log(`== [B4.${it}] UX-WRITER ==`);
      const ux = await callOpus(cfg.roles.reviewer.model, P.uxWriterPrompt(TASK, spec, tokens, sliceForAgent(ctx, "reviewer")),
        `ux-copy-${it}`, { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude });
      usage.record({ phase: `ux-copy-${it}`, agent: "opus", model: cfg.roles.reviewer.model, envelope: ux.envelope });
      artifact(`ux-copy.${it}.json`, JSON.stringify(extractJson(ux.text) || {}, null, 2));
    }

    lastFinal = final;
    finalIt = it;
    try { ctx.applyReview(it, final); } catch {}
    approved = !!final.approved && auditsClean;
    if (approved) break;
    if (it < MAX_ITERS) log("-> feeding feedback back to executor...\n");

    // Adaptive abort: very low score + another chance would waste budget
    if (typeof final.score === "number" && final.score < ABORT_SCORE && it < MAX_ITERS) {
      log(`EARLY-ABORT: score ${final.score} < ${ABORT_SCORE} — executor not converging, stopping early.`);
      break;
    }
  }

  // ========== [RESULT] ==========
  log("\n== RESULT ==");
  log(approved ? "APPROVED ✅" : `NOT APPROVED after ${finalIt || MAX_ITERS} iteration(s) ❌`);

  // Cost summary
  try {
    const totals = usage.snapshotTotals();
    log(`cost     : $${totals.est_cost_usd.toFixed(4)}  (baseline $${totals.baseline_all_opus_est.toFixed(4)}, savings ≈${totals.savings_pct}%)`);
    if (PLANNER_MODEL !== cfg.roles.orchestrator.model) {
      const plannerCalls = (totals.by_agent?.opus?.calls || 0);
      log(`           planner model: ${PLANNER_MODEL}${plannerCalls ? " (" + plannerCalls + " Opus call(s) total)" : ""}`);
    }
  } catch {}

  try { await usage.flush(); } catch (e) { log("WARN usage.flush: " + e.message); }
  try { await ctxFlush(ctx); snapshotToRun(ctx); } catch (e) { log("WARN ctx.flush: " + e.message); }
  log(`artifacts: ${RUN_DIR}`);
  flushLog();
  process.exit(approved ? 0 : 1);
}

main().catch(async (e) => {
  log("FATAL: " + (e.stack || e));
  try { if (usage) await usage.flush(); } catch {}
  try { if (ctx) await ctxFlush(ctx); } catch {}
  flushLog();
  process.exit(1);
});
