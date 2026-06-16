// lib/tokens.mjs — design-token extraction (PURE read, no writes) + greenfield proposal.
//
// Heuristic / regex / "AST-lite" parsers — no language compilers, zero npm deps.
// Each parser is best-effort: unmatched constructs are skipped, never fatal.
// The function reads files via safeRead, dispatches by stack (+ file extension),
// merges results, and RETURNS the TokensObject. The artifact write happens at
// the orchestrate.mjs edge, not here.
//
// Synthesis §2 contract:
//   export function extractDesignTokens(files, stack, { fillGaps=true }={}) -> TokensObject
//   export function proposeGreenfieldTokens(stack, { darkForAndroid=true }={}) -> TokensObject
//
// TokensObject = { schemaVersion, stack, source{files,greenfield,confidence},
//   colors, semanticColors, typography, fontFamilies, spacing, radii,
//   elevation, motion, components, warnings }

import { readFileSync } from "node:fs";
import { extname, basename } from "node:path";

const SCHEMA_VERSION = "1.0";

function safeRead(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

// ----------------------------------------------------------------------------
// Color normalization helpers
// ----------------------------------------------------------------------------

const CSS_NAMED = {
  black: "#000000", white: "#FFFFFF", red: "#FF0000", green: "#008000", blue: "#0000FF",
  gray: "#808080", grey: "#808080", silver: "#C0C0C0", maroon: "#800000", olive: "#808000",
  lime: "#00FF00", aqua: "#00FFFF", cyan: "#00FFFF", teal: "#008080", navy: "#000080",
  fuchsia: "#FF00FF", magenta: "#FF00FF", purple: "#800080", orange: "#FFA500", yellow: "#FFFF00",
  transparent: "#00000000",
};

function clampByte(n) { return Math.max(0, Math.min(255, Math.round(n))); }
function toHex2(n) { return clampByte(n).toString(16).toUpperCase().padStart(2, "0"); }

// Build a normalized color value object from rgba components (a in 0..1).
function colorFromRgba(r, g, b, a, raw) {
  const R = clampByte(r), G = clampByte(g), B = clampByte(b);
  const A = a == null ? 1 : Math.max(0, Math.min(1, a));
  let hex = "#" + toHex2(R) + toHex2(G) + toHex2(B);
  if (A < 1) hex += toHex2(Math.round(A * 255));
  const rgba = [R, G, B, +A.toFixed(4)];
  const o = { hex, rgba };
  if (raw) o.raw = raw;
  return o;
}

// Android 0xAARRGGBB or 0xRRGGBB -> normalized.
function colorFromAndroidHex(hexDigits, raw) {
  const h = hexDigits.replace(/^0x/i, "");
  let a = 1, r, g, b;
  if (h.length === 8) {
    a = parseInt(h.slice(0, 2), 16) / 255;
    r = parseInt(h.slice(2, 4), 16);
    g = parseInt(h.slice(4, 6), 16);
    b = parseInt(h.slice(6, 8), 16);
  } else if (h.length === 6) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    return null;
  }
  return colorFromRgba(r, g, b, a, raw);
}

// CSS hex (#RGB, #RRGGBB, #RRGGBBAA) -> normalized.
function colorFromCssHex(hex, raw) {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length === 6) {
    return colorFromRgba(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1, raw);
  }
  if (h.length === 8) {
    return colorFromRgba(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255, raw);
  }
  return null;
}

function colorFromCssFunc(str, raw) {
  // rgb()/rgba()
  let m = str.match(/rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.%]+)\s*)?\)/i);
  if (m) {
    let a = 1;
    if (m[4] != null) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return colorFromRgba(+m[1], +m[2], +m[3], a, raw);
  }
  // hsl()/hsla()
  m = str.match(/hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*([\d.%]+)\s*)?\)/i);
  if (m) {
    const a = m[4] == null ? 1 : (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    const [r, g, b] = hslToRgb(+m[1], +m[2] / 100, +m[3] / 100);
    return colorFromRgba(r, g, b, a, raw);
  }
  return null;
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r * 255, g * 255, b * 255];
}

// Generic CSS color string -> normalized, or null.
function parseCssColor(str, raw) {
  const s = String(str).trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return colorFromCssHex(s, raw || s);
  if (/^(rgba?|hsla?)\(/i.test(s)) return colorFromCssFunc(s, raw || s);
  const named = CSS_NAMED[s.toLowerCase()];
  if (named) return colorFromCssHex(named, raw || s);
  return null;
}

// ----------------------------------------------------------------------------
// Dimension helpers
// ----------------------------------------------------------------------------

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function uniqSortNums(arr) {
  return [...new Set(arr.filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
}
function modalUnit(units) {
  const counts = {};
  let best = null, bestN = 0;
  for (const u of units) { counts[u] = (counts[u] || 0) + 1; if (counts[u] > bestN) { bestN = counts[u]; best = u; } }
  return best;
}

// ----------------------------------------------------------------------------
// Empty token object factory
// ----------------------------------------------------------------------------

function emptyTokens(stack, files) {
  return {
    schemaVersion: SCHEMA_VERSION,
    stack: stack || "generic",
    source: { files: files || [], greenfield: false, confidence: 0 },
    colors: {},
    semanticColors: {},
    typography: {},
    fontFamilies: {},
    spacing: { scale: [], unit: "", named: {} },
    radii: { named: {}, unit: "", scale: [] },
    elevation: { named: {}, scale: [], unit: "" },
    motion: { durations: {}, easings: {} },
    components: [],
    warnings: [],
  };
}

// ----------------------------------------------------------------------------
// Balanced-paren block extractor: given text and index of "(", return the
// substring between matching parens and the index after the close.
// ----------------------------------------------------------------------------

function balancedParen(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return { body: text.slice(openIdx + 1, i), end: i }; }
  }
  return { body: text.slice(openIdx + 1), end: text.length };
}

// ----------------------------------------------------------------------------
// Android / Kotlin parser
// ----------------------------------------------------------------------------

function parseKotlin(text, t, fileLabel) {
  // ----- Colors -----
  // Hex form: val Name = Color(0xFF0D0B08)
  const reHex = /val\s+(\w+)\s*=\s*Color\(\s*0x([0-9A-Fa-f]{6,8})\s*\)/g;
  let m;
  while ((m = reHex.exec(text))) {
    const c = colorFromAndroidHex(m[2], m[0].split("=")[1].trim());
    if (c) { if (!t.colors[m[1]]) t.colors[m[1]] = c; }
  }
  // Fractional / 1f form: val Name = Color(90f / 255, 123f / 255, 140f / 255, alpha = 0.07f)
  //                       val Name = Color(1f, 1f, 1f, alpha = 0.05f)
  const reFrac = /val\s+(\w+)\s*=\s*Color\(\s*([^)]*?)\)/g;
  while ((m = reFrac.exec(text))) {
    if (t.colors[m[1]]) continue; // already captured as hex
    const argsRaw = m[2];
    if (/0x/i.test(argsRaw)) continue;
    // Pull the first three channel exprs + optional alpha=
    const chan = argsRaw.match(/(-?[\d.]+f?)\s*(?:\/\s*255)?/g);
    const alphaM = argsRaw.match(/alpha\s*=\s*([\d.]+)f?/i);
    if (!chan || chan.length < 3) continue;
    const toChannel = (expr) => {
      const hasDiv = /\/\s*255/.test(expr);
      const base = parseFloat(expr);
      if (!Number.isFinite(base)) return null;
      if (hasDiv) return base; // already 0..255 numerator
      // 1f / 0.5f fractional -> scale to 255
      return base <= 1 ? base * 255 : base;
    };
    const r = toChannel(chan[0]), g = toChannel(chan[1]), b = toChannel(chan[2]);
    if (r == null || g == null || b == null) continue;
    const a = alphaM ? parseFloat(alphaM[1]) : 1;
    t.colors[m[1]] = colorFromRgba(r, g, b, a, m[0].split("=").slice(1).join("=").trim());
  }

  // ----- semanticColors from darkColorScheme(...) / lightColorScheme(...) -----
  const reScheme = /(?:dark|light)ColorScheme\s*\(/g;
  while ((m = reScheme.exec(text))) {
    const { body } = balancedParen(text, reScheme.lastIndex - 1);
    const slotRe = /(\w+)\s*=\s*(\w+)\s*,?/g;
    let sm;
    while ((sm = slotRe.exec(body))) {
      const slot = sm[1], ref = sm[2];
      // only material slot names (camelCase) -> keep symbol reference
      if (!t.semanticColors[slot]) t.semanticColors[slot] = ref;
    }
  }

  // ----- Typography: val Name = TextStyle( ... ) -----
  const reStyle = /val\s+(\w+)\s*=\s*TextStyle\s*\(/g;
  while ((m = reStyle.exec(text))) {
    const name = m[1];
    const { body } = balancedParen(text, reStyle.lastIndex - 1);
    const style = {};
    const fam = body.match(/fontFamily\s*=\s*(\w+)/);
    if (fam) style.family = fam[1];
    const wt = body.match(/fontWeight\s*=\s*FontWeight\.(\w+)/);
    if (wt) style.weight = wt[1];
    if (/fontStyle\s*=\s*FontStyle\.Italic/.test(body)) style.italic = true;
    const size = body.match(/fontSize\s*=\s*([\d.]+)\.sp/);
    if (size) { style.size = num(size[1]); style.unit = "sp"; }
    const lh = body.match(/lineHeight\s*=\s*([\d.]+)\.sp/);
    if (lh) style.lineHeight = num(lh[1]);
    const ls = body.match(/letterSpacing\s*=\s*\(?(-?[\d.]+)\)?\.(em|sp)/);
    if (ls) style.letterSpacing = ls[1] + ls[2];
    const col = body.match(/\bcolor\s*=\s*(\w+)/);
    if (col) style.color = col[1];
    if (Object.keys(style).length) t.typography[name] = style;
  }

  // ----- fontFamilies: val xFamily: FontFamily = FontFamily.Serif -----
  const reFam = /val\s+(\w+)\s*(?::\s*FontFamily)?\s*=\s*FontFamily\.(\w+)/g;
  while ((m = reFam.exec(text))) {
    const key = m[1].replace(/Family$/i, "");
    t.fontFamilies[key] = m[2];
  }

  // ----- Spacing / Dimens: val Name = 16.dp (inside object) -----
  const reDp = /val\s+(\w+)\s*=\s*([\d.]+)\.dp/g;
  while ((m = reDp.exec(text))) {
    // reDp only matches `val X = N.dp`; it cannot match the N.dp inside RoundedCornerShape(20.dp),
    // so no shape lookahead guard is needed (the old 80-char guard dropped legit spacing tokens
    // whenever a RoundedCornerShape happened to appear just after).
    t.spacing.named[m[1]] = num(m[2]);
    t.spacing.unit = "dp";
  }

  // ----- Shapes / radii: val Name = RoundedCornerShape(...) -----
  const reShape = /val\s+(\w+)\s*=\s*RoundedCornerShape\s*\(/g;
  while ((m = reShape.exec(text))) {
    const name = m[1];
    const { body } = balancedParen(text, reShape.lastIndex - 1);
    const pct = body.match(/percent\s*=\s*(\d+)/);
    if (pct) { t.radii.named[name] = pct[1] + "%"; t.radii.unit = t.radii.unit || "dp"; continue; }
    // collect all N.dp corners, take the largest as representative
    const corners = [...body.matchAll(/([\d.]+)\.dp/g)].map((x) => num(x[1])).filter((n) => n != null);
    if (corners.length) { t.radii.named[name] = Math.max(...corners); t.radii.unit = "dp"; }
  }

  // ----- Motion -----
  const dur = [...text.matchAll(/(?:tween\(\s*|durationMillis\s*=\s*)(\d+)/g)].map((x) => +x[1]);
  if (dur.length) {
    const sorted = uniqSortNums(dur);
    if (sorted.length === 1) t.motion.durations.default = sorted[0];
    else { t.motion.durations.fast = sorted[0]; t.motion.durations.default = sorted[sorted.length - 1]; }
  }
  const bez = text.match(/CubicBezierEasing\(([^)]+)\)/);
  if (bez) t.motion.easings.standard = "cubic-bezier(" + bez[1].replace(/f/g, "").replace(/\s+/g, "") + ")";

  // ----- Components: composable fun referencing DoNTech*, or object/data class DoNTech* -----
  if (/DoNTech|LocalDoNTechColors/.test(text)) {
    for (const cm of text.matchAll(/\bfun\s+(\w+)\s*\(/g)) {
      if (/^[A-Z]/.test(cm[1])) addComp(t, cm[1]); // composables are PascalCase
    }
  }
  for (const cm of text.matchAll(/(?:data\s+class|object|class)\s+(DoNTech\w+)/g)) addComp(t, cm[1]);
}

function addComp(t, name) {
  if (!t.components.includes(name)) t.components.push(name);
}

// ----------------------------------------------------------------------------
// Android XML parser (colors.xml / dimens.xml)
// ----------------------------------------------------------------------------

function parseAndroidXml(text, t) {
  for (const m of text.matchAll(/<color\s+name="([^"]+)"\s*>\s*(#[0-9A-Fa-f]+)\s*<\/color>/g)) {
    const c = colorFromCssHex(m[2], m[2]);
    if (c && !t.colors[m[1]]) t.colors[m[1]] = c;
  }
  for (const m of text.matchAll(/<dimen\s+name="([^"]+)"\s*>\s*([\d.]+)(dp|sp|px)\s*<\/dimen>/g)) {
    t.spacing.named[m[1]] = num(m[2]);
    t.spacing.unit = t.spacing.unit || m[3];
  }
}

// ----------------------------------------------------------------------------
// CSS / SCSS parser
// ----------------------------------------------------------------------------

function classifyCssVar(name, value, t, raw) {
  const n = name.toLowerCase();
  const col = parseCssColor(value, raw);
  if (col && (/color|colour|bg|background|fg|text|ink|brand|primary|secondary|accent|surface|border|outline|fill|stroke/.test(n) || /^(#|rgb|hsl)/i.test(value.trim()))) {
    t.colors[name] = col; return;
  }
  // dimension-bearing
  const dimMatch = value.match(/(-?[\d.]+)(px|rem|em|pt|dp)/);
  if (/radius|round|corner/.test(n) && dimMatch) {
    t.radii.named[name] = num(dimMatch[1]); t.radii.unit = t.radii.unit || dimMatch[2]; return;
  }
  if (/shadow|elevation|depth/.test(n)) {
    t.elevation.named[name] = value.trim(); return;
  }
  if (/duration|transition|animation-?duration/.test(n)) {
    const ms = value.match(/([\d.]+)\s*ms/) || value.match(/([\d.]+)\s*s/);
    if (ms) t.motion.durations[name] = value.includes("ms") ? +ms[1] : +ms[1] * 1000;
    return;
  }
  if (/ease|timing|bezier/.test(n)) { t.motion.easings[name] = value.trim(); return; }
  if (/font-?family|family/.test(n)) { t.fontFamilies[name] = value.trim(); return; }
  if (/font|text|size|leading|line-?height|weight|tracking|letter/.test(n) && dimMatch) {
    (t.typography[name] = t.typography[name] || {}).size = num(dimMatch[1]);
    t.typography[name].unit = dimMatch[2]; return;
  }
  if (/space|spacing|gap|pad|margin|inset|size|width|height/.test(n) && dimMatch) {
    t.spacing.named[name] = num(dimMatch[1]); t.spacing.unit = t.spacing.unit || dimMatch[2]; return;
  }
  // fallback: a bare color value wins
  if (col) { t.colors[name] = col; }
}

function parseCss(text, t) {
  // CSS custom props in any :root / selector block
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;{}]+);/g)) {
    classifyCssVar(m[1], m[2].trim(), t, m[2].trim());
  }
  // SCSS $vars
  for (const m of text.matchAll(/\$([\w-]+)\s*:\s*([^;!{}]+)\s*(?:!default)?\s*;/g)) {
    classifyCssVar(m[1], m[2].trim(), t, m[2].trim());
  }
}

// ----------------------------------------------------------------------------
// JS/TS theme / tailwind.config parser (AST-lite)
// ----------------------------------------------------------------------------

function parseJsTheme(text, t) {
  // Grab key:'#hex' / key:'rgb(...)' color-ish pairs anywhere.
  for (const m of text.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"](#[0-9A-Fa-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))['"]/g)) {
    const c = parseCssColor(m[2], m[2]);
    if (c && !t.colors[m[1]]) t.colors[m[1]] = c;
  }
  // spacing/borderRadius numeric or rem/px string pairs inside relevant blocks
  const blockOf = (key) => {
    const idx = text.search(new RegExp(key + "\\s*:\\s*\\{"));
    if (idx < 0) return "";
    const open = text.indexOf("{", idx);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(open + 1, i); }
    }
    return "";
  };
  const grabDims = (block, dest, group) => {
    for (const m of block.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"]?([\d.]+)(px|rem|em|pt)?['"]?/g)) {
      dest.named[m[1]] = num(m[2]);
      if (m[3]) dest.unit = dest.unit || m[3];
    }
  };
  grabDims(blockOf("spacing"), t.spacing, "spacing");
  grabDims(blockOf("borderRadius"), t.radii, "radii");
  // fontFamily
  for (const m of (blockOf("fontFamily") || "").matchAll(/['"]?([\w-]+)['"]?\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/g)) {
    t.fontFamilies[m[1]] = m[2].replace(/[[\]'"]/g, "").split(",")[0].trim();
  }
  // boxShadow -> elevation
  for (const m of (blockOf("boxShadow") || "").matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)) {
    t.elevation.named[m[1]] = m[2];
  }
}

// ----------------------------------------------------------------------------
// JSON tokens parser (W3C Design Tokens / Style Dictionary / our schema)
// ----------------------------------------------------------------------------

function parseJsonTokens(text, t) {
  let obj;
  try { obj = JSON.parse(text); } catch { return; }
  if (!obj || typeof obj !== "object") return;

  // Our own schema -> merge directly.
  if (obj.schemaVersion && (obj.colors || obj.spacing)) {
    if (obj.colors) for (const [k, v] of Object.entries(obj.colors)) if (!t.colors[k]) t.colors[k] = v;
    if (obj.semanticColors) Object.assign(t.semanticColors, obj.semanticColors);
    if (obj.typography) Object.assign(t.typography, obj.typography);
    if (obj.fontFamilies) Object.assign(t.fontFamilies, obj.fontFamilies);
    if (obj.spacing && obj.spacing.named) Object.assign(t.spacing.named, obj.spacing.named);
    if (obj.radii && obj.radii.named) Object.assign(t.radii.named, obj.radii.named);
    if (obj.elevation && obj.elevation.named) Object.assign(t.elevation.named, obj.elevation.named);
    if (obj.motion) { Object.assign(t.motion.durations, obj.motion.durations || {}); Object.assign(t.motion.easings, obj.motion.easings || {}); }
    return;
  }

  // W3C / Style Dictionary: recurse, look for {$value/$type} or {value}.
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    const val = node.$value != null ? node.$value : node.value;
    const type = node.$type || node.type;
    if (val != null && (typeof val === "string" || typeof val === "number")) {
      const name = path[path.length - 1] || "token";
      const sval = String(val);
      if (type === "color" || /^#|^rgb|^hsl/i.test(sval)) {
        const c = parseCssColor(sval, sval);
        if (c && !t.colors[name]) t.colors[name] = c;
      } else if (type === "dimension" || /px|rem|em|dp|pt/.test(sval)) {
        const dm = sval.match(/([\d.]+)(px|rem|em|dp|pt)?/);
        if (dm) {
          if (/radius|round|corner/i.test(path.join("."))) { t.radii.named[name] = num(dm[1]); t.radii.unit = t.radii.unit || (dm[2] || ""); }
          else { t.spacing.named[name] = num(dm[1]); t.spacing.unit = t.spacing.unit || (dm[2] || ""); }
        }
      }
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("$")) continue;
      walk(v, [...path, k]);
    }
  };
  walk(obj, []);
}

// ----------------------------------------------------------------------------
// iOS / Swift parser
// ----------------------------------------------------------------------------

function parseSwift(text, t) {
  for (const m of text.matchAll(/(?:static\s+)?let\s+(\w+)\s*=\s*Color\(\s*red:\s*([\d.]+),\s*green:\s*([\d.]+),\s*blue:\s*([\d.]+)(?:,\s*opacity:\s*([\d.]+))?/g)) {
    t.colors[m[1]] = colorFromRgba(+m[2] * 255, +m[3] * 255, +m[4] * 255, m[5] != null ? +m[5] : 1, m[0]);
  }
  for (const m of text.matchAll(/(?:static\s+)?let\s+(\w+)\s*=\s*Color\(hex:\s*"?(#?[0-9A-Fa-f]{6,8})"?\)/g)) {
    const c = colorFromCssHex(m[2].replace(/^#/, "#"), m[0]); if (c && !t.colors[m[1]]) t.colors[m[1]] = c;
  }
  for (const m of text.matchAll(/let\s+(\w+):\s*CGFloat\s*=\s*([\d.]+)/g)) {
    t.spacing.named[m[1]] = num(m[2]); t.spacing.unit = t.spacing.unit || "pt";
  }
  for (const m of text.matchAll(/\.font\(\.system\(size:\s*(\d+)/g)) {
    (t.typography["system" + m[1]] = t.typography["system" + m[1]] || {}).size = +m[1];
    t.typography["system" + m[1]].unit = "pt";
  }
}

// Swift asset catalog .colorset Contents.json
function parseColorset(text, t, fileLabel) {
  let obj; try { obj = JSON.parse(text); } catch { return; }
  const name = basename(fileLabel).replace(/\.colorset.*/, "") ||
    (fileLabel.match(/([^\\/]+)\.colorset/) || [])[1] || "color";
  const colors = (obj && obj.colors) || [];
  for (const entry of colors) {
    const comp = entry && entry.color && entry.color.components;
    if (!comp) continue;
    const to255 = (v) => {
      if (v == null) return 0;
      const s = String(v).trim();
      if (s.startsWith("0x")) return parseInt(s, 16);
      const f = parseFloat(s);
      return f <= 1 ? f * 255 : f;
    };
    const a = comp.alpha != null ? parseFloat(comp.alpha) : 1;
    t.colors[name] = colorFromRgba(to255(comp.red), to255(comp.green), to255(comp.blue), a, JSON.stringify(comp));
    break;
  }
}

// ----------------------------------------------------------------------------
// Flutter / Dart parser
// ----------------------------------------------------------------------------

function parseDart(text, t) {
  for (const m of text.matchAll(/(?:const\s+)?(\w+)\s*=\s*Color\(0x([0-9A-Fa-f]{8})\)/g)) {
    const c = colorFromAndroidHex(m[2], m[0]); if (c && !t.colors[m[1]]) t.colors[m[1]] = c;
  }
  for (const m of text.matchAll(/BorderRadius\.circular\(\s*([\d.]+)\s*\)/g)) {
    t.radii.scale.push(num(m[1])); t.radii.unit = t.radii.unit || "dp";
  }
  for (const m of text.matchAll(/TextStyle\(\s*[^)]*?fontSize:\s*([\d.]+)/g)) {
    const key = "style" + Object.keys(t.typography).length;
    t.typography[key] = { size: num(m[1]), unit: "dp" };
  }
  for (const m of text.matchAll(/fontFamily:\s*'([^']+)'/g)) { t.fontFamilies[m[1]] = m[1]; }
  for (const m of text.matchAll(/(?:const\s+)?(?:double\s+)?(\w+)\s*=\s*([\d.]+);/g)) {
    if (/space|spacing|gap|pad|margin|dimen|size/i.test(m[1])) { t.spacing.named[m[1]] = num(m[2]); t.spacing.unit = t.spacing.unit || "dp"; }
  }
}

// ----------------------------------------------------------------------------
// Finalize: derive scales, inline semantic refs, warnings.
// ----------------------------------------------------------------------------

function finalize(t) {
  // spacing scale from named values
  const spVals = Object.values(t.spacing.named).filter((v) => typeof v === "number");
  t.spacing.scale = uniqSortNums(spVals);
  if (!t.spacing.unit && t.spacing.scale.length) t.spacing.unit = "dp";

  // radii scale from numeric named values
  const rdVals = Object.values(t.radii.named).filter((v) => typeof v === "number");
  t.radii.scale = uniqSortNums([...rdVals, ...(t.radii.scale || [])]);

  // elevation scale
  const elVals = Object.values(t.elevation.named).filter((v) => typeof v === "number");
  t.elevation.scale = uniqSortNums([...(t.elevation.scale || []), ...elVals]);

  // semanticColors: inline hex if the referenced symbol exists in colors
  for (const [slot, ref] of Object.entries(t.semanticColors)) {
    if (typeof ref === "string" && t.colors[ref]) {
      // keep symbol name (per spec: semanticColors maps slot -> token name)
      t.semanticColors[slot] = ref;
    }
  }

  // warnings
  if (!Object.keys(t.elevation.named).length && !t.elevation.scale.length) t.warnings.push("no elevation tokens found");
  if (!Object.keys(t.motion.durations).length) t.warnings.push("no motion tokens found");
}

// ----------------------------------------------------------------------------
// Dispatch one file by stack + extension.
// ----------------------------------------------------------------------------

function parseFile(absPath, content, stack, t) {
  const ext = extname(absPath).toLowerCase();
  const base = basename(absPath).toLowerCase();

  if (ext === ".json") {
    if (absPath.toLowerCase().includes(".colorset")) parseColorset(content, t, absPath);
    else parseJsonTokens(content, t);
    return;
  }
  if (ext === ".kt") { parseKotlin(content, t, absPath); return; }
  if (ext === ".xml") { parseAndroidXml(content, t); return; }
  if (ext === ".css" || ext === ".scss" || ext === ".sass") { parseCss(content, t); return; }
  if (ext === ".html") { parseCss(content, t); return; } // inline :root / <style>
  if (ext === ".swift") { parseSwift(content, t); return; }
  if (ext === ".dart") { parseDart(content, t); return; }
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".cjs" || ext === ".mjs") {
    parseJsTheme(content, t);
    if (/:root|--[\w-]/.test(content)) parseCss(content, t); // CSS-in-JS template literals
    return;
  }
  if (ext === ".vue" || ext === ".svelte") { parseCss(content, t); return; }
  if (ext === ".toml") { parseCss(content, t); return; }
  // unknown -> try CSS + JSON best effort
  parseCss(content, t);
}

// ----------------------------------------------------------------------------
// PUBLIC: extractDesignTokens
// ----------------------------------------------------------------------------

export function extractDesignTokens(files, stack, opts = {}) {
  const fillGaps = opts.fillGaps !== false;
  try {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return proposeGreenfieldTokens(stack, opts);

    const t = emptyTokens(stack, list);
    let read = 0;
    for (const f of list) {
      const content = safeRead(f);
      if (content == null) continue;
      read++;
      try { parseFile(f, content, stack, t); } catch { /* skip this file */ }
    }

    finalize(t);

    const tokenCount =
      Object.keys(t.colors).length + Object.keys(t.typography).length +
      Object.keys(t.spacing.named).length + Object.keys(t.radii.named).length;

    // Confidence: coverage heuristic.
    t.source.confidence = +Math.min(1, tokenCount / 20).toFixed(2);

    if (tokenCount === 0) {
      t.warnings.push("files found but no tokens parsed");
      if (fillGaps) {
        const floor = proposeGreenfieldTokens(stack, opts);
        mergeFloor(t, floor);
        t.warnings.push("filled gaps with greenfield baseline");
      }
      t.source.greenfield = false;
      return t;
    }

    // Partial coverage floor-fill (non-destructive: only fills empty groups).
    if (fillGaps) {
      const floor = proposeGreenfieldTokens(stack, opts);
      if (!Object.keys(t.colors).length) Object.assign(t.colors, floor.colors);
      if (!Object.keys(t.spacing.named).length && !t.spacing.scale.length) { t.spacing = floor.spacing; }
      if (!Object.keys(t.radii.named).length && !t.radii.scale.length) { t.radii = floor.radii; }
      if (!Object.keys(t.typography).length) Object.assign(t.typography, floor.typography);
      if (!Object.keys(t.motion.durations).length) t.motion = floor.motion;
    }

    return t;
  } catch {
    // Total failure -> greenfield so downstream always has a usable object.
    const g = proposeGreenfieldTokens(stack, opts);
    g.warnings.push("extraction failed; returned greenfield baseline");
    return g;
  }
}

function mergeFloor(t, floor) {
  Object.assign(t.colors, floor.colors);
  Object.assign(t.semanticColors, floor.semanticColors);
  Object.assign(t.typography, floor.typography);
  Object.assign(t.fontFamilies, floor.fontFamilies);
  t.spacing = floor.spacing;
  t.radii = floor.radii;
  t.elevation = floor.elevation;
  t.motion = floor.motion;
}

// ----------------------------------------------------------------------------
// PUBLIC: proposeGreenfieldTokens
// ----------------------------------------------------------------------------

export function proposeGreenfieldTokens(stack, opts = {}) {
  const darkForAndroid = opts.darkForAndroid !== false;
  // never-throw contract: coerce any non-string (number/object/null) to "generic" so .startsWith is safe.
  const s = (typeof stack === "string" && stack) ? stack : "generic";
  const unit =
    s === "android-compose" ? "dp" :
    s === "ios-swiftui" ? "pt" :
    s === "flutter" ? "dp" :
    s.startsWith("web-") || s === "react-native" ? "px" : "px";
  const typeUnit =
    s === "android-compose" ? "sp" :
    s === "ios-swiftui" ? "pt" :
    "px";

  const isAndroidDark = s === "android-compose" && darkForAndroid;

  const colors = isAndroidDark
    ? {
        primary: { hex: "#C9A84C" }, background: { hex: "#0D0B08" }, surface: { hex: "#1A1612" },
        onSurface: { hex: "#F5F0E8" }, muted: { hex: "#8C8478" }, error: { hex: "#C4554F" }, success: { hex: "#7FB069" },
      }
    : {
        primary: { hex: "#3B82F6" }, background: { hex: "#0B0B0F" }, surface: { hex: "#16161A" },
        onSurface: { hex: "#F5F5F7" }, muted: { hex: "#8A8A93" }, error: { hex: "#E5484D" }, success: { hex: "#46A758" },
      };

  // normalize hex into full color objects
  const normColors = {};
  for (const [k, v] of Object.entries(colors)) {
    normColors[k] = colorFromCssHex(v.hex, v.hex);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    stack: s,
    source: { files: [], greenfield: true, confidence: 0.3 },
    colors: normColors,
    semanticColors: {
      background: "background", surface: "surface", onSurface: "onSurface",
      primary: "primary", error: "error",
    },
    typography: {
      display: { size: 32, unit: typeUnit, weight: "Light", lineHeight: 36 },
      body: { size: 16, unit: typeUnit, weight: "Normal", lineHeight: 22 },
      caption: { size: 12, unit: typeUnit, weight: "Normal", lineHeight: 16 },
    },
    fontFamilies: { display: "Serif", body: "SansSerif", mono: "Monospace" },
    spacing: { scale: [4, 8, 12, 16, 24, 32, 48], unit, named: { XS: 4, S: 8, M: 12, L: 16, XL: 24, XXL: 32, XXXL: 48 } },
    radii: { named: { sm: 4, md: 8, lg: 12, pill: "50%" }, unit, scale: [4, 8, 12, 16] },
    elevation: { named: {}, scale: [0, 1, 3, 6], unit },
    motion: { durations: { fast: 120, default: 240, slow: 400 }, easings: { standard: "cubic-bezier(0.2,0,0,1)" } },
    components: [],
    warnings: ["greenfield: no design system detected — proposed a minimal token baseline"],
  };
}
