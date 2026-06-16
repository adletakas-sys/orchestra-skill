// lib/detect.mjs — stack detection, design-file resolution, verify-command probing.
//
// Pure filesystem reads only (no network, no CLI). Every function degrades
// gracefully and NEVER throws: detectStack falls back to "generic",
// resolveDesignFiles falls back to [], detectVerifyCmd falls back to "".
//
// Zero npm deps: a small internal shallow globber (globShallow) supports
// **, *, and {a,b} alternation over fs.readdirSync.
//
// Synthesis §2 contract:
//   export const STACKS
//   export function detectStack(dir) -> { stack, confidence, markers:[{file,rule,weight}], candidates:[{stack,confidence}] }
//   export function resolveDesignFiles(dir, stack, cfg) -> string[]   (absolute, existing, deduped, priority-ordered)
//   export function detectVerifyCmd(dir, stack) -> string             ("" if none)

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep, basename, isAbsolute } from "node:path";

const IS_WIN = process.platform === "win32";

// Ordered id list — first decisive match wins (mobile/native before web before backend).
export const STACKS = [
  "android-compose", "ios-swiftui", "flutter",
  "web-react", "web-vue", "web-svelte", "web-angular", "web-vanilla",
  "react-native", "node-backend", "python", "rust", "go", "generic",
];

const DEFAULT_IGNORE = [
  "node_modules", ".git", "build", ".gradle", "dist", "out", ".next", ".idea",
  ".dart_tool", "Pods", "DerivedData", "target", "vendor", ".venv", "__pycache__", "runs",
];

// Built-in per-stack design-file globs (mirrors config.designSystem.stacks.*.globs).
// Used as a fallback when cfg.designSystem is absent/partial.
const BUILTIN_GLOBS = {
  "android-compose": [
    "**/ui/theme/Color*.kt", "**/ui/theme/Colors.kt", "**/theme/Color*.kt",
    "**/ui/theme/Type*.kt", "**/ui/theme/Typography.kt",
    "**/ui/theme/Spacing*.kt", "**/ui/theme/Dimens*.kt",
    "**/ui/theme/Shape*.kt", "**/ui/theme/Shapes.kt",
    "**/ui/theme/Elevation*.kt", "**/ui/theme/Motion*.kt", "**/ui/theme/Theme.kt",
    "**/res/values/colors.xml", "**/res/values/dimens.xml",
    "**/res/values/themes.xml", "**/res/values/styles.xml",
  ],
  "ios-swiftui": [
    "**/*.xcassets/**/Contents.json", "**/Theme.swift", "**/Color*.swift",
    "**/Colors.swift", "**/DesignSystem*.swift", "**/Typography.swift",
    "**/Font*.swift", "**/Spacing*.swift", "**/Tokens.swift", "**/design-tokens.json",
  ],
  "flutter": [
    "**/theme.dart", "**/theme/*.dart", "**/app_theme.dart", "**/colors.dart",
    "**/app_colors.dart", "**/typography.dart", "**/text_styles.dart",
    "**/spacing.dart", "**/dimens.dart", "**/tokens.dart", "**/design-tokens.json",
  ],
  "web-react": [
    "tailwind.config.{js,cjs,mjs,ts}", "**/theme.{ts,js,tsx,jsx}", "**/theme/index.{ts,js}",
    "**/tokens.{ts,js,json}", "**/design-tokens.json",
    "**/styles/{globals,tokens,variables,theme}.{css,scss}", "**/*.module.css",
  ],
  "web-vue": [
    "tailwind.config.{js,cjs,mjs,ts}", "**/assets/**/{tokens,variables,theme,main}.{css,scss}",
    "**/styles/*.{css,scss}", "**/theme.{ts,js}", "**/tokens.{ts,js,json}", "**/design-tokens.json",
  ],
  "web-svelte": [
    "tailwind.config.{js,cjs,mjs,ts}", "**/app.css", "**/styles/*.{css,scss}",
    "**/theme.{ts,js}", "**/tokens.{ts,js,json}", "**/design-tokens.json",
  ],
  "web-angular": [
    "**/styles.{css,scss}", "**/styles/**/*.{css,scss}", "**/_variables.scss",
    "**/theme.scss", "**/tokens.{ts,scss,json}", "**/design-tokens.json", "tailwind.config.*",
  ],
  "web-vanilla": [
    "**/{styles,style,main,index,tokens,variables,theme}.css", "**/css/*.css",
    "**/design-tokens.json", "**/index.html",
  ],
  "react-native": [
    "**/theme.{ts,js,tsx,jsx}", "**/theme/index.{ts,js}", "**/styles/theme.{ts,js}",
    "**/tokens.{ts,js,json}", "**/design-tokens.json", "**/colors.{ts,js}",
  ],
  "node-backend": ["**/design-tokens.json", "**/tokens.{json,js,ts}", "**/theme.{js,ts}"],
  "python": ["**/design-tokens.json", "**/static/**/*.css", "**/_variables.scss", "**/tokens.json"],
  "rust": ["**/design-tokens.json", "**/tokens.{json,toml}"],
  "go": ["**/design-tokens.json", "**/static/**/*.css"],
  "generic": [
    "**/design-tokens.json", "**/tokens.{json,js,ts}", "**/_variables.scss",
    "**/{theme,variables,tokens}.{css,scss}",
  ],
};

const UNIVERSAL_CARRIERS = [
  "**/design-tokens.json", "**/tokens.json", "**/*.tokens.json",
  "**/style-dictionary*.{json,js,cjs,mjs}",
];

// ----------------------------------------------------------------------------
// Shared helpers (also imported by tokens.mjs)
// ----------------------------------------------------------------------------

export function safeRead(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function hasFile(dir, rel) {
  try { return existsSync(join(dir, rel)); } catch { return false; }
}

function lc(s) { return IS_WIN ? s.toLowerCase() : s; }

// ----------------------------------------------------------------------------
// Shallow glob matcher — supports **, *, ?, and {a,b} alternation.
// Returns absolute paths of MATCHING FILES, pruning ignore dirs early.
// ----------------------------------------------------------------------------

// Expand {a,b}{c,d} alternation into a flat list of brace-free patterns.
function expandBraces(pattern) {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  // find matching close brace for this open (no nesting expected, but tolerate)
  let depth = 0, close = -1;
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return [pattern]; // unbalanced — treat literally
  const pre = pattern.slice(0, open);
  const post = pattern.slice(close + 1);
  const body = pattern.slice(open + 1, close);
  const opts = splitTopLevelCommas(body);
  const out = [];
  for (const opt of opts) {
    for (const rest of expandBraces(post)) out.push(pre + opt + rest);
  }
  return out;
}

function splitTopLevelCommas(s) {
  const parts = [];
  let depth = 0, cur = "";
  for (const c of s) {
    if (c === "{") { depth++; cur += c; }
    else if (c === "}") { depth--; cur += c; }
    else if (c === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += c;
  }
  parts.push(cur);
  return parts;
}

function escapeRe(s) { return s.replace(/[.+^${}()|[\]\\]/g, "\\$&"); }

// Compile one brace-free glob (segments separated by "/") to a RegExp over a
// forward-slash-normalized relative path. ** matches across separators.
function globToRegex(glob) {
  // Normalize separators to "/"
  const g = glob.replace(/\\/g, "/");
  let re = "";
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // ** — match any chars including "/"
        i += 2;
        if (g[i] === "/") i++; // consume the slash after ** so "**/" matches zero dirs too
        re += "(?:.*/)?"; // zero or more path segments
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "/") {
      re += "/";
      i++;
    } else {
      re += escapeRe(c);
      i++;
    }
  }
  const flags = IS_WIN ? "i" : "";
  return new RegExp("^" + re + "$", flags);
}

// globShallow(dir, patterns, {ignore, maxDepth, maxEntries}) -> absPath[]
export function globShallow(dir, patterns, opts = {}) {
  const out = [];
  try {
    if (!isDir(dir)) return out;
    const ignore = new Set((opts.ignore || DEFAULT_IGNORE).map(lc));
    const maxDepth = opts.maxDepth == null ? 12 : opts.maxDepth;
    const maxEntries = opts.maxEntries == null ? 20000 : opts.maxEntries;

    // Pre-compile regexes for all (brace-expanded) patterns.
    const regexes = [];
    for (const p of patterns) {
      for (const ex of expandBraces(String(p))) {
        try { regexes.push(globToRegex(ex)); } catch { /* skip bad pattern */ }
      }
    }
    if (!regexes.length) return out;

    let visited = 0;
    const seen = new Set();
    const stack = [{ abs: dir, depth: 0 }];
    while (stack.length) {
      const { abs, depth } = stack.pop();
      let entries;
      try { entries = readdirSync(abs, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (++visited > maxEntries) return out;
        const name = ent.name;
        const childAbs = join(abs, name);
        let dirent = ent.isDirectory();
        let filent = ent.isFile();
        // Resolve symlinks defensively
        if (ent.isSymbolicLink && ent.isSymbolicLink()) {
          dirent = isDir(childAbs); filent = isFile(childAbs);
        }
        if (dirent) {
          if (ignore.has(lc(name))) continue;
          if (depth < maxDepth) stack.push({ abs: childAbs, depth: depth + 1 });
          continue;
        }
        if (!filent) continue;
        const rel = relative(dir, childAbs).replace(/\\/g, "/");
        for (const rx of regexes) {
          if (rx.test(rel)) {
            const key = lc(childAbs);
            if (!seen.has(key)) { seen.add(key); out.push(childAbs); }
            break;
          }
        }
      }
    }
  } catch { /* never throw */ }
  return out;
}

// ----------------------------------------------------------------------------
// detectStack
// ----------------------------------------------------------------------------

function readPkgJson(dir) {
  const raw = safeRead(join(dir, "package.json"));
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function pkgDeps(pkg) {
  if (!pkg) return {};
  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
}

// Shallow-scan: do any files matching one of `globs` exist (cheap, capped)?
function anyMatch(dir, globs, ignore) {
  return globShallow(dir, globs, { ignore, maxDepth: 8, maxEntries: 6000 }).length > 0;
}

// Read first existing gradle build file content (root + app/).
function gradleContent(dir) {
  const candidates = [
    "build.gradle.kts", "build.gradle",
    "app/build.gradle.kts", "app/build.gradle",
    "settings.gradle.kts", "settings.gradle",
  ];
  let buf = "";
  for (const c of candidates) {
    const t = safeRead(join(dir, c));
    if (t) buf += "\n" + t;
  }
  return buf;
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

export function detectStack(dir) {
  try {
    const target = resolve(dir || ".");

    // Env override.
    const envStack = (process.env.ORCHESTRA_STACK || "").trim();
    if (envStack && STACKS.includes(envStack)) {
      return {
        stack: envStack, confidence: 1,
        markers: [{ file: "", rule: "env-override", weight: 1 }],
        candidates: [],
      };
    }

    if (!isDir(target)) {
      return { stack: "generic", confidence: 0, markers: [], candidates: [] };
    }

    const ignore = DEFAULT_IGNORE;
    const scores = {};      // stack -> summed weight
    const markersByStack = {}; // stack -> [{file,rule,weight}]
    const add = (stack, file, rule, weight) => {
      scores[stack] = (scores[stack] || 0) + weight;
      (markersByStack[stack] = markersByStack[stack] || []).push({ file, rule, weight });
    };

    const pkg = readPkgJson(target);
    const deps = pkgDeps(pkg);
    const dep = (n) => Object.prototype.hasOwnProperty.call(deps, n);

    // --- Tier 1: mobile / native ---
    const gradle = gradleContent(target);
    const hasGradleFile = !!gradle ||
      hasFile(target, "build.gradle.kts") || hasFile(target, "build.gradle") ||
      hasFile(target, "settings.gradle.kts") || hasFile(target, "settings.gradle");
    const composeMarker = /androidx\.compose|libs\.plugins\.android\.application|compose\s*=\s*true|org\.jetbrains\.compose/.test(gradle);
    const androidAppPlugin = /com\.android\.application|libs\.plugins\.android\.application/.test(gradle);
    if (hasGradleFile && composeMarker) {
      add("android-compose", "build.gradle*", "compose-dep", 0.6);
    } else if (hasGradleFile && (androidAppPlugin || hasFile(target, "app/src/main/AndroidManifest.xml") || anyMatch(target, ["**/AndroidManifest.xml"], ignore))) {
      add("android-compose", "AndroidManifest.xml", "android-views", 0.5);
    }
    if (hasFile(target, "gradlew") || hasFile(target, "gradlew.bat")) add("android-compose", "gradlew", "gradle-wrapper", 0.2);
    if (hasFile(target, "settings.gradle.kts") || hasFile(target, "settings.gradle")) add("android-compose", "settings.gradle", "gradle-settings", 0.1);
    if (anyMatch(target, ["**/ui/theme/*.kt"], ignore)) add("android-compose", "ui/theme/*.kt", "compose-theme", 0.1);

    // iOS
    if (anyMatch(target, ["**/*.xcodeproj/project.pbxproj", "**/*.xcworkspace/contents.xcworkspacedata"], ignore))
      add("ios-swiftui", "*.xcodeproj", "xcode-project", 0.5);
    const swiftPkg = safeRead(join(target, "Package.swift"));
    if (swiftPkg && /\.iOS|SwiftUI/.test(swiftPkg)) add("ios-swiftui", "Package.swift", "swift-package-ios", 0.4);
    if (anyMatch(target, ["**/*.xcassets/**/Contents.json"], ignore)) add("ios-swiftui", "*.xcassets", "asset-catalog", 0.15);
    if (anyMatch(target, ["**/*.swift"], ignore)) add("ios-swiftui", "*.swift", "swift-files", 0.1);

    // Flutter
    const pubspec = safeRead(join(target, "pubspec.yaml"));
    if (pubspec && /(^|\n)\s*flutter\s*:/.test(pubspec)) add("flutter", "pubspec.yaml", "flutter-key", 0.7);
    if (hasFile(target, "lib/main.dart")) add("flutter", "lib/main.dart", "dart-entry", 0.15);

    // Decide native tier early — if a native stack already cleared the bar, skip web/backend tiers.
    const nativeBest = bestOf(scores, ["android-compose", "ios-swiftui", "flutter"]);
    const nativeDecided = nativeBest && scores[nativeBest] >= 0.6;

    if (!nativeDecided) {
      // --- Tier 2: web frameworks (most specific dep first) ---
      if (dep("react-native")) {
        add("react-native", "package.json", "react-native-dep", 0.6);
      }
      if (dep("react")) {
        add("web-react", "package.json", "react-dep", 0.5);
        if (dep("next")) add("web-react", "package.json", "next-framework", 0.15);
        if (dep("@vitejs/plugin-react")) add("web-react", "package.json", "vite-react", 0.1);
      }
      if (anyMatch(target, ["**/*.tsx", "**/*.jsx"], ignore)) add("web-react", "*.tsx/*.jsx", "jsx-files", 0.1);
      if (dep("vue")) {
        add("web-vue", "package.json", "vue-dep", 0.5);
        if (dep("nuxt")) add("web-vue", "package.json", "nuxt-framework", 0.15);
      }
      if (anyMatch(target, ["**/*.vue"], ignore)) add("web-vue", "*.vue", "vue-files", 0.15);
      if (dep("svelte")) add("web-svelte", "package.json", "svelte-dep", 0.5);
      if (anyMatch(target, ["**/*.svelte"], ignore)) add("web-svelte", "*.svelte", "svelte-files", 0.15);
      if (dep("@angular/core")) add("web-angular", "package.json", "angular-dep", 0.55);
      if (hasFile(target, "angular.json")) add("web-angular", "angular.json", "angular-config", 0.2);

      // web-vanilla: index.html + css and no framework dep
      const hasFramework = dep("react") || dep("vue") || dep("svelte") || dep("@angular/core") || dep("react-native");
      const indexHtml = hasFile(target, "index.html") || hasFile(target, "src/index.html") || hasFile(target, "public/index.html");
      if (indexHtml && !hasFramework) {
        add("web-vanilla", "index.html", "html-entry", 0.4);
        if (anyMatch(target, ["**/*.css"], ignore)) add("web-vanilla", "*.css", "css-present", 0.2);
      }

      // --- Tier 3: backend / language ---
      const serverDeps = ["express", "fastify", "koa", "@nestjs/core", "hapi"];
      if (pkg && !hasFramework && (serverDeps.some(dep) || pkg.main || pkg.bin)) {
        add("node-backend", "package.json", "node-server", 0.4);
        if (hasFile(target, "tsconfig.json")) add("node-backend", "tsconfig.json", "ts-config", 0.1);
      }

      if (hasFile(target, "pyproject.toml")) add("python", "pyproject.toml", "py-project", 0.4);
      else if (hasFile(target, "requirements.txt")) add("python", "requirements.txt", "py-requirements", 0.35);
      else if (hasFile(target, "setup.py") || hasFile(target, "setup.cfg") || hasFile(target, "Pipfile"))
        add("python", "setup.py", "py-setup", 0.3);
      if (hasFile(target, "manage.py")) add("python", "manage.py", "django", 0.1);

      if (hasFile(target, "Cargo.toml")) add("rust", "Cargo.toml", "cargo", 0.7);
      if (hasFile(target, "src/main.rs") || hasFile(target, "src/lib.rs")) add("rust", "src/main.rs", "rust-entry", 0.2);

      if (hasFile(target, "go.mod")) add("go", "go.mod", "go-mod", 0.7);
      if (hasFile(target, "main.go")) add("go", "main.go", "go-entry", 0.2);
    }

    // --- Winner selection: max score, tie -> lower STACKS index ---
    let winner = "generic", winnerScore = 0;
    for (const s of STACKS) {
      const sc = scores[s] || 0;
      if (sc > winnerScore) { winner = s; winnerScore = sc; }
    }
    // If nothing reached a usable threshold, fall back to generic but keep best guess if >= 0.4.
    if (winnerScore < 0.4) {
      const candidates = STACKS
        .filter((s) => (scores[s] || 0) >= 0.2 && s !== "generic")
        .map((s) => ({ stack: s, confidence: clamp01(scores[s]) }))
        .sort((a, b) => b.confidence - a.confidence);
      return {
        stack: "generic",
        confidence: clamp01(winnerScore),
        markers: (markersByStack[winner] || []).slice().sort((a, b) => b.weight - a.weight),
        candidates,
      };
    }

    const candidates = STACKS
      .filter((s) => s !== winner && (scores[s] || 0) >= 0.2)
      .map((s) => ({ stack: s, confidence: clamp01(scores[s]) }))
      .sort((a, b) => b.confidence - a.confidence);

    return {
      stack: winner,
      confidence: clamp01(winnerScore),
      markers: (markersByStack[winner] || []).slice().sort((a, b) => b.weight - a.weight),
      candidates,
    };
  } catch {
    return { stack: "generic", confidence: 0, markers: [], candidates: [] };
  }
}

function bestOf(scores, subset) {
  let best = null, bestScore = -1;
  for (const s of subset) {
    const sc = scores[s] || 0;
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return bestScore > 0 ? best : null;
}

// ----------------------------------------------------------------------------
// resolveDesignFiles
// ----------------------------------------------------------------------------

export function resolveDesignFiles(dir, stack, cfg) {
  try {
    const target = resolve(dir || ".");
    if (!isDir(target)) return [];

    const ds = (cfg && cfg.designSystem) || {};
    const ignore = Array.isArray(ds.ignoreDirs) ? ds.ignoreDirs : DEFAULT_IGNORE;
    const maxFiles = Number.isFinite(ds.maxFiles) ? ds.maxFiles : 40;
    const componentGlobCap = Number.isFinite(ds.componentGlobCap) ? ds.componentGlobCap : 12;
    const universal = Array.isArray(ds.universalCarriers) ? ds.universalCarriers : UNIVERSAL_CARRIERS;

    // 1) ORCHESTRA_DESIGN_GLOBS override (use ONLY these if they match anything).
    const envGlobsRaw = (process.env.ORCHESTRA_DESIGN_GLOBS || "").trim();
    if (envGlobsRaw) {
      const envGlobs = envGlobsRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      const envMatches = dedupeExisting(globShallow(target, envGlobs, { ignore }));
      if (envMatches.length) return envMatches.slice(0, maxFiles);
      // matched nothing -> fall through (treat as unset)
    }

    // 2) cfg.designSystem.stacks[stack].globs, else 3) built-in defaults.
    const stackCfg = (ds.stacks && ds.stacks[stack]) || null;
    const baseGlobs = (stackCfg && Array.isArray(stackCfg.globs) && stackCfg.globs.length)
      ? stackCfg.globs
      : (BUILTIN_GLOBS[stack] || BUILTIN_GLOBS.generic);

    // Component-fan-out globs that should be capped + content-gated.
    const isComponentGlob = (g) => /\*\.(vue|svelte|module\.css)$/i.test(g) ||
      /\*\*\/\*\.vue$|\*\*\/\*\.svelte$|\*\.module\.css$/i.test(g);

    const ordered = []; // priority-ordered absolute paths
    const seen = new Set();
    const pushAbs = (abs) => {
      const key = lc(abs);
      if (!seen.has(key) && isFile(abs)) { seen.add(key); ordered.push(abs); }
    };

    // Expand each base glob in priority order; component globs are capped + gated.
    for (const g of baseGlobs) {
      const matches = globShallow(target, [g], { ignore });
      if (isComponentGlob(g)) {
        let admitted = 0;
        for (const abs of matches) {
          if (admitted >= componentGlobCap) break;
          const content = safeRead(abs);
          if (content && /(:root|--[\w-]|<style)/.test(content)) { pushAbs(abs); admitted++; }
        }
      } else {
        for (const abs of matches) pushAbs(abs);
      }
    }

    // Append universal carriers low-priority.
    for (const abs of globShallow(target, universal, { ignore })) pushAbs(abs);

    return ordered.slice(0, maxFiles);
  } catch {
    return [];
  }
}

function dedupeExisting(list) {
  const seen = new Set();
  const out = [];
  for (const abs of list) {
    if (!isFile(abs)) continue;
    const key = lc(abs);
    if (!seen.has(key)) { seen.add(key); out.push(abs); }
  }
  return out;
}

// ----------------------------------------------------------------------------
// detectVerifyCmd
// ----------------------------------------------------------------------------

export function detectVerifyCmd(dir, stack) {
  try {
    // Env override first.
    const env = (process.env.ORCHESTRA_VERIFY_CMD || "").trim();
    if (env) return env;

    const target = resolve(dir || ".");
    if (!isDir(target)) return "";

    switch (stack) {
      case "android-compose": {
        if (IS_WIN && hasFile(target, "gradlew.bat")) return "gradlew.bat assembleDebug";
        if (hasFile(target, "gradlew")) return "./gradlew assembleDebug";
        return "gradle assembleDebug";
      }
      case "web-react":
      case "web-vue":
      case "web-svelte":
      case "web-angular":
      case "web-vanilla":
      case "react-native": {
        const pkg = readPkgJson(target);
        const scripts = (pkg && pkg.scripts) || {};
        const runner = hasFile(target, "pnpm-lock.yaml") ? "pnpm"
          : hasFile(target, "yarn.lock") ? "yarn" : "npm";
        const runPrefix = runner === "npm" ? "npm run" : `${runner} run`;
        if (scripts.build) return `${runPrefix} build`;
        if (scripts.test) return `${runPrefix} test`;
        if (scripts.lint) return `${runPrefix} lint`;
        if (hasFile(target, "tsconfig.json")) return "npx tsc --noEmit";
        return "";
      }
      case "node-backend": {
        const pkg = readPkgJson(target);
        const scripts = (pkg && pkg.scripts) || {};
        if (scripts.test) return "npm test";
        if (scripts.build) return "npm run build";
        return "";
      }
      case "ios-swiftui": {
        if (process.platform !== "darwin") return "";
        if (hasFile(target, "Package.swift")) return "swift build";
        return "";
      }
      case "flutter":
        return "flutter analyze";
      case "python": {
        if (hasFile(target, "manage.py")) return "python manage.py check";
        if (isDir(join(target, "tests")) || anyMatch(target, ["**/test_*.py"], DEFAULT_IGNORE)) return "pytest -q";
        return "python -m compileall .";
      }
      case "rust":
        return "cargo check";
      case "go":
        return "go build ./...";
      default:
        return "";
    }
  } catch {
    return "";
  }
}
