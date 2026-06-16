/**
 * lib/usage.mjs — usage + cost logging for the /orchestra orchestrator v2.
 *
 * createUsage({ runDir, runStamp, cfg }) -> { record, flush, snapshotTotals }
 *
 *   record({ phase, agent, model, envelope?, raw?, diffBytes?, contextSliceChars? })
 *       Defensive: NEVER throws. Extracts input/output/cache tokens + cost from the
 *       Claude JSON envelope (usage{input_tokens,output_tokens,cache_creation_input_tokens,
 *       cache_read_input_tokens} + total_cost_usd + per-model modelUsage). mimo/gemini
 *       are recorded with metered:false (no token data); mimo/mimo-auto is free:true.
 *
 *   flush()  async  Writes usage.json + usage.md atomically (temp+rename). NEVER throws.
 *
 *   snapshotTotals()  Returns the computed totals object (for tests / inline logging).
 *
 * Pricing is read from cfg.pricing (perMTokens rates; cacheReadMultiplier;
 * cacheWrite5m/1hMultiplier; per-model in/out; free / metered flags;
 * baselineModel; unknownModelFallback). All cost figures are USD.
 *
 * Honesty: savings_pct is an estimate vs running everything on the baseline model.
 * BOTH a metered-only figure and a with-executor-estimate figure are reported, plus a
 * note that the split runs Opus in separate processes and loses cross-process prompt
 * caching, so true savings are lower than the headline.
 *
 * Node 20+, ESM, built-ins only.
 */

import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// ---------- small defensive helpers ----------
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function round(n, d = 4) {
  const f = Math.pow(10, d);
  return Math.round((num(n) + Number.EPSILON) * f) / f;
}
function atomicWrite(path, content) {
  // temp sibling + rename (atomic on same volume, Windows + POSIX)
  const tmp = path + ".tmp." + process.pid + "." + Date.now();
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ---------- pricing resolution ----------
function resolvePricing(cfg) {
  const p = obj(obj(cfg).pricing);
  return {
    cacheReadMultiplier: p.cacheReadMultiplier != null ? num(p.cacheReadMultiplier) : 0.1,
    cacheWrite5mMultiplier: p.cacheWrite5mMultiplier != null ? num(p.cacheWrite5mMultiplier) : 1.25,
    cacheWrite1hMultiplier: p.cacheWrite1hMultiplier != null ? num(p.cacheWrite1hMultiplier) : 2.0,
    models: obj(p.models),
    baselineModel: p.baselineModel || "claude-opus-4-8",
    unknownModelFallback: p.unknownModelFallback || "claude-opus-4-8",
    currency: p.currency || "USD",
  };
}

// Return the rate record {in,out,free?,metered?} for a model, falling back when unknown.
// usedFallback is reported via the out-param object so the report can flag stale pricing.
function rateFor(pricing, model, flags) {
  const models = pricing.models;
  if (model && Object.prototype.hasOwnProperty.call(models, model)) {
    return obj(models[model]);
  }
  if (flags) flags.usedFallback = true;
  const fb = pricing.unknownModelFallback;
  if (fb && Object.prototype.hasOwnProperty.call(models, fb)) {
    return obj(models[fb]);
  }
  return { in: 0, out: 0 };
}

// Compute USD for one model leg from token counts + rates + multipliers.
// rate.in / rate.out are USD per MILLION tokens (perMTokens).
function computeModelUsd(pricing, model, t) {
  const r = rateFor(pricing, model);
  const inRate = num(r.in);
  const outRate = num(r.out);
  const inputUsd = (num(t.in) / 1e6) * inRate;
  const outputUsd = (num(t.out) / 1e6) * outRate;
  const cacheReadUsd = (num(t.cache_read) / 1e6) * inRate * pricing.cacheReadMultiplier;
  const cacheWriteUsd =
    (num(t.cache_creation_5m) / 1e6) * inRate * pricing.cacheWrite5mMultiplier +
    (num(t.cache_creation_1h) / 1e6) * inRate * pricing.cacheWrite1hMultiplier;
  return inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd;
}

// Price the SAME token counts at the baseline model's rates (the "all-Opus" counterfactual).
function baselineUsd(pricing, t) {
  return computeModelUsd(pricing, pricing.baselineModel, t);
}

// ---------- envelope parsing ----------
// The Claude JSON envelope carries:
//   usage{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
//          cache_creation{ ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } }
//   modelUsage{ "<model>": { inputTokens, outputTokens, cacheReadInputTokens,
//                            cacheCreationInputTokens, costUSD } }
//   total_cost_usd
// extractJson in agents.callOpus may have unwrapped {type:'result',result}; the usage
// module is given the still-wrapped envelope (raw result before .result extraction).
function parseEnvelope(envelope) {
  const env = obj(envelope);
  const usage = obj(env.usage);

  // Top-level token aggregate.
  const top = {
    in: num(usage.input_tokens),
    out: num(usage.output_tokens),
    cache_read: num(usage.cache_read_input_tokens),
    cache_creation: num(usage.cache_creation_input_tokens),
  };
  const cc = obj(usage.cache_creation);
  top.cache_creation_5m = num(cc.ephemeral_5m_input_tokens);
  top.cache_creation_1h = num(cc.ephemeral_1h_input_tokens);
  // If the TTL split is absent but a total exists, attribute it to 5m (lower multiplier;
  // conservative for cost). If neither present, leave both 0.
  if (top.cache_creation && !top.cache_creation_5m && !top.cache_creation_1h) {
    top.cache_creation_5m = top.cache_creation;
  }

  // Per-model breakdown (a single "Opus" call can bill across Opus + a sprinkle of Haiku).
  const models = [];
  const mu = obj(env.modelUsage);
  for (const name of Object.keys(mu)) {
    const m = obj(mu[name]);
    models.push({
      model: name,
      in: num(m.inputTokens),
      out: num(m.outputTokens),
      cache_read: num(m.cacheReadInputTokens),
      cache_creation: num(m.cacheCreationInputTokens),
      // modelUsage does not carry the TTL split; assume same proportion as top-level.
      cache_creation_5m: 0,
      cache_creation_1h: 0,
      costUSD: m.costUSD != null ? num(m.costUSD) : null,
    });
  }

  // total_cost_usd is the authoritative billed figure when present.
  let totalCost = null;
  if (env.total_cost_usd != null) totalCost = num(env.total_cost_usd);
  else if (env.cost != null && typeof env.cost === "object" && env.cost.total_cost_usd != null) {
    totalCost = num(env.cost.total_cost_usd);
  }

  const hasUsage =
    !!env.usage ||
    models.length > 0 ||
    env.total_cost_usd != null;

  return { hasUsage, top, models, totalCost };
}

// Apportion the top-level TTL cache-creation split across the per-model entries
// proportionally to each model's cache_creation share, so computeModelUsd sees a TTL split.
function distributeTtl(top, models) {
  const totalCC = models.reduce((a, m) => a + num(m.cache_creation), 0);
  if (totalCC <= 0) return;
  const tot5m = num(top.cache_creation_5m);
  const tot1h = num(top.cache_creation_1h);
  for (const m of models) {
    const share = num(m.cache_creation) / totalCC;
    m.cache_creation_5m = tot5m * share;
    m.cache_creation_1h = tot1h * share;
  }
}

export function createUsage({ runDir, runStamp, cfg } = {}) {
  const RUN = runDir || ".";
  const STAMP = runStamp || "";
  const pricing = resolvePricing(cfg);
  const projectSlug = obj(obj(cfg)._ctx).projectSlug || ""; // optional, best-effort

  /** @type {Array<object>} */
  const calls = [];
  let fallbackCount = 0;

  // ----- record one agent call (defensive; never throws) -----
  function record(call) {
    try {
      const c = obj(call);
      const phase = c.phase != null ? String(c.phase) : "unknown";
      const agent = c.agent != null ? String(c.agent) : "unknown";
      const model = c.model != null ? String(c.model) : "";
      const rate = rateFor(pricing, model);
      const declaredFree = rate.free === true;
      const declaredUnmetered = rate.metered === false;

      const parsed = parseEnvelope(c.envelope);

      const entry = {
        phase,
        agent,
        model,
        in: 0,
        out: 0,
        cache_read: 0,
        cache_creation: 0,
        cache_creation_5m: 0,
        cache_creation_1h: 0,
        usd: 0,
        usd_computed: 0,
        free: false,
        metered: false,
        models: [],
      };

      if (parsed.hasUsage) {
        // ----- METERED Claude leg -----
        entry.metered = true;
        entry.free = declaredFree;

        // Build per-model legs. Prefer modelUsage breakdown; fall back to top-level
        // aggregate attributed to the declared model.
        let legs = parsed.models;
        if (!legs.length) {
          legs = [
            {
              model: model || pricing.baselineModel,
              in: parsed.top.in,
              out: parsed.top.out,
              cache_read: parsed.top.cache_read,
              cache_creation: parsed.top.cache_creation,
              cache_creation_5m: parsed.top.cache_creation_5m,
              cache_creation_1h: parsed.top.cache_creation_1h,
              costUSD: parsed.totalCost,
            },
          ];
        } else {
          distributeTtl(parsed.top, legs);
        }

        let computedSum = 0;
        let billedSum = 0;
        let billedKnown = false;
        const legOut = [];
        for (const leg of legs) {
          const flags = {};
          rateFor(pricing, leg.model, flags);
          if (flags.usedFallback) fallbackCount++;
          const legComputed = computeModelUsd(pricing, leg.model, leg);
          computedSum += legComputed;
          let legUsd = legComputed;
          if (leg.costUSD != null) {
            legUsd = num(leg.costUSD);
            billedSum += legUsd;
            billedKnown = true;
          }
          legOut.push({
            model: leg.model,
            in: round(leg.in, 0),
            out: round(leg.out, 0),
            cache_read: round(leg.cache_read, 0),
            cache_creation: round(leg.cache_creation, 0),
            usd: round(legUsd, 6),
          });
          entry.in += num(leg.in);
          entry.out += num(leg.out);
          entry.cache_read += num(leg.cache_read);
          entry.cache_creation += num(leg.cache_creation);
          entry.cache_creation_5m += num(leg.cache_creation_5m);
          entry.cache_creation_1h += num(leg.cache_creation_1h);
        }

        entry.models = legOut;
        entry.usd_computed = round(computedSum, 6);
        // Authoritative billed: total_cost_usd when present, else sum of per-leg costUSD,
        // else our computed figure.
        if (parsed.totalCost != null) entry.usd = round(parsed.totalCost, 6);
        else if (billedKnown) entry.usd = round(billedSum, 6);
        else entry.usd = round(computedSum, 6);

        // baseline = price the SAME tokens at baseline rates.
        entry._baseline = baselineUsd(pricing, {
          in: entry.in,
          out: entry.out,
          cache_read: entry.cache_read,
          cache_creation_5m: entry.cache_creation_5m,
          cache_creation_1h: entry.cache_creation_1h,
        });
        entry._estimated = false;

        // flag >5% divergence between billed and computed (stale pricing signal)
        if (entry.usd > 0 && entry.usd_computed > 0) {
          const div = Math.abs(entry.usd - entry.usd_computed) / entry.usd;
          if (div > 0.05) entry._priceDivergent = round(div * 100, 1);
        }
      } else {
        // ----- NON-METERED executor leg (mimo / gemini): no token data -----
        entry.metered = false;
        entry.free = declaredFree; // mimo/mimo-auto is free:true by policy
        entry.usd = 0;
        entry.usd_computed = 0;

        // Estimate the Opus-equivalent cost for the savings baseline from proxies:
        //   output tokens  ~= diffBytes / 4   (chars/4)
        //   input tokens   ~= contextSliceChars / 4
        const estOut = Math.round(num(c.diffBytes) / 4);
        const estIn = Math.round(num(c.contextSliceChars) / 4);
        if (estOut > 0 || estIn > 0) {
          entry.estimated_opus_in = estIn;
          entry.estimated_opus_out = estOut;
          entry._baselineEstimate = baselineUsd(pricing, {
            in: estIn,
            out: estOut,
            cache_read: 0,
            cache_creation_5m: 0,
            cache_creation_1h: 0,
          });
          entry._estimated = true;
        } else {
          entry._baselineEstimate = 0;
          entry._estimated = true;
        }
        // mark explicitly-unmetered models (e.g. gemini-3.5-flash metered:false) for clarity
        if (declaredUnmetered) entry._declaredUnmetered = true;
      }

      calls.push(entry);
    } catch {
      // swallow — usage must never fail the build
    }
  }

  // ----- compute aggregate totals -----
  function computeTotals() {
    const by_agent = {};
    let opus_billed_tokens = 0; // in+out billed at Opus rates (cache reads excluded)
    let free_tokens = 0;
    let est_cost_usd = 0;

    let baseline_metered_only = 0; // baseline for metered legs only
    let baseline_executor_est = 0; // baseline for estimated (executor) legs

    let sumCacheRead = 0;
    let sumIn = 0;
    let sumCacheCreation = 0;

    const baselineModel = pricing.baselineModel;

    for (const e of calls) {
      const a = e.agent || "unknown";
      if (!by_agent[a]) {
        by_agent[a] = { calls: 0, in: 0, out: 0, cache_read: 0, cache_creation: 0, usd: 0 };
      }
      const ag = by_agent[a];
      ag.calls += 1;
      ag.in += num(e.in);
      ag.out += num(e.out);
      ag.cache_read += num(e.cache_read);
      ag.cache_creation += num(e.cache_creation);
      ag.usd += num(e.usd);

      est_cost_usd += num(e.usd);

      if (e.metered) {
        baseline_metered_only += num(e._baseline);
        sumCacheRead += num(e.cache_read);
        sumIn += num(e.in);
        sumCacheCreation += num(e.cache_creation);
        // tokens billed at the baseline (Opus) model count toward the headline.
        for (const leg of e.models || []) {
          if (leg.model === baselineModel) {
            opus_billed_tokens += num(leg.in) + num(leg.out);
          }
        }
      } else {
        // non-metered: free models accumulate free_tokens via estimate; baseline via estimate
        baseline_executor_est += num(e._baselineEstimate);
        if (e.free) {
          free_tokens += num(e.estimated_opus_in) + num(e.estimated_opus_out);
        }
      }
    }

    // round by_agent
    for (const k of Object.keys(by_agent)) {
      const ag = by_agent[k];
      ag.in = round(ag.in, 0);
      ag.out = round(ag.out, 0);
      ag.cache_read = round(ag.cache_read, 0);
      ag.cache_creation = round(ag.cache_creation, 0);
      ag.usd = round(ag.usd, 6);
    }

    const baseline_all_opus_est = baseline_metered_only + baseline_executor_est;

    const savingsPct = (baseline, actual) => {
      if (baseline <= 0) return 0;
      return round(((baseline - actual) / baseline) * 100, 1);
    };

    // savings (with executor estimate) — the headline
    const savings_pct = savingsPct(baseline_all_opus_est, est_cost_usd);
    // savings (metered-only) — excludes the estimated executor leg from BOTH sides
    const savings_pct_metered_only = savingsPct(baseline_metered_only, est_cost_usd);

    const cacheDenom = sumCacheRead + sumIn + sumCacheCreation;
    const cache_hit_ratio = cacheDenom > 0 ? round(sumCacheRead / cacheDenom, 3) : 0;

    return {
      by_agent,
      opus_billed_tokens: round(opus_billed_tokens, 0),
      free_tokens: round(free_tokens, 0),
      est_cost_usd: round(est_cost_usd, 6),
      baseline_all_opus_est: round(baseline_all_opus_est, 6),
      baseline_metered_only_est: round(baseline_metered_only, 6),
      savings_pct,
      savings_pct_metered_only,
      cache_hit_ratio,
      notes: buildNotes(),
    };
  }

  function buildNotes() {
    const notes = [
      "Executor (mimo/gemini) tokens are not reported by the CLI; the Opus baseline for those legs is ESTIMATED from diff bytes + context-slice size (chars/4), and is a lower bound.",
      "The all-Opus baseline prices each step independently at " +
        pricing.baselineModel +
        " rates with NO shared prompt cache. Because plan/review run as separate Claude processes, cross-process prompt caching is lost; a single-process all-Opus run would pay less on the Opus legs due to cross-step cache reads, so true savings are lower than the headline figure.",
      "usd is the authoritative billed cost from the envelope (total_cost_usd / per-model costUSD); usd_computed is the config.pricing cross-check. A divergence >5% flags stale pricing.",
    ];
    if (fallbackCount > 0) {
      notes.push(
        fallbackCount +
          " model leg(s) priced via unknownModelFallback (" +
          pricing.unknownModelFallback +
          ") — update config.pricing.models."
      );
    }
    return notes;
  }

  function snapshotTotals() {
    try {
      return computeTotals();
    } catch {
      return {
        by_agent: {},
        opus_billed_tokens: 0,
        free_tokens: 0,
        est_cost_usd: 0,
        baseline_all_opus_est: 0,
        baseline_metered_only_est: 0,
        savings_pct: 0,
        savings_pct_metered_only: 0,
        cache_hit_ratio: 0,
        notes: [],
      };
    }
  }

  // ----- build the public usage.json object (strip private _fields) -----
  function buildUsageJson(totals) {
    const cleanCalls = calls.map((e) => {
      const out = {
        phase: e.phase,
        agent: e.agent,
        model: e.model,
        in: round(e.in, 0),
        out: round(e.out, 0),
        cache_read: round(e.cache_read, 0),
        cache_creation: round(e.cache_creation, 0),
        cache_creation_5m: round(e.cache_creation_5m, 0),
        cache_creation_1h: round(e.cache_creation_1h, 0),
        usd: round(e.usd, 6),
        usd_computed: round(e.usd_computed, 6),
        free: !!e.free,
        metered: !!e.metered,
      };
      if (e.models && e.models.length) out.models = e.models;
      if (e.estimated_opus_in != null) out.estimated_opus_in = e.estimated_opus_in;
      if (e.estimated_opus_out != null) out.estimated_opus_out = e.estimated_opus_out;
      if (e._priceDivergent != null) out.price_divergence_pct = e._priceDivergent;
      return out;
    });
    return {
      run: STAMP,
      projectSlug,
      generatedAt: new Date().toISOString(),
      pricingSource: "config.pricing",
      currency: pricing.currency,
      calls: cleanCalls,
      totals,
    };
  }

  // ----- usage.md (human summary) -----
  function pad(s, w, right = false) {
    s = String(s);
    if (s.length >= w) return s;
    const fill = " ".repeat(w - s.length);
    return right ? fill + s : s + fill;
  }
  function fmtUsd(n) {
    return "$" + num(n).toFixed(4);
  }
  function buildUsageMd(totals) {
    const lines = [];
    lines.push("# Usage — run " + STAMP);
    lines.push(
      "Project: " + (projectSlug || "(unknown)") + "   Pricing: config.pricing (" + pricing.currency + ")"
    );
    lines.push("");
    lines.push("## By phase");
    lines.push(
      "| " +
        pad("phase", 22) +
        " | " +
        pad("agent", 7) +
        " | " +
        pad("model", 18) +
        " | " +
        pad("in", 8, true) +
        " | " +
        pad("out", 7, true) +
        " | " +
        pad("cache_read", 11, true) +
        " | " +
        pad("cache_write", 11, true) +
        " | " +
        pad("usd", 10, true) +
        " |"
    );
    lines.push(
      "|" +
        "-".repeat(24) +
        "|" +
        "-".repeat(9) +
        "|" +
        "-".repeat(20) +
        "|" +
        "-".repeat(10) +
        "|" +
        "-".repeat(9) +
        "|" +
        "-".repeat(13) +
        "|" +
        "-".repeat(13) +
        "|" +
        "-".repeat(12) +
        "|"
    );
    for (const e of calls) {
      // non-metered legs render an em-dash, not 0, to avoid implying we measured zero tokens
      const dash = !e.metered;
      const inC = dash ? "–" : String(round(e.in, 0));
      const outC = dash ? "–" : String(round(e.out, 0));
      const crC = dash ? "–" : String(round(e.cache_read, 0));
      const cwC = dash ? "–" : String(round(e.cache_creation, 0));
      let usdC;
      if (dash) usdC = fmtUsd(e.usd) + (e.free ? " (free)" : " (unmetered)");
      else usdC = fmtUsd(e.usd);
      lines.push(
        "| " +
          pad(e.phase, 22) +
          " | " +
          pad(e.agent, 7) +
          " | " +
          pad(e.model, 18) +
          " | " +
          pad(inC, 8, true) +
          " | " +
          pad(outC, 7, true) +
          " | " +
          pad(crC, 11, true) +
          " | " +
          pad(cwC, 11, true) +
          " | " +
          pad(usdC, 10) +
          " |"
      );
    }
    lines.push("");
    lines.push("## Totals");
    const ba = totals.by_agent || {};
    for (const agent of Object.keys(ba)) {
      const ag = ba[agent];
      lines.push(
        "- " + agent + " calls: " + ag.calls + " — billed " + fmtUsd(ag.usd)
      );
    }
    lines.push("- **Opus billed tokens (in+out): " + totals.opus_billed_tokens + "**");
    lines.push("- **Estimated run cost: " + fmtUsd(totals.est_cost_usd) + "**");
    lines.push(
      "- All-Opus baseline (est, with executor estimate): " +
        fmtUsd(totals.baseline_all_opus_est) +
        " → **savings ≈ " +
        totals.savings_pct +
        "%**"
    );
    lines.push(
      "- All-Opus baseline (metered legs only): " +
        fmtUsd(totals.baseline_metered_only_est) +
        " → savings (metered-only) ≈ " +
        totals.savings_pct_metered_only +
        "%"
    );
    lines.push("- Cache hit ratio: " + Math.round(num(totals.cache_hit_ratio) * 100) + "%");
    lines.push("");
    lines.push("## Honesty notes");
    for (const n of totals.notes || []) lines.push("- " + n);
    lines.push("");
    return lines.join("\n");
  }

  // ----- flush (atomic; never throws) -----
  async function flush() {
    try {
      const totals = computeTotals();
      const usageJson = buildUsageJson(totals);
      atomicWrite(join(RUN, "usage.json"), JSON.stringify(usageJson, null, 2));
      atomicWrite(join(RUN, "usage.md"), buildUsageMd(totals));
    } catch {
      // best-effort: a usage write failure must never change the run's exit code
    }
  }

  return { record, flush, snapshotTotals };
}
