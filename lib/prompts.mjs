/**
 * lib/prompts.mjs — JSON Schemas + prompt builders for the /orchestra v2 pipeline.
 *
 * Exports (synthesis §2 / §4):
 *   SCHEMAS  : { plannerSpec, reviewVerdict, auditFinding, consiliumVerdict, uxCopy, referenceMatch, testPlan }
 *   SCHEMA(name) -> compact JSON string of SCHEMAS[name]
 *   plannerPrompt, reviewerPrompt, secondReviewerPrompt, reviewArbiterPrompt,
 *   testDesignerPrompt, auditPrompt, uxWriterPrompt, referencePrompt,
 *   consiliumExecMsg, consiliumArbiterPrompt, consiliumWritePrompt,
 *   executorMessage, executorRetryMessage
 *
 * All schemas are JSON Schema (draft 2020-12), additionalProperties:false. The engine
 * tolerates extra keys defensively. Every prompt that yields JSON ends with the exact
 * instruction to emit ONLY a JSON object (no prose, no markdown fences) followed by the
 * compacted SCHEMA(...) text so the agent sees the precise contract. Prompts are universal
 * (any stack / any app) and are grounded in the design tokens passed in at call time.
 *
 * Node v20, ESM, built-ins only. No external deps.
 */

/* ------------------------------------------------------------------ *
 * JSON SCHEMAS
 * ------------------------------------------------------------------ */

const plannerSpec = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "plannerSpec",
  type: "object",
  additionalProperties: false,
  required: ["summary", "relevant_files", "steps", "acceptance_criteria"],
  properties: {
    summary: { type: "string", description: "1-2 sentence restatement of the goal." },
    relevant_files: {
      type: "array",
      items: { type: "string" },
      description: "Existing repo files to read/modify (paths relative to --dir)."
    },
    new_files: {
      type: "array",
      items: { type: "string" },
      default: [],
      description: "Files to create, if any."
    },
    design: {
      type: "object",
      additionalProperties: false,
      description: "UI/UX design intent. Empty/omitted for non-UI tasks.",
      properties: {
        components: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "role"],
            properties: {
              name: { type: "string", description: "e.g. StreakCard, PrimaryCTA" },
              role: { type: "string", description: "what it does for the user" },
              tokens: {
                type: "array",
                items: { type: "string" },
                description: "design-system token names this component MUST use, e.g. Spacing.CardPadding, Shapes.Card, color.primary"
              }
            }
          }
        },
        states: {
          type: "array",
          items: { type: "string" },
          description: "render states to cover: default, loading, empty, error, pressed, focused, disabled, selected, rtl, longText"
        },
        interactions: {
          type: "array",
          items: { type: "string" },
          description: "tap/long-press/swipe/drag behaviors + expected result"
        },
        a11y: {
          type: "array",
          items: { type: "string" },
          description: "accessible names (contentDescription/aria-label/accessibilityLabel), adequate hit-target (>=48dp/44px), contrast >=4.5:1, focus order, screen-reader semantics"
        },
        motion: {
          type: "array",
          items: { type: "string" },
          description: "transitions/durations/easing; respect reduce-motion"
        },
        copy_needed: { type: "boolean", default: false, description: "true if user-facing strings must be authored (triggers UX writer)" }
      }
    },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "desc"],
        properties: {
          id: { type: "string", description: "stable id, e.g. S1, S2" },
          desc: { type: "string", description: "concrete, specific instruction" },
          files: { type: "array", items: { type: "string" }, description: "files this step touches" },
          heavy: { type: "boolean", default: false, description: "true => route this step through CONSILIUM (multi-agent + Opus arbiter)" }
        }
      }
    },
    acceptance_criteria: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description: "testable criteria the reviewer will check, one per line."
    },
    constraints: {
      type: "array",
      items: { type: "string" },
      default: [],
      description: "e.g. keep public API stable, dark-only, no new deps, match existing style"
    },
    out_of_scope: { type: "array", items: { type: "string" }, default: [] },
    context_notes: {
      type: "object",
      additionalProperties: false,
      description: "carry-forward knowledge for executor/reviewer and persistent context.",
      properties: {
        conventions: { type: "array", items: { type: "string" }, default: [], description: "repo conventions to honor (naming, layout, patterns)." },
        glossary: { type: "object", additionalProperties: { type: "string" }, default: {}, description: "domain terms -> meaning." },
        decisions: {
          type: "array",
          default: [],
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "status"],
            properties: {
              title: { type: "string" },
              status: { type: "string", description: "e.g. decided, assumed, open" },
              rationale: { type: "string", default: "" }
            }
          }
        },
        handoff: { type: "string", default: "", description: "anything the next agent/iteration must know (traps, assumptions)." }
      }
    }
  }
};

const reviewVerdict = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "reviewVerdict",
  type: "object",
  additionalProperties: false,
  required: ["approved", "score", "summary", "criteria_check", "feedback_for_executor"],
  properties: {
    approved: { type: "boolean" },
    score: { type: "integer", minimum: 0, maximum: 100, description: "overall quality 0-100; >=85 expected for approval" },
    summary: { type: "string", description: "short verdict, 1-2 sentences" },
    criteria_check: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "met"],
        properties: {
          criterion: { type: "string" },
          met: { type: "boolean" },
          note: { type: "string", default: "" }
        }
      }
    },
    design_system_violations: {
      type: "array",
      description: "every place the diff hardcodes a value that a token exists for, or misuses a token.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "issue", "severity"],
        properties: {
          file: { type: "string" },
          line: { type: "integer", description: "best-effort line in the diff/file" },
          issue: { type: "string", description: "e.g. 'hardcoded radius literal (RoundedCornerShape(20.dp) / border-radius:20px) — must use the Card shape token'" },
          expected: { type: "string", description: "the correct token, e.g. 'Shapes.Card'" },
          severity: { type: "string", enum: ["blocking", "major", "minor"] }
        }
      },
      default: []
    },
    a11y_findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["issue", "severity"],
        properties: {
          wcag: { type: "string", description: "WCAG ref, e.g. '1.4.3 contrast' or 'target-size'" },
          issue: { type: "string" },
          fix: { type: "string" },
          severity: { type: "string", enum: ["blocking", "major", "minor"] }
        }
      },
      default: []
    },
    visual_check: {
      type: "array",
      description: "per-screenshot visual judgment when rendered shots were provided (read the PNGs).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["state", "ok"],
        properties: {
          state: { type: "string", description: "render state / shot name, e.g. loading, empty, error, success" },
          variant: { type: "string", default: "", description: "theme/width/fontScale variant, if applicable" },
          ok: { type: "boolean", description: "true if this screen visually passes layout/spacing/contrast/overflow" },
          issues: { type: "array", items: { type: "string" }, default: [], description: "concrete visual problems seen in the pixels" },
          note: { type: "string", default: "" }
        }
      },
      default: []
    },
    blocking_issues: {
      type: "array",
      items: { type: "string" },
      description: "MUST be empty if approved===true.",
      default: []
    },
    non_blocking_suggestions: { type: "array", items: { type: "string" }, default: [] },
    feedback_for_executor: {
      type: "string",
      description: "single actionable fix block for the executor; empty string when approved===true."
    },
    context_notes: {
      type: "object",
      additionalProperties: false,
      description: "carry-forward notes for the next iteration / persistent context.",
      properties: {
        conventions: { type: "array", items: { type: "string" }, default: [] },
        glossary: { type: "object", additionalProperties: { type: "string" }, default: {} },
        decisions: {
          type: "array",
          default: [],
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "status"],
            properties: {
              title: { type: "string" },
              status: { type: "string" },
              rationale: { type: "string", default: "" }
            }
          }
        },
        handoff: { type: "string", default: "" }
      }
    }
  },
  allOf: [
    {
      if: { properties: { approved: { const: true } } },
      then: {
        properties: {
          blocking_issues: { maxItems: 0 },
          feedback_for_executor: { const: "" }
        }
      }
    }
  ]
};

const auditFinding = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "auditFinding",
  type: "object",
  additionalProperties: false,
  required: ["kind", "passed", "findings"],
  properties: {
    kind: { type: "string", enum: ["a11y", "perf", "security", "i18n"] },
    passed: { type: "boolean", description: "true if no blocking findings" },
    score: { type: "integer", minimum: 0, maximum: 100, default: 100 },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "severity", "blocking"],
        properties: {
          title: { type: "string" },
          file: { type: "string", default: "" },
          line: { type: "integer" },
          detail: { type: "string" },
          remediation: { type: "string", description: "concrete fix for the executor" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          blocking: { type: "boolean", description: "true => flips approval to false and feeds back" },
          ref: { type: "string", description: "standard ref: WCAG / CWE / lint id / BCP47, etc." }
        }
      },
      default: []
    }
  }
};

const consiliumVerdict = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "consiliumVerdict",
  type: "object",
  additionalProperties: false,
  required: ["chosen_candidate", "rationale"],
  properties: {
    chosen_candidate: {
      type: "string",
      enum: ["mimo", "gemini", "opus", "synthesis"],
      description: "winning candidate; 'synthesis' => Opus writes a hybrid using synthesized_patch_notes"
    },
    rationale: { type: "string", description: "why this candidate wins, referencing the heavy steps + acceptance criteria" },
    scores: {
      type: "object",
      additionalProperties: false,
      description: "0-100 per candidate on the heavy slice",
      properties: {
        mimo: { type: "integer", minimum: 0, maximum: 100 },
        gemini: { type: "integer", minimum: 0, maximum: 100 },
        opus: { type: "integer", minimum: 0, maximum: 100 }
      }
    },
    synthesized_patch_notes: {
      type: "string",
      default: "",
      description: "when chosen_candidate==='synthesis' or 'opus': exact instructions describing the hybrid to materialize (which hunks from which candidate + fixes)."
    },
    risks: {
      type: "array",
      items: { type: "string" },
      default: [],
      description: "residual risks in the chosen candidate for the reviewer to watch."
    }
  }
};

const uxCopy = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "uxCopy",
  type: "object",
  additionalProperties: false,
  required: ["strings"],
  properties: {
    voice_notes: { type: "string", default: "", description: "how the chosen copy honors the product voice (editorial, sentence-case, calm)." },
    strings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value"],
        properties: {
          key: { type: "string", description: "resource key, e.g. streak_card_title" },
          value: { type: "string", description: "the copy (default locale)" },
          context: { type: "string", default: "", description: "where it appears / constraints" },
          max_chars: { type: "integer", description: "hard length cap for layout fit" },
          tone: { type: "string", default: "", description: "e.g. encouraging, neutral-system, urgent" },
          translations: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "optional per-locale, e.g. {\"th\":\"...\"}",
            default: {}
          },
          do_not: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "anti-patterns to avoid (ALL CAPS, exclamation spam, jargon)"
          }
        }
      }
    }
  }
};

const referenceMatch = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "referenceMatch",
  type: "object",
  additionalProperties: false,
  required: ["match_pct", "deviations"],
  properties: {
    match_pct: { type: "number", minimum: 0, maximum: 100, description: "overall visual fidelity to the reference, 0-100." },
    per_screen: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["screen", "match_pct"],
        properties: {
          screen: { type: "string", description: "state/screen name or shot filename" },
          shot: { type: "string", description: "rendered PNG path" },
          reference: { type: "string", description: "reference PNG path" },
          match_pct: { type: "number", minimum: 0, maximum: 100 }
        }
      },
      default: []
    },
    deviations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["aspect", "observed", "expected", "severity"],
        properties: {
          aspect: { type: "string", enum: ["color", "spacing", "typography", "radius", "layout", "iconography", "elevation", "motion", "state"] },
          where: { type: "string", description: "screen/component locus" },
          observed: { type: "string" },
          expected: { type: "string", description: "what the reference shows (cite token if known)" },
          severity: { type: "string", enum: ["blocking", "major", "minor"] },
          fix: { type: "string" }
        }
      },
      default: []
    }
  }
};

const testPlan = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "testPlan",
  type: "object",
  additionalProperties: false,
  required: ["framework", "tests"],
  properties: {
    framework: { type: "string", description: "detected test framework + version" },
    test_files: { type: "array", items: { type: "string" }, default: [], description: "paths to create/extend" },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "covers", "file", "arrange", "act", "assert"],
        properties: {
          id: { type: "string", description: "stable id, e.g. T1" },
          name: { type: "string" },
          covers: { type: "array", items: { type: "string" }, description: "acceptance criterion text(s) this test covers" },
          file: { type: "string" },
          arrange: { type: "string" },
          act: { type: "string" },
          assert: { type: "string" },
          ui_state: { type: "string", default: "n/a", description: "default|loading|empty|error|...|n/a" }
        }
      }
    },
    notes: { type: "string", default: "", description: "fixtures/mocks/test-tags the executor must add" }
  }
};

export const SCHEMAS = {
  plannerSpec,
  reviewVerdict,
  auditFinding,
  consiliumVerdict,
  uxCopy,
  referenceMatch,
  testPlan
};

/**
 * SCHEMA(name) -> compact JSON.stringify of SCHEMAS[name].
 * Defensive: unknown name -> "{}" so a builder never throws on a typo.
 */
export function SCHEMA(name) {
  const s = SCHEMAS[name];
  return s ? JSON.stringify(s) : "{}";
}

/* ------------------------------------------------------------------ *
 * Shared helpers (internal)
 * ------------------------------------------------------------------ */

const TARGET = process.cwd();
const JSON_RULE = "Respond with ONLY a JSON object matching this schema (no prose, no markdown fences):";

function tok(tokens) {
  if (tokens == null) return "(no design system detected)";
  if (typeof tokens === "string") return tokens || "(no design system detected)";
  try {
    const s = JSON.stringify(tokens);
    if (!s || s === "{}" || s === "null") return "(no design system detected)";
    return s;
  } catch {
    return "(no design system detected)";
  }
}

function jstr(obj) {
  if (obj == null) return "{}";
  if (typeof obj === "string") return obj;
  try {
    return JSON.stringify(obj);
  } catch {
    return "{}";
  }
}

function ctxBlock(ctx) {
  if (ctx == null) return "";
  if (typeof ctx === "string") return ctx;
  return jstr(ctx);
}

function fenceDiff(diff) {
  return "```diff\n" + (diff && String(diff).length ? diff : "(no changes detected)") + "\n```";
}

function bulletSteps(heavySteps, withFiles) {
  const arr = Array.isArray(heavySteps) ? heavySteps : [];
  if (!arr.length) return "(no heavy steps listed)";
  return arr
    .map((s) => {
      const id = s && s.id != null ? s.id : "?";
      const desc = s && s.desc != null ? s.desc : "";
      if (withFiles) {
        const files = s && Array.isArray(s.files) && s.files.length ? s.files.join(", ") : "infer";
        return `- [${id}] ${desc}  (files: ${files})`;
      }
      return `- [${id}] ${desc}`;
    })
    .join("\n");
}

function pathList(paths) {
  const arr = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!arr.length) return "  (none)";
  return arr.map((p) => "  - " + p).join("\n");
}

/* ------------------------------------------------------------------ *
 * PROMPT BUILDERS
 * ------------------------------------------------------------------ */

/* B1 — planner / designer */
export function plannerPrompt(task, tokens, ctx, consiliumOn) {
  const TOKENS = tok(tokens);
  const CTX = ctxBlock(ctx);
  const consiliumNote = consiliumOn
    ? "Consilium is force-enabled for this run; still mark which steps are genuinely heavy."
    : "";
  return `You are the DESIGNER + ORCHESTRATOR (Claude Opus) in a multi-agent build pipeline.
A SEPARATE executor agent (the executor CLI, alternately a second model) WRITES all the code. You do NOT write or edit files.
Your job: turn the TASK into a precise, UI-aware implementation spec the executor can follow exactly.
You may read the repository (Read/Grep/Glob) to ground every decision in the REAL code. Working dir: ${TARGET}

DESIGN SYSTEM (tokens extracted from this repo — design STRICTLY to these; never invent a color or dp value that a token already covers):
${TOKENS}

CARRIED CONTEXT (decisions/traps from earlier work — honor these):
${CTX}

TASK:
${task}

How to spec:
1. Read the relevant_files before writing the spec. Cite exact file paths (relative to the working dir).
2. If the task touches UI, fill "design": name each component, its role, and the EXACT token names it must use
   (e.g. the shape/spacing/color token names that appear in the DESIGN SYSTEM above). Never specify a raw hex color
   or a raw dp number when a token exists for it. Enumerate the render "states" the executor must handle
   (default, loading, empty, error, pressed/focused/disabled where applicable), "interactions", "a11y"
   (adequate hit-target size [>=48dp Android / >=44px web·iOS], accessible names [contentDescription / aria-label / accessibilityLabel], contrast >=4.5:1), and "motion". Set "copy_needed":true if new
   user-facing strings are required.
3. Break work into ordered, concrete "steps" with stable ids (S1, S2, ...). Mark a step "heavy":true ONLY when it
   is architecturally risky, ambiguous, or quality-critical enough to warrant a multi-agent consilium (multiple
   executors each draft it, then an arbiter picks/synthesizes). Use heavy sparingly. ${consiliumNote}
4. acceptance_criteria must be testable and reviewer-checkable (one assertion each). Include design-system and a11y
   criteria for UI work (e.g. "uses the Card shape token, no raw corner radius", "all interactive targets meet the platform minimum hit-area").
5. constraints + out_of_scope keep the executor on-rails. Re-state hard rules from the design system that apply
   (e.g. dark-only, restricted accent usage, one-color-one-meaning).

${JSON_RULE}
${SCHEMA("plannerSpec")}`;
}

/* B3 — primary reviewer */
export function reviewerPrompt(task, spec, diff, verifyOut, tokens, ctx, imageManifestMd, refNote) {
  const TOKENS = tok(tokens);
  const CTX = ctxBlock(ctx);
  const verifyBlock = verifyOut ? "\nVERIFY OUTPUT (build/test):\n```\n" + verifyOut + "\n```\n" : "";
  const imgBlock = imageManifestMd && String(imageManifestMd).trim()
    ? "\nRENDERED SCREENSHOTS — use the Read tool to OPEN each PNG path below and visually inspect the actual pixels " +
      "(layout, spacing, alignment, contrast, text overflow/clipping, state correctness) BEFORE scoring design/a11y. " +
      "Fill the visual_check[] array with one entry per screen you inspected:\n" + imageManifestMd + "\n"
    : "";
  const refBlock = refNote ? "\nREFERENCE COMPARISON (advisory): " + refNote + "\n" : "";
  return `You are the REVIEWER (Claude Opus). The executor just produced the diff below. Review STRICTLY.
You may read repo files for context (read-only: Read/Grep/Glob). Working dir: ${TARGET}

Be tough but fair. Judge on this rubric and produce a 0-100 score (approve only at >=85 with ZERO blocking issues):
  A. CORRECTNESS & COMPLETENESS — every acceptance_criterion met; no regressions; builds.
  B. DESIGN-SYSTEM FIDELITY — the diff uses the project's tokens and NEVER hardcodes a color or dp value a token covers.
     Flag each violation in design_system_violations with the file, the offending code, and the exact expected token.
  C. ACCESSIBILITY — adequate hit-target size (>=48dp Android / >=44px web·iOS), an accessible name on every interactive/iconic
     element (contentDescription / aria-label / accessibilityLabel), text contrast >=4.5:1 (>=3:1 large), sensible focus/reader
     order, no color-only signaling. Flag in a11y_findings with WCAG ref.
  D. QUALITY — readability, error/empty/loading states handled, no obvious security/perf foot-guns.

DESIGN SYSTEM (the contract the diff must honor):
${TOKENS}

CARRIED CONTEXT:
${CTX}

TASK:
${task}

SPEC (from the designer):
${jstr(spec)}

GIT DIFF (working tree vs HEAD):
${fenceDiff(diff)}
${verifyBlock}${imgBlock}${refBlock}
Rules:
- approved:true REQUIRES blocking_issues:[] AND feedback_for_executor:"" AND score>=85.
- Any design_system_violation or a11y_finding with severity "blocking" => approved MUST be false.
- feedback_for_executor must be a single, concrete, copy-pasteable fix block when rejecting (and "" when approving).

${JSON_RULE}
${SCHEMA("reviewVerdict")}`;
}

/* C2 — independent second reviewer (Gemini) */
export function secondReviewerPrompt(task, spec, diff, verifyOut, tokens) {
  const TOKENS = tok(tokens);
  const verifyBlock = verifyOut ? "\nVERIFY OUTPUT:\n```\n" + verifyOut + "\n```\n" : "";
  return `You are an INDEPENDENT SECOND REVIEWER in a build pipeline. A primary reviewer is judging the same diff
separately; do NOT assume their conclusions. Form your OWN verdict from the evidence. Read-only.

Apply the same rubric: (A) correctness vs acceptance_criteria, (B) design-system fidelity to the tokens below,
(C) accessibility, (D) quality. Score 0-100; approve only at >=85 with zero blocking issues.
Focus especially on anything a single reviewer might miss: edge states, regressions in untouched call-sites,
silent token drift, and a11y gaps.

DESIGN SYSTEM:
${TOKENS}

TASK:
${task}

SPEC:
${jstr(spec)}

GIT DIFF:
${fenceDiff(diff)}
${verifyBlock}
${JSON_RULE}
${SCHEMA("reviewVerdict")}`;
}

/* C2 — review arbiter (Opus reconciles two verdicts) */
export function reviewArbiterPrompt(task, spec, primaryVerdict, secondVerdict) {
  return `You are the REVIEW ARBITER (Claude Opus). Two independent reviewers judged the same diff. Reconcile them into ONE
final verdict. Read-only.

Reconciliation rules:
- If EITHER reviewer raised a blocking_issue or a "blocking"-severity design/a11y finding that is factually correct,
  the final verdict is approved:false and you MUST carry that finding forward.
- Drop findings that are demonstrably wrong (state which and why in summary). Merge duplicate findings.
- The final score is your own judgment informed by both (not a naive average).
- Produce a SINGLE feedback_for_executor that unions the valid, actionable fixes from both reviewers.

PRIMARY REVIEWER (Opus) VERDICT:
${jstr(primaryVerdict)}

SECOND REVIEWER (Gemini) VERDICT:
${jstr(secondVerdict)}

TASK:
${task}

SPEC:
${jstr(spec)}

${JSON_RULE}
${SCHEMA("reviewVerdict")}`;
}

/* C3 — test designer (pre-code) */
export function testDesignerPrompt(task, spec, tokens, ctx) {
  const TOKENS = tok(tokens);
  const CTX = ctxBlock(ctx);
  return `You are the TEST DESIGNER (Claude Opus). BEFORE any code is written, turn the acceptance_criteria into a concrete,
executable test plan the executor will satisfy and the reviewer will check. Read-only; you do NOT write code.
Working dir: ${TARGET}. Inspect existing test infrastructure (frameworks, naming, fixtures) and match it.

For each acceptance criterion, design at least one test: name it, state the arrange/act/assert, the file it belongs in,
and (for UI) the render state + interaction it exercises. Prefer the repo's existing test stack — do NOT introduce a
new framework. For UI assertions, assert against design tokens, not literal values.

DESIGN SYSTEM (for UI assertions — assert against tokens, not literals):
${TOKENS}

CARRIED CONTEXT:
${CTX}

TASK:
${task}

SPEC:
${jstr(spec)}

${JSON_RULE}
${SCHEMA("testPlan")}`;
}

/* C4 — audits, parameterized by kind */
const AUDIT_CHECKLIST = {
  a11y: `- Every interactive/iconic element has an accessible name (contentDescription / aria-label / accessibilityLabel; explicit null/empty only for decorative).
- Adequate hit-target size (>=48dp Android, >=44px web/iOS); no two targets overlapping.
- Text contrast >=4.5:1 (>=3:1 for large/bold text) against its actual background token.
- No information conveyed by color alone (state has text/icon too).
- Logical focus + screen-reader traversal order; headings semantically marked.
- Dynamic-type / font-scale safe (no fixed-height clipping at large scale).`,
  perf: `- No work on the main thread that belongs off it (I/O, parsing, heavy loops).
- UI layer: stable params, no unnecessary re-render/recomposition, no allocations in the hot render path; memoize where due.
- Lists use stable keys; no full-list rebuilds; images sized/sampled, not decoding full-res.
- No leaked coroutines/listeners/subscriptions; no O(n^2) over user-scale data.`,
  security: `- No secrets/keys/tokens hardcoded; no logging of PII/credentials.
- Inputs validated; no injection (SQL/intent/path); no insecure deserialization.
- Network over TLS; no disabled cert validation; least-privilege permissions.
- Safe defaults; no world-readable storage of sensitive data. Cite CWE where applicable.`,
  i18n: `- No hardcoded user-facing strings (must be resource-referenced).
- No string concatenation to build sentences; use placeholders/plurals.
- Layouts tolerate +40% text expansion and RTL mirroring.
- Locale-correct number/date/currency formatting; verify any required secondary-locale parity from the design system.`
};

export function auditPrompt(kind, task, spec, diff, tokens) {
  const TOKENS = tok(tokens);
  const KIND = AUDIT_CHECKLIST[kind] ? kind : "a11y";
  const checklist = AUDIT_CHECKLIST[KIND];
  return `You are a specialist AUDITOR (Claude Opus) running the ${KIND} audit pass on the diff below. Read-only.
Report only DEFENSIBLE findings grounded in the actual diff/code. Mark "blocking":true only for issues that must be
fixed before this change ships. Working dir: ${TARGET}.

DESIGN SYSTEM (context):
${TOKENS}

TASK:
${task}

SPEC:
${jstr(spec)}

GIT DIFF:
${fenceDiff(diff)}

${KIND}-CHECKLIST:
${checklist}

${JSON_RULE}
Set "kind":"${KIND}".
${SCHEMA("auditFinding")}`;
}

/* B4 — ux writer */
export function uxWriterPrompt(task, spec, tokens, ctx) {
  const TOKENS = tok(tokens);
  const CTX = ctxBlock(ctx);
  return `You are the UX WRITER (Claude Opus). Author the user-facing copy this change needs. Read-only; copy only, no code.
Honor the product voice: editorial and calm, sentence case (never ALL CAPS except where the design system explicitly
calls for an uppercase eyebrow/label style), no exclamation spam, no jargon. Match the tone to context (encouraging for
streaks/achievements, neutral for system messages, urgent-but-respectful for time-sensitive UI). Keep within any layout
length caps. Working dir: ${TARGET}.

DESIGN SYSTEM (voice/typography cues — respect which styles are uppercase-only, etc.):
${TOKENS}

CARRIED CONTEXT:
${CTX}

TASK:
${task}

SPEC (design.copy_needed / components indicate where strings go):
${jstr(spec)}

Provide a default-locale value for every needed string, plus a translation for any secondary locale the design system
indicates parity for. Give each a resource key, max_chars (if layout-constrained), tone, and do_not anti-patterns.

${JSON_RULE}
${SCHEMA("uxCopy")}`;
}

/* D2 — reference comparison */
export function referencePrompt(task, spec, tokens, shotPaths, refPaths, pixelDiffNote) {
  const TOKENS = tok(tokens);
  const pixelBlock = pixelDiffNote
    ? "\nPIXEL-DIFF HINT (from compareToReference, advisory): " + pixelDiffNote + "\n"
    : "";
  return `You are the VISUAL FIDELITY JUDGE (Claude Opus). Compare the rendered build against the design reference.
Use the Read tool to OPEN each PNG below and inspect it directly (rendered first, then its reference).

RENDERED SCREENSHOTS:
${pathList(shotPaths)}

REFERENCE IMAGES:
${pathList(refPaths)}
${pixelBlock}
DESIGN SYSTEM (judge deviations against these tokens, not arbitrary taste):
${TOKENS}

TASK:
${task}

SPEC:
${jstr(spec)}

For each matched screen give a match_pct, and enumerate concrete deviations by aspect (color/spacing/typography/
radius/layout/iconography/elevation/motion/state). For each deviation, state observed vs expected (cite the token
when the reference clearly maps to one) and a severity. A deviation is "blocking" only if it breaks brand/usability.

${JSON_RULE}
${SCHEMA("referenceMatch")}`;
}

/* E — consilium build message (mimo / gemini / Opus build brief) */
export function consiliumExecMsg(spec, heavySteps, lastFinalVerdict) {
  const prior = lastFinalVerdict && lastFinalVerdict.feedback_for_executor
    ? "## Prior review feedback to incorporate\n" + lastFinalVerdict.feedback_for_executor + "\n\n"
    : "";
  return `# Heavy build slice (CONSILIUM)
You are producing ONE candidate implementation of the HEAVY steps below from a clean baseline.
Implement ONLY these steps; treat the rest of the spec as fixed context you must not break.

## Heavy steps
${bulletSteps(heavySteps, true)}

## Full spec (context)
${jstr(spec)}

${prior}Make minimal, focused, buildable changes that honor the design system tokens and acceptance criteria. Then stop.`;
}

/* E.d — consilium arbiter (read-only judge over the three candidate patches) */
export function consiliumArbiterPrompt(spec, heavySteps, candidates, tokens) {
  const TOKENS = tok(tokens);
  const c = candidates || {};
  return `You are the CONSILIUM ARBITER (Claude Opus). Three agents independently implemented the SAME heavy steps.
Choose the best candidate, or specify a SYNTHESIS that takes the best hunks from several. Read-only here — you judge;
the engine will materialize your choice afterward.

Judge each candidate on: correctness vs the heavy steps' intent, design-system fidelity (tokens below), a11y,
minimalism, and risk. If one candidate is clearly best, pick it. If a hybrid is strictly better, choose "synthesis"
and write synthesized_patch_notes precise enough for an executor to assemble (which hunks from which candidate + fixes).

## Heavy steps
${bulletSteps(heavySteps, false)}

## Full spec
${jstr(spec)}

## DESIGN SYSTEM
${TOKENS}

## Candidate A — mimo
\`\`\`diff
${c.mimo || "(empty)"}
\`\`\`
## Candidate B — gemini
\`\`\`diff
${c.gemini || "(empty)"}
\`\`\`
## Candidate C — opus
\`\`\`diff
${c.opus || "(empty)"}
\`\`\`

${JSON_RULE}
${SCHEMA("consiliumVerdict")}`;
}

/* E.c / synthesis — consilium write (Opus WRITE mode, consilium only) */
export function consiliumWritePrompt(spec, heavySteps, chosen, notes, tokens) {
  const TOKENS = tok(tokens);
  const action = chosen === "synthesis"
    ? "Assemble the synthesis exactly as described:"
    : "Reproduce/clean the chosen candidate '" + (chosen || "opus") + "' and fix its noted risks:";
  return `You are the ARBITER, now in WRITE mode. Materialize the chosen heavy-slice implementation directly in the working tree.
Edit ONLY files within the scoped directory. ${action}

## Synthesis / finalization notes
${notes || "(none)"}

## Heavy steps
${bulletSteps(heavySteps, false)}

## Full spec (do not break the non-heavy parts)
${jstr(spec)}

## DESIGN SYSTEM (use tokens; never hardcode a color or dp value a token covers)
${TOKENS}

Apply the edits and stop. Do not run the app or tests.`;
}

/* Iteration 1 — first executor message */
export function executorMessage(spec, task, ctxSlice) {
  const ctxBlk = ctxSlice && String(ctxSlice).trim()
    ? `# Carried context (honor these decisions/conventions)\n${ctxBlock(ctxSlice)}\n\n`
    : "";
  return `# Task
${task}

# Specification (from the orchestrator/designer)
${JSON.stringify(spec ?? {}, null, 2)}

${ctxBlk}Implement this by editing files in the repository directly. Satisfy EVERY acceptance criterion.
For any UI work, use the design-system token names called out in the spec — never hardcode a color or dp value that a
token covers. Respect the constraints and out_of_scope. Make minimal, focused changes and keep the project building. Then stop.`;
}

/* Iteration 2+ — retry message with reviewer feedback */
export function executorRetryMessage(spec, lastFinalVerdict, ctxSlice) {
  const v = lastFinalVerdict || {};
  const lines = [];

  const fb = typeof v.feedback_for_executor === "string" ? v.feedback_for_executor.trim() : "";
  if (fb) lines.push(fb);

  const blocking = Array.isArray(v.blocking_issues) ? v.blocking_issues : [];
  for (const b of blocking) if (b) lines.push(`- [BLOCKING] ${b}`);

  const dsv = Array.isArray(v.design_system_violations) ? v.design_system_violations : [];
  for (const d of dsv) {
    if (!d) continue;
    const where = d.file ? `${d.file}${d.line != null ? ":" + d.line : ""}` : "";
    const want = d.expected ? ` -> use ${d.expected}` : "";
    lines.push(`- [DESIGN/${where || "?"}] ${d.issue || ""}${want}`);
  }

  const a11y = Array.isArray(v.a11y_findings) ? v.a11y_findings : [];
  for (const a of a11y) {
    if (!a) continue;
    const ref = a.wcag ? `/${a.wcag}` : "";
    const fix = a.fix ? ` (fix: ${a.fix})` : "";
    lines.push(`- [A11Y${ref}] ${a.issue || ""}${fix}`);
  }

  const crit = Array.isArray(v.criteria_check) ? v.criteria_check : [];
  const unmet = crit.filter((c) => c && c.met === false);
  if (unmet.length) {
    lines.push("Still-unmet acceptance criteria:");
    for (const c of unmet) lines.push(`- [UNMET] ${c.criterion || ""}${c.note ? " — " + c.note : ""}`);
  }

  const s = spec || {};
  const oos = Array.isArray(s.out_of_scope) ? s.out_of_scope.filter(Boolean) : [];
  const cons = Array.isArray(s.constraints) ? s.constraints.filter(Boolean) : [];
  if (cons.length) {
    lines.push("Re-pinned constraints (do not regress):");
    for (const c of cons) lines.push(`- ${c}`);
  }
  if (oos.length) {
    lines.push("Out of scope (do not touch):");
    for (const o of oos) lines.push(`- ${o}`);
  }

  const ctxBlk = ctxSlice && String(ctxSlice).trim()
    ? `\n\n# Carried context\n${ctxBlock(ctxSlice)}`
    : "";

  const body = lines.length ? lines.join("\n") : "Re-read the spec and address the reviewer's concerns precisely.";

  return `Previous attempt was REJECTED. Apply these fixes precisely, then stop.

${body}${ctxBlk}`;
}
