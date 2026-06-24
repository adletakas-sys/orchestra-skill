// lib/context.mjs — persistent cross-agent / cross-run context memory (deliverable G).
//
// One deterministic markdown file per project lives INSIDE the skill:
//   <skillRoot>/context/<projectSlug>.md
// orchestrate.mjs is the SOLE writer. Models contribute structured text via an
// optional `context_notes` field that this module parses and inserts mechanically.
//
// HARD CONTRACT (synthesis §2): every operation is non-fatal. Functions never throw,
// never change the process exit code. A context failure logs (via cfg/ctx.log) and the
// caller continues. flush() is atomic (temp + rename); when the file is locked by a
// concurrent run we degrade to read-only mode and flush() becomes a no-op.
//
// Node 20+, ESM, node builtins only.

import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  openSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";

// ---------------------------------------------------------------------------
// Section model. Order is FIXED — slicing depends on it.
// key -> { id (HTML-comment fence id), title (markdown H2) }
// ---------------------------------------------------------------------------
const SECTION_DEFS = [
  { key: "stack", id: "stack", title: "Stack & Build" },
  { key: "designSystem", id: "designSystem", title: "Design System" },
  { key: "conventions", id: "conventions", title: "Conventions" },
  { key: "decisions", id: "decisions", title: "Decisions Log (ADR)" },
  { key: "glossary", id: "glossary", title: "Glossary" },
  { key: "activeTask", id: "activeTask", title: "Active Task" },
  { key: "references", id: "references", title: "References" },
  { key: "executorTraps", id: "executorTraps", title: "Executor Known Traps" },
];
const SECTION_KEYS = SECTION_DEFS.map((s) => s.key);
const SCHEMA_VERSION = 2;

// Per-role section selection + priority order (used for slicing + truncation).
// Lower priority value = dropped first when over budget.
const ROLE_SECTIONS = {
  executor: ["designSystem", "conventions", "activeTask", "executorTraps"],
  reviewer: ["stack", "designSystem", "conventions", "decisions", "glossary", "activeTask"],
  planner: ["stack", "designSystem", "conventions", "decisions", "glossary"],
  arbiter: ["stack", "designSystem", "conventions", "decisions", "glossary", "activeTask"],
};

// Caps for model-contributed list items (defensive against runaway notes).
const MAX_ITEM_CHARS = 500;
const MAX_ITEMS = 20;

// ---------------------------------------------------------------------------
// small helpers (all defensive — never throw)
// ---------------------------------------------------------------------------
function nowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

function safeLog(ctx, msg) {
  try {
    if (ctx && typeof ctx._log === "function") ctx._log(msg);
  } catch {
    /* swallow */
  }
}

function clampStr(s, n) {
  if (typeof s !== "string") {
    try {
      s = String(s);
    } catch {
      return "";
    }
  }
  return s.length > n ? s.slice(0, n) : s;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

// normalize a line for dedupe comparison (whitespace + leading list markers)
function normLine(s) {
  return String(s == null ? "" : s)
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s+/, "")
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// projectSlug — stable across runs and OS path-casing.
// "<human>.<sha1[0:12]>". c:\X and C:/x must collide (lowercase + fwd-slash).
// ---------------------------------------------------------------------------
export function projectSlug(absProjectDir) {
  try {
    const raw = absProjectDir == null ? "" : String(absProjectDir);
    const norm = raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const hash = createHash("sha1").update(norm).digest("hex").slice(0, 12);
    const human =
      basename(norm).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 40) || "project";
    return `${human}.${hash}`;
  } catch {
    // last-ditch: still produce a usable, deterministic-ish slug
    const h = createHash("sha1")
      .update(String(absProjectDir || "project"))
      .digest("hex")
      .slice(0, 12);
    return `project.${h}`;
  }
}

// ---------------------------------------------------------------------------
// fence-based section parse / serialize
// ---------------------------------------------------------------------------
function fenceOpen(id) {
  return `<!-- @section:${id} -->`;
}
function fenceClose(id) {
  return `<!-- @end:${id} -->`;
}

// Parse the persistent markdown into { frontMatter:{}, sections:{key:bodyString} }.
function parseFile(text) {
  const frontMatter = {};
  const sections = {};
  for (const k of SECTION_KEYS) sections[k] = "";
  if (typeof text !== "string" || !text) return { frontMatter, sections };

  try {
    // front-matter: leading ---\n ... \n---
    let body = text;
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (fmMatch) {
      body = text.slice(fmMatch[0].length);
      for (const line of fmMatch[1].split(/\r?\n/)) {
        const m = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
        if (m) frontMatter[m[1]] = m[2].trim();
      }
    }
    // sections by fence
    for (const def of SECTION_DEFS) {
      const open = fenceOpen(def.id);
      const close = fenceClose(def.id);
      const oi = body.indexOf(open);
      if (oi < 0) continue;
      const ci = body.indexOf(close, oi + open.length);
      if (ci < 0) continue;
      let inner = body.slice(oi + open.length, ci);
      // strip a leading H2 title line if present, keep the rest as body
      inner = inner.replace(/^\s*\r?\n/, "");
      sections[def.key] = inner.replace(/\s+$/, "");
    }
  } catch {
    /* return whatever we have */
  }
  return { frontMatter, sections };
}

function serializeFrontMatter(fm) {
  const order = [
    "projectSlug",
    "projectDir",
    "schema",
    "created",
    "updated",
    "lastRun",
    "stack",
    "designFilesHash",
  ];
  const lines = ["---"];
  const seen = new Set();
  for (const k of order) {
    if (fm[k] !== undefined && fm[k] !== null && fm[k] !== "") {
      lines.push(`${k}: ${fm[k]}`);
      seen.add(k);
    }
  }
  for (const k of Object.keys(fm)) {
    if (!seen.has(k) && fm[k] !== undefined && fm[k] !== null && fm[k] !== "") {
      lines.push(`${k}: ${fm[k]}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function serializeFile(ctx) {
  const parts = [serializeFrontMatter(ctx.frontMatter), ""];
  for (const def of SECTION_DEFS) {
    const bodyRaw = ctx.sections[def.key] || "";
    const body = bodyRaw.replace(/\s+$/, "");
    parts.push(fenceOpen(def.id));
    parts.push(`## ${def.title}`);
    if (body) parts.push(body);
    parts.push(fenceClose(def.id));
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

// Build a default section body (used on create / when empty).
function seedSection(key) {
  switch (key) {
    case "stack":
      return "- **Stack:** (pending detection)";
    case "designSystem":
      return "(pending design scan)";
    case "conventions":
      return "(conventions appear below)";
    case "decisions":
      return "(no decisions recorded yet)";
    case "glossary":
      return "(no glossary entries yet)";
    case "activeTask":
      return "(no active task yet)";
    case "references":
      return "(references appear below)";
    case "executorTraps":
      return "(no known failure patterns yet)";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// designFilesHash — cheap O(stat) hash of resolved design files (path+size+mtime).
// Caller passes the resolved file list (from detect.resolveDesignFiles) when it can;
// we compute the hash here so context owns the reuse decision.
// ---------------------------------------------------------------------------
export function computeDesignFilesHash(files) {
  try {
    const list = asArray(files).slice().sort();
    const h = createHash("sha1");
    for (const f of list) {
      h.update("|" + f);
      try {
        const st = statSync(f);
        h.update(":" + st.size + ":" + Math.floor(st.mtimeMs));
      } catch {
        h.update(":missing");
      }
    }
    return h.digest("hex").slice(0, 8);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// loadContext — compute slug + path, parse existing file, take the lock.
// Cross-run reuse: if the file exists, schema matches and designFilesHash is
// unchanged, set ctx.reusedScan = true so the caller skips the deep scan.
// ---------------------------------------------------------------------------
export async function loadContext({ projectDir, skillRoot, runDir, cfg } = {}) {
  const log =
    (cfg && typeof cfg.log === "function" && cfg.log) ||
    (typeof console !== "undefined" ? (m) => console.log(m) : () => {});

  const ctx = {
    // identity
    slug: "",
    file: "",
    lockFile: "",
    dir: projectDir || "",
    skillRoot: skillRoot || "",
    runDir: runDir || "",
    cfg: cfg || {},
    // state
    frontMatter: {},
    sections: {},
    reusedScan: false,
    readOnly: false,
    haveLock: false,
    loaded: false,
    _log: log,
    // method stubs are attached after construction (below)
  };

  try {
    const slug = projectSlug(projectDir || "");
    ctx.slug = slug;
    const ctxDir = join(skillRoot || ".", "context");
    ctx.file = join(ctxDir, `${slug}.md`);
    ctx.lockFile = join(ctxDir, `${slug}.lock`);

    try {
      mkdirSync(ctxDir, { recursive: true });
    } catch (e) {
      safeLog(ctx, `context: cannot create dir (${e.message}); read-only mode`);
      ctx.readOnly = true;
    }

    // initialize sections to empty
    for (const k of SECTION_KEYS) ctx.sections[k] = "";

    // parse existing file if present
    let existedSlug = null;
    if (existsSync(ctx.file)) {
      try {
        const text = readFileSync(ctx.file, "utf8");
        const parsed = parseFile(text);
        ctx.frontMatter = parsed.frontMatter || {};
        ctx.sections = parsed.sections || ctx.sections;
        existedSlug = ctx.frontMatter.projectSlug || null;
        ctx.loaded = true;
      } catch (e) {
        safeLog(ctx, `context: failed to read existing file (${e.message}); starting fresh`);
        ctx.frontMatter = {};
        for (const k of SECTION_KEYS) ctx.sections[k] = "";
      }
    }

    // ensure front-matter identity fields
    const tnow = nowIso();
    ctx.frontMatter.projectSlug = slug;
    ctx.frontMatter.projectDir = (projectDir || "").replace(/\\/g, "/");
    ctx.frontMatter.schema = String(SCHEMA_VERSION);
    if (!ctx.frontMatter.created) ctx.frontMatter.created = tnow;

    // seed empty sections so the file is always well-formed
    for (const k of SECTION_KEYS) {
      if (!ctx.sections[k] || !ctx.sections[k].trim()) ctx.sections[k] = seedSection(k);
    }

    // cross-run reuse decision (schema match + file existed). Actual hash
    // comparison happens against ctx.frontMatter.designFilesHash, which the
    // caller can refresh via ctx.checkReuse(files). Default false until proven.
    const schemaOk =
      String(ctx.frontMatter.schema || "") === String(SCHEMA_VERSION) &&
      (existedSlug == null || existedSlug === slug);
    ctx._schemaOk = schemaOk && ctx.loaded;
    ctx.reusedScan = false; // set true only by checkReuse() when hash matches

    // attach methods
    attachMethods(ctx);

    // acquire lock (best effort; failure -> read-only)
    if (!ctx.readOnly) acquireLock(ctx);
  } catch (e) {
    safeLog(ctx, `context: loadContext failed (${e && e.message}); degrading to read-only`);
    ctx.readOnly = true;
    // still attach methods so the caller's calls are safe no-ops
    try {
      attachMethods(ctx);
    } catch {
      /* ignore */
    }
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// locking: fs.open(path,'wx'); on EEXIST steal if stale (> cfg.context.lockStaleMs),
// else read-only mode (flush no-op + warn).
// ---------------------------------------------------------------------------
function lockStaleMs(ctx) {
  const v =
    ctx && ctx.cfg && ctx.cfg.context && Number(ctx.cfg.context.lockStaleMs);
  return Number.isFinite(v) && v > 0 ? v : 1800000; // 30 min default
}

function acquireLock(ctx) {
  try {
    let fd;
    try {
      fd = openSync(ctx.lockFile, "wx");
    } catch (e) {
      if (e && e.code === "EEXIST") {
        // existing lock — steal if stale, else read-only
        let stale = false;
        try {
          const st = statSync(ctx.lockFile);
          stale = Date.now() - st.mtimeMs > lockStaleMs(ctx);
        } catch {
          stale = true; // cannot stat -> assume stale
        }
        if (stale) {
          safeLog(ctx, "context: stealing stale lock (prior run likely died)");
          try {
            unlinkSync(ctx.lockFile);
          } catch {
            /* ignore */
          }
          try {
            fd = openSync(ctx.lockFile, "wx");
          } catch {
            ctx.readOnly = true;
            safeLog(ctx, "context: could not steal lock; read-only mode (flush disabled)");
            return;
          }
        } else {
          ctx.readOnly = true;
          safeLog(ctx, "context: file locked by another run; read-only mode (flush disabled)");
          return;
        }
      } else {
        // some other error -> read-only, do not block the pipeline
        ctx.readOnly = true;
        safeLog(ctx, `context: lock error (${e && e.message}); read-only mode`);
        return;
      }
    }
    try {
      writeFileSync(fd, `${process.pid} ${nowIso()}`);
    } catch {
      /* writing lock payload is best-effort */
    }
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    ctx.haveLock = true;
  } catch (e) {
    ctx.readOnly = true;
    safeLog(ctx, `context: acquireLock failed (${e && e.message}); read-only mode`);
  }
}

function releaseLock(ctx) {
  try {
    if (ctx && ctx.haveLock && ctx.lockFile && existsSync(ctx.lockFile)) {
      unlinkSync(ctx.lockFile);
    }
  } catch {
    /* ignore */
  }
  if (ctx) ctx.haveLock = false;
}

// ---------------------------------------------------------------------------
// updateContext(ctx, { section, mode, payload }) — in-memory only.
//   mode "replace": whole-section body (mechanical, deterministic).
//   mode "append":  additive list items (dedupes by normalized content).
// ---------------------------------------------------------------------------
export function updateContext(ctx, change) {
  try {
    if (!ctx || !ctx.sections) return;
    const { section, mode, payload } = change || {};
    if (!section || !SECTION_KEYS.includes(section)) return;

    if (mode === "replace") {
      const body = typeof payload === "string" ? payload : "";
      ctx.sections[section] = body.replace(/\s+$/, "");
      return;
    }

    if (mode === "append") {
      // payload: string | string[] of list items to append (deduped)
      const items = asArray(Array.isArray(payload) ? payload : [payload])
        .map((x) => clampStr(x, MAX_ITEM_CHARS).trim())
        .filter(Boolean)
        .slice(0, MAX_ITEMS);
      if (!items.length) return;

      const cur = ctx.sections[section] || "";
      // drop seed placeholders when we add real content
      let curBody = /^\((?:no |pending|conventions appear|references appear)/i.test(
        cur.trim()
      )
        ? ""
        : cur;

      const existing = new Set(
        curBody
          .split(/\r?\n/)
          .map(normLine)
          .filter(Boolean)
      );
      const toAdd = [];
      for (const it of items) {
        const n = normLine(it);
        if (n && !existing.has(n)) {
          existing.add(n);
          toAdd.push(it.startsWith("-") ? it : `- ${it}`);
        }
      }
      if (!toAdd.length) return;
      ctx.sections[section] = (curBody ? curBody.replace(/\s+$/, "") + "\n" : "") + toAdd.join("\n");
      return;
    }
    // unknown mode -> ignore
  } catch (e) {
    safeLog(ctx, `context: updateContext failed (${e && e.message})`);
  }
}

// ---------------------------------------------------------------------------
// model context_notes — type-validate, trim, cap, dedupe. Malformed -> dropped.
// Returns nothing; applies append/replace via updateContext.
// ---------------------------------------------------------------------------
function applyContextNotes(ctx, notes) {
  try {
    if (!notes || typeof notes !== "object") return;

    // conventions: string[]
    const conv = asArray(notes.conventions).filter((x) => typeof x === "string");
    if (conv.length) updateContext(ctx, { section: "conventions", mode: "append", payload: conv });

    // glossary: { TERM: definition }
    if (notes.glossary && typeof notes.glossary === "object" && !Array.isArray(notes.glossary)) {
      const gl = [];
      for (const [term, def] of Object.entries(notes.glossary)) {
        if (typeof term === "string" && typeof def === "string" && term.trim()) {
          gl.push(`**${clampStr(term, 80).trim()}** — ${clampStr(def, MAX_ITEM_CHARS).trim()}`);
        }
      }
      if (gl.length) updateContext(ctx, { section: "glossary", mode: "append", payload: gl });
    }

    // decisions: [{ title, status, rationale }]
    const dec = [];
    for (const d of asArray(notes.decisions)) {
      if (d && typeof d === "object" && typeof d.title === "string" && d.title.trim()) {
        const status = typeof d.status === "string" ? d.status.trim() : "proposed";
        const rationale = typeof d.rationale === "string" ? d.rationale.trim() : "";
        dec.push(
          `**${clampStr(d.title, 120).trim()}** (status: ${clampStr(status, 40)})` +
            (rationale ? ` — ${clampStr(rationale, MAX_ITEM_CHARS)}` : "")
        );
      }
    }
    if (dec.length) updateContext(ctx, { section: "decisions", mode: "append", payload: dec });
  } catch (e) {
    safeLog(ctx, `context: applyContextNotes failed (${e && e.message})`);
  }
}

// ---------------------------------------------------------------------------
// apply-shims attached to ctx (synthesis §2 ctx methods).
// ---------------------------------------------------------------------------
function attachMethods(ctx) {
  // checkReuse(files): recompute designFilesHash, set ctx.reusedScan if unchanged.
  ctx.checkReuse = function (files) {
    try {
      if (!ctx._schemaOk) {
        ctx.reusedScan = false;
        return false;
      }
      const prev = ctx.frontMatter.designFilesHash || "";
      const cur = computeDesignFilesHash(files);
      ctx._pendingDesignFilesHash = cur;
      ctx.reusedScan = !!prev && !!cur && prev === cur;
      if (ctx.reusedScan)
        safeLog(ctx, "context: reusing cached stack+tokens (no design changes)");
      return ctx.reusedScan;
    } catch (e) {
      safeLog(ctx, `context: checkReuse failed (${e && e.message})`);
      ctx.reusedScan = false;
      return false;
    }
  };

  ctx.applyStack = function (det) {
    try {
      const d = det && typeof det === "object" ? det : {};
      const stack = typeof d.stack === "string" ? d.stack : "generic";
      const verify =
        typeof d.verifyCmd === "string"
          ? d.verifyCmd
          : typeof d.verify === "string"
          ? d.verify
          : "";
      const buildFiles = asArray(d.markers)
        .map((m) => (m && typeof m === "object" ? m.file : m))
        .filter((x) => typeof x === "string")
        .slice(0, 8);
      const lines = [];
      lines.push(`- **Stack:** ${stack} (detected by lib/detect.mjs)`);
      if (typeof d.confidence === "number")
        lines.push(`- **Confidence:** ${d.confidence}`);
      lines.push(`- **Verify command:** ${verify ? "`" + verify + "`" : "(none)"}`);
      if (buildFiles.length) lines.push(`- **Markers:** ${buildFiles.join(", ")}`);
      updateContext(ctx, { section: "stack", mode: "replace", payload: lines.join("\n") });
      ctx.frontMatter.stack = stack;
    } catch (e) {
      safeLog(ctx, `context: applyStack failed (${e && e.message})`);
    }
  };

  ctx.applyDesignTokens = function (tokens) {
    try {
      const t = tokens && typeof tokens === "object" ? tokens : {};
      const lines = [];
      const src = t.source && typeof t.source === "object" ? t.source : {};
      const srcFiles = asArray(src.files).slice(0, 6);
      if (srcFiles.length) lines.push(`Source files: ${srcFiles.join(", ")}`);
      if (src.greenfield) lines.push("(greenfield: tokens proposed, not extracted)");

      const topN = (obj, n, fmt) => {
        if (!obj || typeof obj !== "object") return [];
        return Object.entries(obj)
          .slice(0, n)
          .map(([k, v]) => fmt(k, v));
      };
      const colors = topN(t.colors, 10, (k, v) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
      if (colors.length) lines.push(`- **Colors:** ${colors.join(", ")}`);
      const type = topN(t.typography, 8, (k, v) => {
        const size = v && typeof v === "object" ? v.size || v.fontSize || "" : v;
        return `${k}${size ? " " + size : ""}`;
      });
      if (type.length) lines.push(`- **Type scale:** ${type.join(", ")}`);
      const spacing = topN(t.spacing, 10, (k, v) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
      if (spacing.length) lines.push(`- **Spacing:** ${spacing.join(", ")}`);
      const radii = topN(t.radii, 8, (k, v) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
      if (radii.length) lines.push(`- **Radii:** ${radii.join(", ")}`);
      lines.push("(Truncated to top-N per category; full set in design-tokens.json.)");
      updateContext(ctx, { section: "designSystem", mode: "replace", payload: lines.join("\n") });

      // refresh designFilesHash (use the pending one staged by checkReuse if present)
      const h =
        ctx._pendingDesignFilesHash ||
        computeDesignFilesHash(srcFiles) ||
        ctx.frontMatter.designFilesHash ||
        "";
      if (h) ctx.frontMatter.designFilesHash = h;
    } catch (e) {
      safeLog(ctx, `context: applyDesignTokens failed (${e && e.message})`);
    }
  };

  ctx.applySpec = function (spec) {
    try {
      const s = spec && typeof spec === "object" ? spec : {};
      const lines = [];
      lines.push(`**Spec summary:** ${clampStr(s.summary || "", MAX_ITEM_CHARS)}`);
      const ac = asArray(s.acceptance_criteria).filter((x) => typeof x === "string");
      lines.push("**Acceptance criteria:**");
      if (ac.length) for (const c of ac.slice(0, MAX_ITEMS)) lines.push(`- [ ] ${clampStr(c, MAX_ITEM_CHARS)}`);
      else lines.push("- (none specified)");
      const cons = asArray(s.constraints).filter((x) => typeof x === "string");
      if (cons.length) lines.push(`**Constraints:** ${cons.map((c) => clampStr(c, 200)).join("; ")}`);
      const oos = asArray(s.out_of_scope).filter((x) => typeof x === "string");
      if (oos.length) lines.push(`**Out of scope:** ${oos.map((c) => clampStr(c, 200)).join("; ")}`);
      lines.push("");
      lines.push("**Iteration history:**");
      lines.push("**Open issues:**");
      lines.push("**Handoff notes:**");
      // preserve any prior iteration/open/handoff content? Fresh spec resets the task block.
      updateContext(ctx, { section: "activeTask", mode: "replace", payload: lines.join("\n") });
      // model-contributed notes from the spec
      applyContextNotes(ctx, s.context_notes);
    } catch (e) {
      safeLog(ctx, `context: applySpec failed (${e && e.message})`);
    }
  };

  ctx.applyIteration = function (it, info) {
    try {
      const i = info && typeof info === "object" ? info : {};
      const execCode = i.execCode === undefined ? "?" : i.execCode;
      const changed = Number.isFinite(i.changedCount) ? i.changedCount : 0;
      const line = `- it${it}: executor exit=${execCode}, changed ${changed} file(s) — review pending`;
      appendUnderHeading(ctx, "activeTask", "**Iteration history:**", line);
    } catch (e) {
      safeLog(ctx, `context: applyIteration failed (${e && e.message})`);
    }
  };

  // applyExecutorFailure: extract recurring failure patterns from a rejected verdict and
  // accumulate them in the executorTraps section. Injected into executor prompt on retry
  // via sliceForAgent so the executor knows what NOT to repeat.
  ctx.applyExecutorFailure = function (it, verdict) {
    try {
      const v = verdict && typeof verdict === "object" ? verdict : {};
      const traps = [];
      // extract blocking issues as short trap entries
      const blocking = asArray(v.blocking_issues).filter((x) => typeof x === "string");
      for (const b of blocking.slice(0, 5)) {
        traps.push(`[it${it}] ${clampStr(b, 200)}`);
      }
      // extract design system violations (most actionable)
      const dsv = asArray(v.design_system_violations);
      for (const d of dsv.filter((x) => x && x.severity === "blocking").slice(0, 3)) {
        const where = d.file ? d.file + (d.line ? ":" + d.line : "") : "?";
        traps.push(`[it${it}][DESIGN/${where}] ${clampStr(d.issue || "", 180)}${d.expected ? " → use " + d.expected : ""}`);
      }
      // extract a11y blocking findings
      const a11y = asArray(v.a11y_findings);
      for (const a of a11y.filter((x) => x && x.severity === "blocking").slice(0, 2)) {
        traps.push(`[it${it}][A11Y${a.wcag ? "/" + a.wcag : ""}] ${clampStr(a.issue || "", 160)}`);
      }
      if (traps.length) {
        updateContext(ctx, { section: "executorTraps", mode: "append", payload: traps });
      }
    } catch (e) {
      safeLog(ctx, `context: applyExecutorFailure failed (${e && e.message})`);
    }
  };

  ctx.applyReview = function (it, verdict) {
    try {
      const v = verdict && typeof verdict === "object" ? verdict : {};
      const approved = v.approved === true;
      const score = v.score === undefined ? "?" : v.score;
      const summary = clampStr(v.summary || "", 200);
      // update the matching iteration-history line in place (replace "review pending")
      replaceIterationVerdict(ctx, it, approved, score, summary);

      // open issues from blocking_issues
      const issues = asArray(v.blocking_issues)
        .filter((x) => typeof x === "string")
        .slice(0, MAX_ITEMS)
        .map((x) => `- ${clampStr(x, MAX_ITEM_CHARS)}`);
      replaceUnderHeading(
        ctx,
        "activeTask",
        "**Open issues:**",
        issues.length ? issues.join("\n") : "- (none)"
      );

      // handoff from feedback_for_executor + context_notes.handoff
      const fb = typeof v.feedback_for_executor === "string" ? v.feedback_for_executor.trim() : "";
      const handoffNote =
        v.context_notes && typeof v.context_notes.handoff === "string"
          ? v.context_notes.handoff.trim()
          : "";
      const handoffLines = [];
      if (fb) handoffLines.push(`- ${clampStr(fb, MAX_ITEM_CHARS * 2)}`);
      if (handoffNote) handoffLines.push(`- ${clampStr(handoffNote, MAX_ITEM_CHARS)}`);
      replaceUnderHeading(
        ctx,
        "activeTask",
        "**Handoff notes:**",
        handoffLines.length ? handoffLines.join("\n") : "- (none)"
      );

      applyContextNotes(ctx, v.context_notes);
    } catch (e) {
      safeLog(ctx, `context: applyReview failed (${e && e.message})`);
    }
  };
}

// Append a line directly under a bold heading line inside a section body.
function appendUnderHeading(ctx, section, heading, line) {
  try {
    const body = ctx.sections[section] || "";
    const lines = body.split(/\r?\n/);
    const idx = lines.findIndex((l) => l.trim() === heading.trim());
    if (idx < 0) {
      // heading missing — append heading + line at end
      ctx.sections[section] = body.replace(/\s+$/, "") + `\n${heading}\n${line}`;
      return;
    }
    // find end of this heading's block (until next bold heading or blank-then-heading)
    let insertAt = lines.length;
    for (let j = idx + 1; j < lines.length; j++) {
      if (/^\*\*.*\*\*\s*$/.test(lines[j].trim()) && lines[j].trim() !== heading.trim()) {
        insertAt = j;
        break;
      }
    }
    lines.splice(insertAt, 0, line);
    ctx.sections[section] = lines.join("\n");
  } catch (e) {
    safeLog(ctx, `context: appendUnderHeading failed (${e && e.message})`);
  }
}

// Replace the body lines under a heading with new content.
function replaceUnderHeading(ctx, section, heading, newBody) {
  try {
    const body = ctx.sections[section] || "";
    const lines = body.split(/\r?\n/);
    const idx = lines.findIndex((l) => l.trim() === heading.trim());
    if (idx < 0) {
      ctx.sections[section] = body.replace(/\s+$/, "") + `\n${heading}\n${newBody}`;
      return;
    }
    let end = lines.length;
    for (let j = idx + 1; j < lines.length; j++) {
      if (/^\*\*.*\*\*\s*$/.test(lines[j].trim())) {
        end = j;
        break;
      }
    }
    const before = lines.slice(0, idx + 1);
    const after = lines.slice(end);
    ctx.sections[section] = [...before, newBody, ...after].join("\n");
  } catch (e) {
    safeLog(ctx, `context: replaceUnderHeading failed (${e && e.message})`);
  }
}

// Rewrite the "it<N>: ... review pending" line with the actual verdict.
function replaceIterationVerdict(ctx, it, approved, score, summary) {
  try {
    const body = ctx.sections.activeTask || "";
    const lines = body.split(/\r?\n/);
    const verdictStr = `review approved=${approved} score=${score}${summary ? ' — "' + summary + '"' : ""}`;
    const reTarget = new RegExp(`^- it${it}:`);
    let found = false;
    for (let j = 0; j < lines.length; j++) {
      if (reTarget.test(lines[j].trim())) {
        lines[j] = lines[j].replace(/review pending$/, verdictStr).replace(/— review pending$/, "— " + verdictStr);
        if (!/approved=/.test(lines[j])) lines[j] = lines[j] + " — " + verdictStr;
        found = true;
        break;
      }
    }
    if (found) {
      ctx.sections.activeTask = lines.join("\n");
    } else {
      appendUnderHeading(
        ctx,
        "activeTask",
        "**Iteration history:**",
        `- it${it}: ${verdictStr}`
      );
    }
  } catch (e) {
    safeLog(ctx, `context: replaceIterationVerdict failed (${e && e.message})`);
  }
}

// ---------------------------------------------------------------------------
// sliceForAgent(ctx, role) -> markdown string, size-bounded.
// ---------------------------------------------------------------------------
export function sliceForAgent(ctx, role) {
  try {
    if (!ctx || !ctx.sections) return "";
    const keys = ROLE_SECTIONS[role] || ROLE_SECTIONS.reviewer;
    const cap =
      ctx.cfg && ctx.cfg.context && Number(ctx.cfg.context.maxSliceChars) > 0
        ? Number(ctx.cfg.context.maxSliceChars)
        : 12000;

    const blockFor = (key) => {
      const def = SECTION_DEFS.find((d) => d.key === key);
      const body = (ctx.sections[key] || "").trim();
      if (!def || !body) return "";
      return `## ${def.title}\n${body}`;
    };

    // assemble in role order
    let blocks = keys.map((k) => ({ key: k, text: blockFor(k) })).filter((b) => b.text);
    let out = blocks.map((b) => b.text).join("\n\n");
    if (out.length <= cap) return out;

    // over budget: drop lowest priority sections first (glossary, then decisions),
    // but NEVER drop the activeTask handoff. Priority = role order (later = lower).
    // Build a drop order: glossary, decisions, references, stack, designSystem,
    // conventions — but keep activeTask intact.
    // executorTraps is NOT in the drop order: it's injected into executor prompts and must survive truncation.
    const dropOrder = ["glossary", "decisions", "references", "stack", "designSystem", "conventions"];
    for (const dk of dropOrder) {
      if (out.length <= cap) break;
      blocks = blocks.filter((b) => b.key !== dk);
      out = blocks.map((b) => b.text).join("\n\n");
    }
    if (out.length > cap) {
      out = out.slice(0, Math.max(0, cap - 24)).replace(/\s+\S*$/, "") + "\n...[context truncated]";
    }
    return out;
  } catch (e) {
    safeLog(ctx, `context: sliceForAgent failed (${e && e.message})`);
    return "";
  }
}

// ---------------------------------------------------------------------------
// snapshotToRun(ctx) -> writes runDir/context.snapshot.md (frozen run copy).
// ---------------------------------------------------------------------------
export function snapshotToRun(ctx) {
  try {
    if (!ctx || !ctx.runDir) return;
    const target = join(ctx.runDir, "context.snapshot.md");
    const text = serializeFile(ctx);
    try {
      mkdirSync(ctx.runDir, { recursive: true });
    } catch {
      /* ignore */
    }
    writeFileSync(target, text);
  } catch (e) {
    safeLog(ctx, `context: snapshotToRun failed (${e && e.message})`);
  }
}

// ---------------------------------------------------------------------------
// flush(ctx) -> atomic temp+rename; releases lock. Read-only mode -> no-op + warn.
// ---------------------------------------------------------------------------
export async function flush(ctx) {
  try {
    if (!ctx) return;
    if (ctx.readOnly || !ctx.haveLock) {
      safeLog(ctx, "context: flush skipped (read-only mode / no lock held)");
      releaseLock(ctx); // harmless; only removes if we own it
      return;
    }
    if (!ctx.file) {
      safeLog(ctx, "context: flush skipped (no file path)");
      return;
    }

    // refresh provenance front-matter
    ctx.frontMatter.updated = nowIso();
    if (ctx.runDir) {
      try {
        ctx.frontMatter.lastRun = basename(ctx.runDir);
      } catch {
        /* ignore */
      }
    }
    if (ctx._pendingDesignFilesHash) {
      ctx.frontMatter.designFilesHash = ctx._pendingDesignFilesHash;
    }

    const text = serializeFile(ctx);
    const tmp = ctx.file + ".tmp";
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, ctx.file);
    } catch (e) {
      safeLog(ctx, `context: atomic write failed (${e && e.message}); trying direct write`);
      try {
        writeFileSync(ctx.file, text);
      } catch (e2) {
        safeLog(ctx, `context: direct write also failed (${e2 && e2.message})`);
      }
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    safeLog(ctx, `context: flush failed (${e && e.message})`);
  } finally {
    releaseLock(ctx);
  }
}
