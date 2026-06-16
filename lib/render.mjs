/**
 * lib/render.mjs — PERCEPTUAL (A) + REFERENCE-DRIVEN (D2) visual-review layer.
 *
 * Strictly optional-by-design. Every path that touches external infra (Gradle, adb,
 * Playwright, browsers, SDKs) is wrapped so a missing tool yields { ok:false, reason }
 * — never a throw, never a non-zero pipeline exit. The orchestrator degrades to a
 * text-only review with a logged WARN.
 *
 * KEY MECHANISM (how Opus "sees" images): Claude Code's Read tool RENDERS PNGs.
 * buildImageBundle() returns absolute PNG paths + an imageManifestMd that the review
 * prompt embeds (instructing Opus to Read each path), plus addDirs (runDir, runDir/refs)
 * so callOpus passes --add-dir and Read is permitted outside TARGET.
 *
 * HARD RULES (locked):
 *   - NO auto-install. NO target mutation. NO gradle-plugin-add / npm-install /
 *     browser-download. render only *consumes* infra the project already declares.
 *   - stack not android-compose / web-* -> reason:'unsupported-stack'.
 *   - screenshot infra absent -> reason:'no-screenshot-infra'.
 *   - All ShotRef.path are ABSOLUTE.
 *
 * Node v20 ESM, Node built-ins only.
 *
 * Exports (synthesis §2):
 *   render(dir, stack, changedFiles, { runDir, cfg, log, refImages }) -> RenderResult   (never throws)
 *   ingestReferences(refSpecs, { runDir, cfg, log })                  -> { ok, refs, reason?, skipped }
 *   compareToReference(shots, refs, opts)                            -> { ok, pairs, prePixel?, reason? }
 *   buildImageBundle(renderResult, refResult, role, cfg)             -> { reviewImagePaths, addDirs, imageManifestMd, skippedNote }  (PURE sync)
 *   detectRenderCapability(dir, stack, cfg)                          -> { available, engine, reason?, detail }
 *   detectThemes(dir, stack)                                         -> string[]
 */

import {
  existsSync, readdirSync, readFileSync, statSync, mkdirSync, copyFileSync, writeFileSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";

// ---------------------------------------------------------------------------
// small internal helpers (self-contained; no cross-module hard deps)
// ---------------------------------------------------------------------------

const IS_WIN = process.platform === "win32";

function noop() {}
function asLog(opts) {
  const l = opts && typeof opts.log === "function" ? opts.log : noop;
  return (s) => { try { l(s); } catch { /* logging never fatal */ } };
}

/** Normalize the stack id used by the engine tables. Granular web ids + react-native => "web". */
function normStack(stack) {
  const s = String(stack || "");
  if (s === "android-compose") return "android-compose";
  if (s.startsWith("web-") || s === "react-native") return "web";
  return s; // anything else stays as-is (=> unsupported-stack downstream)
}

/** True for the screenshot-capable families. */
function isSupportedStack(stack) {
  const n = normStack(stack);
  return n === "android-compose" || n === "web";
}

/**
 * Shallow-ish recursive directory walk, bounded, that returns absolute file paths
 * whose basename matches one of the provided basename-suffix predicates. Ignores the
 * configured ignoreDirs. Built-in only (no glob package).
 *
 * @param {string} root absolute dir
 * @param {(absPath:string,name:string)=>boolean} pred
 * @param {object} o  { ignore:Set<string>, maxDepth:number, maxHits:number, maxVisits:number }
 */
function walkFiles(root, pred, o = {}) {
  const ignore = o.ignore || new Set();
  const maxDepth = o.maxDepth ?? 8;
  const maxHits = o.maxHits ?? 2000;
  const maxVisits = o.maxVisits ?? 40000;
  const out = [];
  let visits = 0;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++visits > maxVisits) return out;
      const name = e.name;
      const abs = join(dir, name);
      if (e.isDirectory()) {
        if (ignore.has(name) || name.startsWith(".")) continue;
        stack.push({ dir: abs, depth: depth + 1 });
      } else if (e.isFile()) {
        try { if (pred(abs, name)) { out.push(abs); if (out.length >= maxHits) return out; } } catch { /* skip */ }
      }
    }
  }
  return out;
}

function ignoreSet(cfg) {
  const list = (cfg && cfg.designSystem && Array.isArray(cfg.designSystem.ignoreDirs))
    ? cfg.designSystem.ignoreDirs
    : ["node_modules", ".git", "build", ".gradle", "dist", "out", ".next", ".idea",
       ".dart_tool", "Pods", "DerivedData", "target", "vendor", ".venv", "__pycache__", "runs"];
  return new Set(list);
}

/** Read a file as text, swallowing all errors. */
function readSafe(abs) {
  try { return readFileSync(abs, "utf8"); } catch { return ""; }
}

function fileBytes(abs) {
  try { return statSync(abs).size; } catch { return 0; }
}

/** PNG / JPEG magic-byte sniff. Returns 'png' | 'jpg' | null. */
function imageKind(abs) {
  try {
    const buf = readFileSync(abs);
    if (buf.length >= 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "png";
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  } catch { /* ignore */ }
  return null;
}

function isHttpUrl(s) { return /^https?:\/\//i.test(String(s || "")); }

/** fontscale -> slug: 1.0 -> "1_0", 1.3 -> "1_3" */
function fsSlug(n) { return "fs" + String(n).replace(".", "_"); }

// ---------------------------------------------------------------------------
// detectThemes
// ---------------------------------------------------------------------------

/**
 * Resolve theme variants by grepping the project's design/theme files.
 * Self-contained: does its own shallow discovery rather than importing detect.mjs,
 * so it cannot fail at load time if a sibling module is absent.
 *
 *  - android-compose: lightColorScheme( present -> "light"; darkColorScheme( -> "dark".
 *    YOURSTART_APP has only darkColorScheme(  => ["dark"].
 *  - web: prefers-color-scheme / data-theme / .dark|.light roots -> add "dark"; default "light".
 *  - fallback when nothing detected: android -> ["dark"], web -> ["light"].
 *
 * @returns {string[]}
 */
export function detectThemes(dir, stack) {
  try {
    const root = resolve(dir);
    const n = normStack(stack);
    const ignore = new Set(["node_modules", ".git", "build", ".gradle", "dist", "out",
      ".next", ".idea", ".dart_tool", "Pods", "DerivedData", "target", "vendor",
      ".venv", "__pycache__", "runs"]);

    if (n === "android-compose") {
      const files = walkFiles(root,
        (_abs, name) => /\.kt$/i.test(name) &&
          (/theme/i.test(name) || /color/i.test(name)),
        { ignore, maxHits: 60 });
      let hasLight = false, hasDark = false;
      for (const f of files) {
        const t = readSafe(f);
        if (!hasLight && /lightColorScheme\s*\(/.test(t)) hasLight = true;
        if (!hasDark && /darkColorScheme\s*\(/.test(t)) hasDark = true;
        if (hasLight && hasDark) break;
      }
      const themes = [];
      if (hasLight) themes.push("light");
      if (hasDark) themes.push("dark");
      return themes.length ? themes : ["dark"]; // android default here is dark
    }

    if (n === "web") {
      const files = walkFiles(root,
        (_abs, name) => /\.(css|scss|sass|less|ts|tsx|js|jsx|html|vue|svelte)$/i.test(name) &&
          (/theme|token|variable|style|tailwind|global|app|index|main/i.test(name)),
        { ignore, maxHits: 120 });
      let hasDark = false, hasLight = false;
      for (const f of files) {
        const t = readSafe(f);
        if (!hasDark && (/prefers-color-scheme\s*:\s*dark/i.test(t) || /\bdata-theme\s*=?\s*["']?dark/i.test(t) ||
            /[.\[]dark\b/.test(t) || /['"]dark['"]\s*:/.test(t))) hasDark = true;
        if (!hasLight && (/prefers-color-scheme\s*:\s*light/i.test(t) || /\bdata-theme\s*=?\s*["']?light/i.test(t) ||
            /[.\[]light\b/.test(t))) hasLight = true;
        if (hasDark && hasLight) break;
      }
      const themes = [];
      themes.push("light"); // web default base is light
      if (hasDark) themes.push("dark");
      // if explicit light root found, keep it; dedupe already handled by push order
      return themes;
    }

    // unsupported families: caller won't render, but return a sane default.
    return n === "android-compose" ? ["dark"] : ["light"];
  } catch {
    return ["dark"];
  }
}

// ---------------------------------------------------------------------------
// detectRenderCapability  (probe-only; side-effect free; NEVER spawns/installs)
// ---------------------------------------------------------------------------

function getRenderCfg(cfg) {
  const r = (cfg && cfg.render) || {};
  return {
    enabled: r.enabled !== false,
    maxShots: Number.isFinite(r.maxShots) ? r.maxShots : 12,
    maxShotsToOpus: Number.isFinite(r.maxShotsToOpus) ? r.maxShotsToOpus : 6,
    shotBudgetBytes: Number.isFinite(r.shotBudgetBytes) ? r.shotBudgetBytes : 6291456,
    timeoutMs: Number.isFinite(r.timeoutMs) ? r.timeoutMs : 600000,
    reshootEachIter: r.reshootEachIter === true,
    states: Array.isArray(r.states) && r.states.length ? r.states : ["loading", "empty", "error", "success"],
    themes: Array.isArray(r.themes) ? r.themes : [],
    fontScales: Array.isArray(r.fontScales) && r.fontScales.length ? r.fontScales : [1.0, 1.3],
    widths: Array.isArray(r.widths) && r.widths.length ? r.widths : [360, 411],
    android: r.android || {},
    web: r.web || {},
    reference: r.reference || { maxRefs: 4, copyIntoRun: true, acceptThreshold: 85 },
  };
}

/** Resolve adb binary by probing SDK env/config, then PATH. Returns abs path or null. */
function resolveAdb(cfg) {
  const exe = IS_WIN ? "adb.exe" : "adb";
  const candidates = [];
  const a = (cfg && cfg.render && cfg.render.android) || {};
  if (process.env.ANDROID_HOME) candidates.push(join(process.env.ANDROID_HOME, "platform-tools", exe));
  if (process.env.ANDROID_SDK_ROOT) candidates.push(join(process.env.ANDROID_SDK_ROOT, "platform-tools", exe));
  if (a.sdkRoot) candidates.push(join(a.sdkRoot, "platform-tools", exe));
  if (IS_WIN && process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", exe));
  if (!IS_WIN && process.env.HOME) candidates.push(join(process.env.HOME, "Android", "Sdk", "platform-tools", exe));
  for (const c of candidates) { if (existsSync(c)) return c; }
  // last resort: PATH scan (no spawn)
  const pth = process.env.PATH || process.env.Path || "";
  for (const dir of pth.split(IS_WIN ? ";" : ":")) {
    if (!dir) continue;
    const p = join(dir, exe);
    try { if (existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/** Does any build.gradle{,.kts} in the project reference the given plugin/lib substring? */
function gradleMentions(root, ignore, needles) {
  const gradleFiles = walkFiles(root,
    (_abs, name) => /^build\.gradle(\.kts)?$/i.test(name) ||
                    /^settings\.gradle(\.kts)?$/i.test(name) ||
                    /^libs\.versions\.toml$/i.test(name) ||
                    /\.gradle(\.kts)?$/i.test(name),
    { ignore, maxHits: 200, maxDepth: 6 });
  for (const f of gradleFiles) {
    const t = readSafe(f);
    for (const nd of needles) { if (t.includes(nd)) return { hit: true, file: f }; }
  }
  return { hit: false, file: null };
}

function readJsonSafe(abs) {
  try { return JSON.parse(readFileSync(abs, "utf8")); } catch { return null; }
}

/** Collect package.json dep+devDep keys + scripts for web probing. */
function readPackageJson(root) {
  const p = join(root, "package.json");
  const pkg = readJsonSafe(p);
  if (!pkg) return { found: false, deps: {}, scripts: {} };
  const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  return { found: true, deps, scripts: pkg.scripts || {} };
}

/**
 * Probe-only capability detection. Never spawns a build, never installs, never mutates.
 * @returns {Promise<{available:boolean,engine:string,reason?:string,detail:object}>}
 */
export async function detectRenderCapability(dir, stack, cfg) {
  try {
    const root = resolve(dir);
    const R = getRenderCfg(cfg);
    const n = normStack(stack);
    const ignore = ignoreSet(cfg);
    const detail = { stack, normStack: n };

    // 2.0 master gates
    if (!R.enabled) return { available: false, engine: "none", reason: "render-disabled", detail };
    if (!isSupportedStack(stack)) return { available: false, engine: "none", reason: "unsupported-stack", detail };

    if (n === "android-compose") {
      const forced = String(R.android.engine || "auto").toLowerCase();
      if (forced === "off") return { available: false, engine: "none", reason: "render-disabled", detail };

      // probe each engine (no spawn)
      const hasGradlew = existsSync(join(root, "gradlew")) || existsSync(join(root, "gradlew.bat"));
      const robo = gradleMentions(root, ignore, ["io.github.takahirom.roborazzi", "roborazzi"]);
      const papa = gradleMentions(root, ignore, ["app.cash.paparazzi", "paparazzi"]);
      const adbPath = resolveAdb(cfg);
      detail.gradlew = hasGradlew;
      detail.roborazzi = robo.hit;
      detail.paparazzi = papa.hit;
      detail.adbPath = adbPath;

      const tryEngine = (name) => {
        if (name === "roborazzi") return robo.hit && hasGradlew;
        if (name === "paparazzi") return papa.hit && hasGradlew;
        if (name === "adb") return !!adbPath; // device liveness is checked at capture time
        return false;
      };

      if (forced !== "auto") {
        if (tryEngine(forced)) return { available: true, engine: forced, detail };
        return { available: false, engine: "none", reason: "forced-engine-unavailable", detail };
      }
      // auto: preference order roborazzi > paparazzi. adb is the live-device fallback and
      // is NOT selected in auto mode — a bare adb binary is not proof of a usable engine
      // (it needs a running device + installed app, which we cannot confirm without a spawn,
      // and probing must stay side-effect-free). adb is reachable only via explicit
      // cfg.render.android.engine:"adb".
      for (const eng of ["roborazzi", "paparazzi"]) {
        if (tryEngine(eng)) return { available: true, engine: eng, detail };
      }
      return { available: false, engine: "none", reason: "no-screenshot-infra", detail };
    }

    if (n === "web") {
      const forced = String(R.web.engine || "auto").toLowerCase();
      if (forced === "off") return { available: false, engine: "none", reason: "render-disabled", detail };
      const pkg = readPackageJson(root);
      const hasPlaywright = !!(pkg.deps["@playwright/test"] || pkg.deps["playwright"]) ||
        existsSync(join(root, "playwright.config.ts")) ||
        existsSync(join(root, "playwright.config.js")) ||
        existsSync(join(root, "playwright.config.mjs"));
      const hasStorybook = Object.keys(pkg.deps).some((k) => k.startsWith("@storybook/")) ||
        existsSync(join(root, String(R.web.storybookStaticDir || "storybook-static"))) ||
        !!(pkg.scripts && (pkg.scripts.storybook || pkg.scripts["build-storybook"]));
      detail.packageJson = pkg.found;
      detail.playwright = hasPlaywright;
      detail.storybook = hasStorybook;

      const tryEngine = (name) => {
        if (name === "playwright") return hasPlaywright;
        if (name === "storybook") return hasStorybook;
        return false;
      };
      if (forced !== "auto") {
        if (tryEngine(forced)) return { available: true, engine: forced, detail };
        return { available: false, engine: "none", reason: "forced-engine-unavailable", detail };
      }
      for (const eng of ["playwright", "storybook"]) {
        if (tryEngine(eng)) return { available: true, engine: eng, detail };
      }
      return { available: false, engine: "none", reason: "no-screenshot-infra", detail };
    }

    return { available: false, engine: "none", reason: "unsupported-stack", detail };
  } catch (e) {
    return { available: false, engine: "none", reason: "no-screenshot-infra", detail: { error: String(e && e.message || e) } };
  }
}

// ---------------------------------------------------------------------------
// matrix planning  (prioritized sampling; never exceeds maxShots)
// ---------------------------------------------------------------------------

/**
 * Build a prioritized, capped list of matrix cells {state,theme,fontScale,width,variant,label}.
 * Per spec §4.3 sampling, not the full cross-product:
 *   - canonical: success + error + empty at <theme0>.fs<base>.w<minWidth>
 *   - a11y fs (1.3) only for changed/primary states
 *   - widest width only for success
 */
function planMatrix(R, themes, changedStates) {
  const states = R.states;
  const theme0 = themes[0] || "dark";
  const baseFs = R.fontScales[0] != null ? R.fontScales[0] : 1.0;
  const a11yFs = R.fontScales.find((f) => f !== baseFs);
  const minW = Math.min(...R.widths);
  const maxW = Math.max(...R.widths);
  const cells = [];
  const seen = new Set();
  const changed = new Set(changedStates || []);

  const add = (state, theme, fontScale, width) => {
    if (!states.includes(state)) return;
    const variant = `${theme}.${fsSlug(fontScale)}.w${width}`;
    const key = `${state}|${variant}`;
    if (seen.has(key)) return;
    seen.add(key);
    cells.push({
      state, theme, fontScale, width, variant,
      label: `${state} state, ${theme}, font ${fontScale}, ${width}dp`,
    });
  };

  // canonical cells (priority states first)
  const canonical = ["success", "error", "empty", "loading"].filter((s) => states.includes(s));
  for (const s of canonical) add(s, theme0, baseFs, minW);

  // a11y font scale, only for changed states (or all canonical if none flagged)
  if (a11yFs != null) {
    const targets = changed.size ? [...changed].filter((s) => states.includes(s)) : canonical.slice(0, 2);
    for (const s of targets) add(s, theme0, a11yFs, minW);
  }

  // widest width only for success
  if (maxW !== minW && states.includes("success")) add("success", theme0, baseFs, maxW);

  // additional themes (e.g. light) for success only, base fs/width
  for (let i = 1; i < themes.length; i++) add("success", themes[i], baseFs, minW);

  return cells;
}

// ---------------------------------------------------------------------------
// engine capture helpers  (consume existing infra only; lazy import of runCli)
// ---------------------------------------------------------------------------

/** Lazy, optional import of runCli from lib/agents.mjs. Returns fn or null. */
async function getRunCli() {
  try {
    const mod = await import("./agents.mjs");
    if (mod && typeof mod.runCli === "function") return mod.runCli;
  } catch { /* agents.mjs may not be present at probe time */ }
  return null;
}

/** Collect output PNGs produced by an engine, matching outputGlobs basenames, newest first, bounded. */
function collectOutputPngs(root, outputGlobs, ignore, limit) {
  // outputGlobs are like "**/build/.../**/*.png"; we only key off the .png extension
  // plus a substring of a meaningful path segment, to stay glob-package-free.
  const segHints = [];
  for (const g of outputGlobs || []) {
    const m = String(g).replace(/\*+/g, "/").split("/").filter((p) => p && p !== "." && !p.includes("*") && p !== "**");
    for (const p of m) { if (p && !p.endsWith(".png") && p.length > 2) segHints.push(p.toLowerCase()); }
  }
  const found = walkFiles(root,
    (abs, name) => {
      if (!/\.png$/i.test(name)) return false;
      if (!segHints.length) return true;
      const lower = abs.toLowerCase();
      return segHints.some((h) => lower.includes(h));
    },
    { ignore, maxHits: 500, maxDepth: 12 });
  found.sort((a, b) => fileMtime(b) - fileMtime(a));
  return limit ? found.slice(0, limit) : found;
}

function fileMtime(abs) { try { return statSync(abs).mtimeMs; } catch { return 0; } }

// ---------------------------------------------------------------------------
// render  (NEVER throws)
// ---------------------------------------------------------------------------

/**
 * Capture the screenshot state-matrix for the changed UI.
 * @returns {Promise<RenderResult>}
 *   RenderResult = { ok, reason?, engine, shots:ShotRef[], skipped:[], capability, warnings }
 */
export async function render(dir, stack, changedFiles, opts = {}) {
  const log = asLog(opts);
  const warnings = [];
  const skipped = [];
  let capability = { available: false, engine: "none", reason: "render-disabled", detail: {} };

  const fail = (reason, extra = {}) =>
    ({ ok: false, reason, engine: capability.engine || "none", shots: [], skipped, capability, warnings, ...extra });

  try {
    const root = resolve(dir);
    const cfg = opts.cfg || {};
    const R = getRenderCfg(cfg);
    const runDir = opts.runDir ? resolve(opts.runDir) : root;

    if (!R.enabled) return fail("render-disabled");
    if (!isSupportedStack(stack)) return fail("unsupported-stack");

    // 1) capability probe (no spawn, no mutation)
    capability = await detectRenderCapability(root, stack, cfg);
    if (!capability.available) {
      const reason = capability.reason || "no-screenshot-infra";
      if (reason === "no-screenshot-infra") {
        warnings.push(normStack(stack) === "android-compose"
          ? "enable Roborazzi (recordRoborazziDebug) to get visual review"
          : "enable Playwright/Storybook screenshots to get visual review");
      }
      return fail(reason);
    }

    // 2) theme + matrix planning
    let themes = R.themes;
    if (!themes || !themes.length) themes = detectThemes(root, stack);
    const changedStates = inferStatesFromChanged(root, stack, changedFiles, R);
    const cells = planMatrix(R, themes, changedStates);

    // record cells dropped purely by sampling vs the full cross product
    const full = R.states.length * themes.length * R.fontScales.length * R.widths.length;
    if (cells.length < full) {
      skipped.push(`${full - cells.length} matrix cells not rendered (sampling under maxShots=${R.maxShots})`);
    }
    if (cells.length > R.maxShots) {
      for (let i = R.maxShots; i < cells.length; i++) skipped.push(`${cells[i].state}x${cells[i].variant} dropped: maxShots cap`);
      cells.length = R.maxShots;
    }

    // 3) run the engine (consumes existing infra ONLY; lazy runCli)
    const runCli = await getRunCli();
    if (!runCli) {
      warnings.push("runCli (lib/agents.mjs) unavailable; cannot drive capture subprocess");
      return fail("engine-failed");
    }

    const cap = await captureWithEngine(root, stack, capability, R, runDir, log, runCli);
    if (!cap.ok) {
      for (const s of cap.skipped || []) skipped.push(s);
      for (const w of cap.warnings || []) warnings.push(w);
      return fail(cap.reason || "engine-failed");
    }

    // 4) map produced PNGs onto matrix cells, enforce byte budget + maxShots
    const produced = cap.pngs; // absolute paths, newest first
    if (!produced.length) return fail("no-output-pngs");

    const shots = [];
    let budget = 0;
    for (let i = 0; i < produced.length && shots.length < R.maxShots; i++) {
      const png = produced[i];
      const sz = fileBytes(png);
      if (budget + sz > R.shotBudgetBytes) {
        skipped.push(`${basename(png)} dropped: shotBudgetBytes exceeded`);
        continue;
      }
      const cell = cells[shots.length] || cells[cells.length - 1] || {
        state: "asis", variant: `${themes[0] || "dark"}.${fsSlug(R.fontScales[0])}.w${Math.min(...R.widths)}`,
        label: "as-is screen",
      };
      budget += sz;
      shots.push({
        path: png, // already absolute (from walkFiles join on absolute root)
        state: classifyShotState(png, cell.state),
        variant: cell.variant,
        label: cell.label,
        bytes: sz,
        source: capability.engine,
      });
    }

    if (!shots.length) return fail("budget-exceeded");

    log(`render: ${shots.length} shot(s) via ${capability.engine}; ${skipped.length} skipped cell(s)`);
    return { ok: true, engine: capability.engine, shots, skipped, capability, warnings };
  } catch (e) {
    warnings.push("render exception: " + String(e && e.message || e));
    return fail("engine-failed");
  }
}

/** Heuristic: derive which states the changed files imply (by name). */
function inferStatesFromChanged(root, stack, changedFiles, R) {
  const states = new Set();
  const want = R.states;
  const map = [
    ["loading", /loading|shimmer|skeleton|progress/i],
    ["empty",   /empty|blank|nodata|no_data|placeholder/i],
    ["error",   /error|failure|fail|retry/i],
    ["success", /success|content|loaded|ready|list|detail|home|main|screen/i],
  ];
  for (const f of changedFiles || []) {
    const name = basename(String(f || ""));
    for (const [state, rx] of map) {
      if (want.includes(state) && rx.test(name)) states.add(state);
    }
  }
  return [...states];
}

/** Classify a produced PNG's state from its filename, fallback to planned cell state. */
function classifyShotState(png, fallback) {
  const n = basename(png).toLowerCase();
  if (/loading|shimmer|skeleton/.test(n)) return "loading";
  if (/empty|blank|nodata/.test(n)) return "empty";
  if (/error|failure|retry/.test(n)) return "error";
  if (/success|content|loaded|ready/.test(n)) return "success";
  return fallback || "asis";
}

/**
 * Drive the resolved engine to (re)generate screenshots, then collect output PNGs.
 * Consumes existing infra only; NEVER installs anything. Returns:
 *   { ok, pngs:string[], reason?, skipped:[], warnings:[] }
 */
async function captureWithEngine(root, stack, capability, R, runDir, log, runCli) {
  const ign = ignoreSet({}); // default ignore dirs (render does not depend on cfg.designSystem here)
  const engine = capability.engine;
  const skipped = [];
  const warnings = [];

  try {
    if (normStack(stack) === "android-compose") {
      const gradlew = IS_WIN ? (existsSync(join(root, "gradlew.bat")) ? join(root, "gradlew.bat") : join(root, "gradlew"))
                             : join(root, "gradlew");
      if (!existsSync(gradlew)) {
        // no wrapper -> we will not invoke a global gradle (would be ambient mutation risk); just collect any existing PNGs
        const existing = collectOutputPngs(root, R.android.outputGlobs, ign, R.maxShots);
        if (existing.length) return { ok: true, pngs: existing, skipped, warnings: ["no gradlew; using pre-existing snapshots"] };
        return { ok: false, reason: "engine-failed", skipped, warnings: ["no gradlew wrapper to drive Roborazzi/Paparazzi"] };
      }
      const task = engine === "paparazzi"
        ? (R.android.paparazziTask || "recordPaparazziDebug")
        : (R.android.roborazziTask || "recordRoborazziDebug");

      if (engine === "adb") {
        // adb path captures the live app; we do NOT auto-launch/auto-install. If no device, skip.
        warnings.push("adb engine selected; requires a running device with the app installed");
        const existing = collectOutputPngs(root, R.android.outputGlobs, ign, R.maxShots);
        if (existing.length) return { ok: true, pngs: existing, skipped, warnings };
        return { ok: false, reason: "no-output-pngs", skipped, warnings };
      }

      log(`render: ./gradlew ${task} (${engine})`);
      const r = await runCli(gradlew, [task, "--quiet"], { cwd: root, timeoutMs: R.timeoutMs });
      if (r && r.timedOut) return { ok: false, reason: "timeout", skipped, warnings: ["gradle task timed out"] };
      const pngs = collectOutputPngs(root, R.android.outputGlobs, ign, R.maxShots);
      if (r && r.code !== 0 && !pngs.length) {
        return { ok: false, reason: "engine-failed", skipped, warnings: [`gradle exit=${r.code}`] };
      }
      if (!pngs.length) return { ok: false, reason: "no-output-pngs", skipped, warnings };
      return { ok: true, pngs, skipped, warnings };
    }

    // web
    const webEngine = engine;
    if (webEngine === "playwright") {
      const script = String(R.web.playwrightScript || "npm run screenshot");
      // run via shell: POSIX /bin/sh -c, Windows cmd.exe /d /s /c  (BUG-3 correct split)
      const shBin = IS_WIN ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
      const shArgs = IS_WIN ? ["/d", "/s", "/c", script] : ["-c", script];
      log(`render: ${script} (playwright)`);
      const r = await runCli(shBin, shArgs, { cwd: root, timeoutMs: R.timeoutMs });
      if (r && r.timedOut) return { ok: false, reason: "timeout", skipped, warnings: ["playwright timed out"] };
      const pngs = collectOutputPngs(root, R.web.outputGlobs, ign, R.maxShots);
      if (r && r.code !== 0 && !pngs.length) return { ok: false, reason: "engine-failed", skipped, warnings: [`script exit=${r.code}`] };
      if (!pngs.length) return { ok: false, reason: "no-output-pngs", skipped, warnings };
      return { ok: true, pngs, skipped, warnings };
    }

    if (webEngine === "storybook") {
      // Only consume pre-built story snapshots; do NOT build storybook (would be heavy mutation).
      const pngs = collectOutputPngs(root, R.web.outputGlobs, ign, R.maxShots);
      if (!pngs.length) return { ok: false, reason: "no-output-pngs", skipped, warnings: ["no pre-built storybook snapshots found"] };
      return { ok: true, pngs, skipped, warnings };
    }

    return { ok: false, reason: "engine-failed", skipped, warnings: [`unknown engine ${engine}`] };
  } catch (e) {
    return { ok: false, reason: "engine-failed", skipped, warnings: ["capture exception: " + String(e && e.message || e)] };
  }
}

// ---------------------------------------------------------------------------
// ingestReferences  (D2; NEVER throws)
// ---------------------------------------------------------------------------

/**
 * Make reference images available to Opus: copy local refs into runDir/refs/,
 * fetch http(s) refs (bounded), sniff magic bytes. Returns canonical ShotRef list.
 * @returns {Promise<{ ok:boolean, refs:ShotRef[], reason?:string, skipped:string[] }>}
 */
export async function ingestReferences(refSpecs, opts = {}) {
  const log = asLog(opts);
  const skipped = [];
  const refs = [];
  try {
    const cfg = opts.cfg || {};
    const R = getRenderCfg(cfg);
    const maxRefs = Number.isFinite(R.reference.maxRefs) ? R.reference.maxRefs : 4;
    const specs = (Array.isArray(refSpecs) ? refSpecs : (refSpecs ? [refSpecs] : [])).filter(Boolean);
    if (!specs.length) return { ok: false, refs: [], reason: "no-refs", skipped };

    const runDir = opts.runDir ? resolve(opts.runDir) : process.cwd();
    const refsDir = join(runDir, "refs");
    try { mkdirSync(refsDir, { recursive: true }); } catch { /* best-effort */ }

    let idx = 0;
    for (const spec of specs) {
      if (refs.length >= maxRefs) { skipped.push(`${spec}: over maxRefs=${maxRefs}`); continue; }
      idx++;
      const nn = String(idx).padStart(2, "0");

      if (isHttpUrl(spec)) {
        const fetched = await fetchRef(spec, refsDir, nn, log);
        if (fetched.ok) {
          refs.push(mkRef(fetched.path, idx));
        } else {
          skipped.push(`${spec}: ${fetched.reason}`);
        }
        continue;
      }

      // local path
      let abs;
      try { abs = resolve(spec); } catch { skipped.push(`${spec}: bad-path`); continue; }
      // If a directory was passed (referenceDir), enumerate image files within (shallow).
      let candidates = [abs];
      try {
        if (existsSync(abs) && statSync(abs).isDirectory()) {
          candidates = readdirSync(abs)
            .filter((n) => /\.(png|jpe?g)$/i.test(n))
            .map((n) => join(abs, n));
        }
      } catch { /* treat as single file */ }

      for (const c of candidates) {
        if (refs.length >= maxRefs) { skipped.push(`${c}: over maxRefs=${maxRefs}`); break; }
        if (!existsSync(c)) { skipped.push(`${c}: not-found`); continue; }
        const kind = imageKind(c);
        if (!kind) { skipped.push(`${c}: not-an-image`); continue; }
        const ext = kind === "png" ? "png" : "jpg";
        const dest = join(refsDir, `ref.${String(refs.length + 1).padStart(2, "0")}.${ext}`);
        try {
          copyFileSync(c, dest);
          refs.push(mkRef(dest, refs.length + 1));
        } catch (e) {
          skipped.push(`${c}: copy-failed (${String(e && e.message || e)})`);
        }
      }
    }

    if (refs.length) log(`ingestReferences: ${refs.length} reference image(s) ready in ${refsDir}`);
    return { ok: refs.length > 0, refs, skipped, ...(refs.length ? {} : { reason: "no-valid-refs" }) };
  } catch (e) {
    return { ok: false, refs: [], reason: "ingest-exception", skipped: skipped.concat("exception: " + String(e && e.message || e)) };
  }
}

function mkRef(absPath, n) {
  return {
    path: absPath,
    state: "reference",
    variant: "reference",
    label: `designer reference ${n}`,
    bytes: fileBytes(absPath),
    source: "reference",
  };
}

/** Fetch an http(s) image with size + content-type guards. Graceful when fetch absent. */
async function fetchRef(url, refsDir, nn, log) {
  if (typeof fetch !== "function") return { ok: false, reason: "ref-fetch-unavailable" };
  const MAX = 5 * 1024 * 1024; // 5 MB cap
  try {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const tmr = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, 30000) : null;
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    if (tmr) clearTimeout(tmr);
    if (!res || !res.ok) return { ok: false, reason: `http-${res ? res.status : "err"}` };
    const ct = String(res.headers && res.headers.get ? (res.headers.get("content-type") || "") : "").toLowerCase();
    const isPng = ct.includes("image/png");
    const isJpg = ct.includes("image/jpeg") || ct.includes("image/jpg");
    if (!isPng && !isJpg) return { ok: false, reason: `bad-content-type:${ct || "unknown"}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX) return { ok: false, reason: "too-large" };
    const ext = isPng ? "png" : "jpg";
    const dest = join(refsDir, `ref.${nn}.${ext}`);
    writeFileSync(dest, buf);
    // verify magic bytes post-write
    if (!imageKind(dest)) return { ok: false, reason: "not-an-image" };
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, reason: "fetch-failed:" + String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// compareToReference  (D2 review-time; NEVER throws)
// ---------------------------------------------------------------------------

/**
 * Build the shot<->ref pairing for the review prompt, plus an OPTIONAL cheap pixel
 * pre-metric when an image lib (pngjs/sharp/jimp) is resolvable. The authoritative
 * judgment is Opus reading the images; prePixel is advisory only.
 * @returns {Promise<{ ok:boolean, pairs:ComparePair[], prePixel?:object, reason?:string }>}
 */
export async function compareToReference(shots, refs, opts = {}) {
  const log = asLog(opts);
  try {
    const S = Array.isArray(shots) ? shots.filter((s) => s && s.path) : [];
    const Rf = Array.isArray(refs) ? refs.filter((r) => r && r.path) : [];
    if (!S.length || !Rf.length) return { ok: false, pairs: [], reason: "no-pairs" };

    // pair each ref to the best shot (same/closest state; else index default)
    const pairs = [];
    const usedShot = new Set();
    for (const ref of Rf) {
      let best = null;
      // prefer a shot whose state matches the ref label/hint, else first unused, else first
      for (const sh of S) {
        if (usedShot.has(sh.path)) continue;
        if (!best) best = sh;
      }
      if (!best) best = S[0];
      usedShot.add(best.path);
      pairs.push({ shot: best, ref, note: "compare this build shot against the designer reference" });
    }

    // optional advisory pixel pre-metric
    let prePixel;
    const lib = await tryImageLib();
    if (lib) {
      const metrics = [];
      for (const p of pairs) {
        try {
          const d = await coarseDiffPct(lib, p.shot.path, p.ref.path);
          if (d != null) metrics.push({ shot: basename(p.shot.path), ref: basename(p.ref.path), diff_pct: d });
        } catch { /* per-pair skip */ }
      }
      if (metrics.length) prePixel = { advisory: true, method: lib.name, pairs: metrics };
    } else {
      log("compare: pixel-pre-skip (no-image-lib) — Opus will judge visually");
    }

    return { ok: true, pairs, ...(prePixel ? { prePixel } : {}) };
  } catch (e) {
    return { ok: false, pairs: [], reason: "compare-exception:" + String(e && e.message || e) };
  }
}

/** Probe for an optional image lib (all absent in the default zero-dep install). */
async function tryImageLib() {
  for (const name of ["pngjs", "jimp", "sharp"]) {
    try {
      const mod = await import(name);
      if (mod) return { name, mod };
    } catch { /* not installed — expected */ }
  }
  return null;
}

/** Coarse resized-grayscale diff percent using pngjs if available; else null. Advisory only. */
async function coarseDiffPct(lib, aPath, bPath) {
  try {
    if (lib.name !== "pngjs") return null; // only implement the zero-risk pngjs path
    const { PNG } = lib.mod;
    const a = PNG.sync.read(readFileSync(aPath));
    const b = PNG.sync.read(readFileSync(bPath));
    const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
    if (!w || !h) return null;
    let diff = 0, total = 0;
    const step = Math.max(1, Math.floor(Math.min(w, h) / 64)); // sample grid ~64x64
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const ia = (a.width * y + x) << 2;
        const ib = (b.width * y + x) << 2;
        const ga = (a.data[ia] + a.data[ia + 1] + a.data[ia + 2]) / 3;
        const gb = (b.data[ib] + b.data[ib + 1] + b.data[ib + 2]) / 3;
        diff += Math.abs(ga - gb);
        total += 255;
      }
    }
    return total ? Math.round((diff / total) * 1000) / 10 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// buildImageBundle  (PURE sync — single source of truth for prompt wiring)
// ---------------------------------------------------------------------------

/**
 * Given a RenderResult + ref result, build exactly what prompts.mjs/agents.mjs consume:
 *   { reviewImagePaths, addDirs, imageManifestMd, skippedNote }
 * PURE: no I/O, no async, no throw. role is 'plan' (refs-only) or 'review' (shots+refs).
 */
export function buildImageBundle(renderResult, refResult, role, cfg) {
  const empty = { reviewImagePaths: [], addDirs: [], imageManifestMd: "", skippedNote: "" };
  try {
    const R = getRenderCfg(cfg || {});
    const rr = renderResult || {};
    const rf = refResult || {};
    const shots = (role === "review" && rr.ok && Array.isArray(rr.shots)) ? rr.shots.filter((s) => s && s.path) : [];
    const refs = (rf.ok && Array.isArray(rf.refs)) ? rf.refs.filter((r) => r && r.path) : [];

    // addDirs: derive runDir from any absolute image path so Read is permitted.
    const addDirs = [];
    const sampleAbs = (shots[0] && shots[0].path) || (refs[0] && refs[0].path) || "";
    if (sampleAbs) {
      // runDir is the parent of shot.*.png; refs live in runDir/refs.
      const dir = parentDir(sampleAbs);
      // if the sample is a ref (under .../refs), step up one.
      const runDir = /(^|[\\/])refs$/.test(dir) ? parentDir(dir) : dir;
      pushUnique(addDirs, runDir);
      pushUnique(addDirs, join(runDir, "refs"));
    }

    // select highest-signal shots up to maxShotsToOpus
    const cap = Number.isFinite(R.maxShotsToOpus) ? R.maxShotsToOpus : 6;
    const ranked = rankShots(shots);
    const chosen = ranked.slice(0, cap);
    const droppedShots = ranked.length - chosen.length;

    const reviewImagePaths = [];
    const lines = [];
    lines.push("## VISUAL EVIDENCE — READ THESE IMAGES FIRST");
    lines.push("You have a Read tool that renders PNG images. Use it on EACH path below, then judge the");
    lines.push("UI visually (layout, spacing, color/contrast vs the dark design system, state correctness)");
    lines.push("in addition to the code diff. Do not skip any image.");
    lines.push("");

    if (chosen.length) {
      lines.push("SCREENSHOTS (current build, state x variant):");
      chosen.forEach((s, i) => {
        reviewImagePaths.push(s.path);
        lines.push(`${i + 1}. Read: ${s.path}   — ${s.label || (s.state + " " + s.variant)}`);
      });
      lines.push("");
    }

    if (refs.length) {
      lines.push(role === "plan"
        ? "REFERENCE TARGETS (extract the visual intent into the spec; the executor cannot see images):"
        : "REFERENCE TARGETS (D2 — what the result SHOULD look like; compare against the screenshots):");
      refs.forEach((r, i) => {
        reviewImagePaths.push(r.path);
        lines.push(`R${i + 1}. Read: ${r.path}   — ${r.label || ("designer reference " + (i + 1))}`);
      });
      lines.push("");
    }

    // skip ledger
    const skippedBits = [];
    if (Array.isArray(rr.skipped) && rr.skipped.length) skippedBits.push(...rr.skipped);
    if (droppedShots > 0) skippedBits.push(`${droppedShots} extra shot(s) not sent to Opus (maxShotsToOpus=${cap})`);
    if (Array.isArray(rf.skipped) && rf.skipped.length) skippedBits.push(...rf.skipped.map((s) => "ref " + s));
    const skippedNote = skippedBits.length
      ? `Note: visual coverage is partial — ${skippedBits.length} item(s) skipped to control token cost: ${skippedBits.join("; ")}.`
      : "";

    if (!chosen.length && !refs.length) {
      // nothing to show
      return { reviewImagePaths: [], addDirs, imageManifestMd: "", skippedNote };
    }

    if (skippedNote) { lines.push(skippedNote); lines.push(""); }
    lines.push('After reading, in your JSON verdict populate "visual_check"' +
      (refs.length ? ' and "referenceMatch"' : "") + ".");

    return { reviewImagePaths, addDirs, imageManifestMd: lines.join("\n") + "\n", skippedNote };
  } catch {
    return empty;
  }
}

/** Rank shots by signal: changed/error/empty first, then one a11y (fs1_3), then rest. */
function rankShots(shots) {
  const score = (s) => {
    let v = 0;
    const st = String(s.state || "");
    const vr = String(s.variant || "");
    if (st === "error") v += 100;
    if (st === "empty") v += 90;
    if (st === "success") v += 60;
    if (st === "loading") v += 40;
    if (/fs1_3/.test(vr)) v += 15; // a11y large-font signal
    return v;
  };
  return [...shots].sort((a, b) => score(b) - score(a));
}

function parentDir(absPath) {
  const p = String(absPath);
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx > 0 ? p.slice(0, idx) : p;
}

function pushUnique(arr, v) {
  if (!v) return;
  const low = v.toLowerCase();
  if (!arr.some((x) => x.toLowerCase() === low)) arr.push(v);
}
