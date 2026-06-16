#!/usr/bin/env node
/**
 * orchestrate.mjs — universal /orchestra pipeline (v2).
 *
 *   Opus (claude)  : DESIGNER (PLAN) + REVIEWER (REVIEW), read-only by default.
 *                    In CONSILIUM only (and only for heavy steps), ARBITER that may WRITE.
 *   MiMoCode       : primary EXECUTOR (writes code).
 *   Gemini         : alternate executor (--executor gemini) + 2nd reviewer (--dual-review).
 *
 * Flow: DESIGN-SCAN -> [C3 test] -> PLAN -> { EXECUTE|CONSILIUM -> diff -> GATE -> RENDER -> VERIFY
 *        -> REVIEW -> C2 -> D2 -> C4 audits -> B4 ux-copy -> ctx }* until approved or max-iters.
 *
 * The orchestrator only edits files in --dir (default: cwd). Opus is read-only except consilium.
 * See _design/00_SYNTHESIS.md for the locked design.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
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
    else if (t === "--no-review") a.noReview = true;
    else if (t === "--tdd") a.tdd = true;
    else if (t === "--dual-review") a.dualReview = true;
    else if (t === "--render") a.render = true;
    else if (t === "--audit") a.audit = true;
    else if (t === "--ux-copy") a.uxCopy = true;
    else if (t === "--consilium") a.consilium = true;
    else if (t === "--ref-dir") a.refDir = argv[++i];
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
  // A single heavy file yields a FILE path — demote to its directory so --add-dir scopes correctly.
  if (d && existsSync(d)) { try { if (statSync(d).isFile()) d = dirname(d); } catch {} }
  return d && existsSync(d) ? d : TARGET;
}

// Capture a candidate's full change set INCLUDING new/untracked files (git diff HEAD alone drops
// untracked files, then clean -fd would destroy them), then restore the tree to baseline.
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
// `git diff HEAD` omits untracked NEW files — and creating files is the common case, so the
// reviewer would otherwise get an empty diff. Intent-to-add surfaces new files in the diff;
// `reset -q` then clears the intent (worktree untouched, files stay untracked).
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

// module-scope so the top-level catch can flush them
let ctx = null, usage = null;

async function main() {
  log(`# Orchestration run ${stamp}`);
  log(`target   : ${TARGET}`);
  log(`executor : ${EXECUTOR} (model ${execModel || (EXECUTOR === "gemini" ? cfg.geminiExecutor.model : cfg.roles.executor.model)})`);
  log(`reviewer : ${cfg.roles.reviewer.cli} (${cfg.roles.reviewer.model})  max-iters=${MAX_ITERS}`);
  log(`phases   : tdd=${!!(args.tdd || cfg.phases.testDesigner)} dual=${!!(args.dualReview || cfg.phases.secondReviewer)} render=${!!(args.render || cfg.phases.render)} audit=${!!(args.audit || cfg.phases.audits)} ux-copy=${!!(args.uxCopy || cfg.phases.uxCopy)} consilium=${!!args.consilium}`);
  log(`task     : ${TASK.replace(/\s+/g, " ").slice(0, 200)}`);
  log("");

  if (DRY) {
    log("[DRY RUN] No CLIs invoked. Planner prompt that WOULD be sent to Opus:\n");
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

  // [S] DESIGN-SCAN (graceful; all-local/non-LLM, so always cheap to run)
  log("== [S] DESIGN-SCAN ==");
  const det = await detectStack(TARGET);
  const stack = det.stack;
  log(`stack: ${stack} (confidence ${det.confidence})`);
  const files = resolveDesignFiles(TARGET, stack, cfg);
  let reused = false;
  try { reused = !!ctx.checkReuse(files); } catch {}
  const tokens = extractDesignTokens(files, stack, { fillGaps: cfg.designSystem.fillGreenfieldGaps });
  artifact("design-tokens.json", JSON.stringify(tokens, null, 2));
  try { ctx.applyStack(det); ctx.applyDesignTokens(tokens); } catch (e) { log("WARN ctx scan: " + e.message); }
  log(`design files: ${files.length}${reused ? " (unchanged since last run)" : ""}  tokens: colors=${Object.keys(tokens.colors || {}).length} spacing=${Object.keys(tokens.spacing || {}).length}`);

  const VERIFY = args.verify != null ? args.verify : (cfg.verifyCommand || detectVerifyCmd(TARGET, stack));
  if (VERIFY) log(`verify: ${VERIFY}`);

  const refResult = REF_DIR
    ? await ingestReferences([REF_DIR], { runDir: RUN_DIR, cfg, log })
    : { ok: false, refs: [] };
  if (REF_DIR) log(`references: ${refResult.ok ? refResult.refs.length + " image(s)" : "none (" + (refResult.reason || "n/a") + ")"}`);
  log("");

  // [C3] TEST-DESIGN (pre-code) — optional
  if (args.tdd || cfg.phases.testDesigner) {
    log("== [C3] TEST-DESIGN (Opus) ==");
    const tRes = await callOpus(cfg.roles.orchestrator.model,
      P.testDesignerPrompt(TASK, {}, tokens, sliceForAgent(ctx, "planner")),
      "00-test-plan", { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude });
    usage.record({ phase: "test-design", agent: "opus", model: cfg.roles.orchestrator.model, envelope: tRes.envelope });
    artifact("test-plan.json", JSON.stringify(extractJson(tRes.text) || { error: "unparseable" }, null, 2));
    log("");
  }

  // [1] PLAN
  log("== [1] PLAN (Opus designer) ==");
  const planBundle = buildImageBundle({ ok: false, shots: [] }, refResult, "plan", cfg);
  const planRes = await callOpus(cfg.roles.orchestrator.model,
    P.plannerPrompt(TASK, tokens, sliceForAgent(ctx, "planner"), !!args.consilium) + (planBundle.imageManifestMd || ""),
    "01-plan", { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude, addDirs: planBundle.addDirs });
  usage.record({ phase: "plan", agent: "opus", model: cfg.roles.orchestrator.model, envelope: planRes.envelope });
  const spec = extractJson(planRes.text);
  if (!spec) { log("ERROR: planner did not return parseable JSON. See 01-plan.raw.txt"); try { await usage.flush(); } catch {} try { await ctxFlush(ctx); } catch {} flushLog(); process.exit(1); }
  artifact("spec.json", JSON.stringify(spec, null, 2));
  try { ctx.applySpec(spec); } catch (e) { log("WARN ctx spec: " + e.message); }
  log("spec.summary: " + (spec.summary || ""));
  log("acceptance_criteria:\n" + (spec.acceptance_criteria || []).map((c) => "  - " + c).join("\n"));

  const heavySteps = (spec.steps || []).filter((s) => s.heavy === true);
  // 3-gate (locked & safe): explicit write opt-in AND explicit --consilium AND a planner-flagged heavy step.
  const consiliumOn = cfg.roles.orchestrator.canWrite && !!args.consilium && heavySteps.length > 0;
  if (heavySteps.length && !consiliumOn) {
    log(`NOTE: ${heavySteps.length} heavy step(s) flagged but consilium is OFF (needs roles.orchestrator.canWrite=true AND --consilium). Using normal executor.`);
  }
  if (consiliumOn) log(`CONSILIUM enabled (heavy steps: ${heavySteps.map((s) => s.id).join(", ")}).`);
  log("");

  let approved = false, lastFinal = null;

  for (let it = 1; it <= MAX_ITERS; it++) {
    let execCode = 0, execTimedOut = false;

    // [2|E] EXECUTE or CONSILIUM
    if (consiliumOn) {
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
    } else {
      log(`== [2.${it}] EXECUTE (${EXECUTOR}) ==`);
      const msg = it === 1
        ? P.executorMessage(spec, TASK, sliceForAgent(ctx, "executor"))
        : P.executorRetryMessage(spec, lastFinal, sliceForAgent(ctx, "executor"));
      const ex = await runExecutor(EXECUTOR, msg, it > 1);
      execCode = ex.code; execTimedOut = !!ex.timedOut;
      artifact(`exec.${it}.log`, (ex.stdout || "") + "\n----STDERR----\n" + (ex.stderr || ""));
      usage.record({ phase: `execute-${it}`, agent: EXECUTOR, model: execModel || "", contextSliceChars: sliceForAgent(ctx, "executor").length });
    }
    log(`executor exit=${execCode}${execTimedOut ? " (timed out)" : ""}`);

    // [diff] + GATE-EXEC (BUG-5). captureDiff includes untracked NEW files (git diff HEAD drops them).
    const diff = await captureDiff();
    const status = (await git(["status", "--short"])).stdout;
    artifact(`diff.${it}.patch`, diff);
    const changedCount = status.trim() ? status.trim().split(/\r?\n/).length : 0;
    log("changed files: " + (changedCount || "(none)"));
    try { ctx.applyIteration(it, { execCode, changedCount }); } catch {}

    if (execCode !== 0 || execTimedOut || (!diff.trim() && !status.trim())) {
      lastFinal = {
        approved: false, score: 0, summary: "no-op / executor failure",
        feedback_for_executor: `Executor produced no changes / exited non-zero (code=${execCode}${execTimedOut ? ",timedOut" : ""}). Re-read the spec steps and edit the listed files.`,
      };
      artifact(`review.${it}.json`, JSON.stringify(lastFinal, null, 2));
      try { ctx.applyReview(it, lastFinal); } catch {}
      log("GATE: no usable changes — skipping review this iteration.");
      if (it < MAX_ITERS) { log(""); continue; } else break;
    }

    // [R] RENDER (optional, graceful)
    const changed = status.trim().split(/\r?\n/).map((l) => l.slice(3)).filter(Boolean);
    const rr = (args.render || cfg.phases.render)
      ? await render(TARGET, stack, changed, { runDir: RUN_DIR, cfg, log, refImages: refResult.refs })
      : { ok: false, reason: "render-disabled", shots: [], skipped: [], warnings: [] };
    if (!rr.ok) log(`render: skipped (${rr.reason}) — text-only review.`);
    else log(`render: ${rr.shots.length} screenshot(s) via ${rr.engine}`);
    const reviewBundle = buildImageBundle(rr, refResult, "review", cfg);
    artifact(`render.${it}.json`, JSON.stringify({ result: rr, skipped: reviewBundle.skippedNote }, null, 2));

    // [V] VERIFY (optional) — BUG-3: POSIX uses /bin/sh
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

    // [3] REVIEW (primary)
    log(`== [3.${it}] REVIEW (Opus) ==`);
    const refNote = (refResult.ok && rr.ok) ? "reference images attached — compare visually" : "";
    const revRes = await callOpus(cfg.roles.reviewer.model,
      P.reviewerPrompt(TASK, spec, truncate(diff, cfg.diffMaxChars), truncate(verifyOut, cfg.verifyMaxChars),
        tokens, sliceForAgent(ctx, "reviewer"), reviewBundle.imageManifestMd, refNote),
      `03-review-${it}`, { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude, addDirs: reviewBundle.addDirs });
    usage.record({ phase: `review-${it}`, agent: "opus", model: cfg.roles.reviewer.model, envelope: revRes.envelope });
    const verdict = extractJson(revRes.text) || { approved: false, feedback_for_executor: "Reviewer output unparseable; re-check vs acceptance criteria." };
    artifact(`review.${it}.json`, JSON.stringify(verdict, null, 2));
    let final = verdict;
    log(`verdict: approved=${verdict.approved} score=${verdict.score ?? "?"} — ${verdict.summary || ""}`);
    if ((verdict.blocking_issues || []).length) log("blocking:\n" + verdict.blocking_issues.map((b) => "  - " + b).join("\n"));

    // [C2] DUAL-REVIEW
    if (args.dualReview || cfg.phases.secondReviewer) {
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

    // [D2] REFERENCE (optional, advisory)
    if (refResult.ok && rr.ok && rr.shots.length) {
      log(`== [D2.${it}] REFERENCE COMPARISON ==`);
      const cmp = await compareToReference(rr.shots, refResult.refs, { runDir: RUN_DIR, cfg, log });
      const refRes = await callOpus(cfg.roles.reviewer.model,
        P.referencePrompt(TASK, spec, tokens, rr.shots.map((s) => s.path), refResult.refs.map((r) => r.path), cmp.prePixel ? JSON.stringify(cmp.prePixel) : ""),
        `reference-${it}`, { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude, addDirs: reviewBundle.addDirs });
      usage.record({ phase: `reference-${it}`, agent: "opus", model: cfg.roles.reviewer.model, envelope: refRes.envelope });
      artifact(`reference.${it}.json`, JSON.stringify(extractJson(refRes.text) || {}, null, 2));
    }

    // [C4] AUDITS — final gate, only when review approved
    let auditsClean = true;
    if ((args.audit || cfg.phases.audits) && final.approved) {
      log(`== [C4.${it}] AUDITS (a11y/perf/security/i18n) ==`);
      for (const kind of ["a11y", "perf", "security", "i18n"]) {
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

    // [B4] UX-WRITER (optional, advisory)
    if (args.uxCopy || cfg.phases.uxCopy || (spec.design && spec.design.copy_needed)) {
      log(`== [B4.${it}] UX-WRITER ==`);
      const ux = await callOpus(cfg.roles.reviewer.model, P.uxWriterPrompt(TASK, spec, tokens, sliceForAgent(ctx, "reviewer")),
        `ux-copy-${it}`, { dir: TARGET, runDir: RUN_DIR, claudeBin: cfg.bins.claude });
      usage.record({ phase: `ux-copy-${it}`, agent: "opus", model: cfg.roles.reviewer.model, envelope: ux.envelope });
      artifact(`ux-copy.${it}.json`, JSON.stringify(extractJson(ux.text) || {}, null, 2));
    }

    lastFinal = final;
    try { ctx.applyReview(it, final); } catch {}
    approved = !!final.approved && auditsClean;
    if (approved) break;
    if (it < MAX_ITERS) log("-> feeding feedback back to executor...\n");
  }

  // [RESULT]
  log("\n== RESULT ==");
  log(approved ? "APPROVED ✅" : `NOT APPROVED after ${MAX_ITERS} iterations ❌`);
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
