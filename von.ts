/**
 * pi-router — Von routing adapter (AUTO mode only)
 *
 * This module is the ONLY place in pi-router that knows about Von. It is a thin,
 * isolated boundary:
 *
 *   buildRoutingSnapshot()  — turn existing router state into a compact request
 *   VonClient               — build request, send localhost HTTP, parse + normalize,
 *                             handle timeout/errors (returns null on ANY failure)
 *   policyEngine()          — local-first, escalation-only policy over Von's output
 *   config                  — Von URL + thresholds, read through the router's config
 *
 * Von is an INDEPENDENT local service (started by an external BAT launcher,
 * outside pi-router). pi-router is merely its HTTP client. Von is OPTIONAL: if it
 * is offline, unreachable, slow, or returns malformed data, the router falls back
 * to its existing deterministic + keyword policy. Von never crashes Pi and never
 * affects manual LOCAL/ASTRA.
 */

import { readFileSync } from "node:fs";

/* =========================================================
   TYPES
========================================================= */

export type VonChoice = "LOCAL" | "ASTRA";

/** Normalized routing data returned by the Von adapter. */
export interface VonDecision {
  choice: VonChoice;
  probabilities: {
    LOCAL: number;
    ASTRA: number;
  };
  confidence: number;
}

/** Result of applying the policy engine to Von's decision. */
export type PolicyOutcome = {
  /** FINAL routing target. `uncertain` is a sentinel the caller maps to LOCAL. */
  decision: VonChoice | "uncertain";
  /** Human-readable rationale (surfaced in the status line for transparency). */
  reason: string;
  /** The raw Von decision, preserved for the status line / diagnostics. */
  von: VonDecision | null;
};

/**
 * Compact, routing-relevant snapshot of the current router state. This is the
 * ONLY thing sent to Von — never the full conversation/history.
 */
export interface RoutingSnapshot {
  task: string;
  phase: "normal" | "debugging";
  attempts: number;
  toolErrors: number;
  testFailures: number;
  filesChanged: number;
  securitySensitive: boolean;
  currentModel: VonChoice | null;
}

/* =========================================================
   CONFIG (router's normal config mechanism)
========================================================= */

/**
 * Centralized Von configuration. The Von server URL defaults to the standard
 * local endpoint so the normal local setup requires NO manual configuration.
 * Values can be overridden by `von.config.json` (see README / VON_INTEGRATION).
 */
export interface VonConfig {
  /** Von server base URL (e.g. http://127.0.0.1:8100). */
  url: string;
  /** Whether Von integration is enabled at all (safe default: off). */
  enabled: boolean;
  /** Short localhost timeout so a dead Von server cannot stall the agent. */
  timeoutMs: number;
  /**
   * Von System One decision model id (e.g. `von-latest`). The local Von server
   * resolves model names to a concrete engine; this is only the request hint.
   */
  model: string;
  /**
   * Probability (0..1) at which Von's ASTRA signal is considered "clear" and
   * overrides the local-first policy. Conservative by design — uncertainty and
   * borderline results default to LOCAL. Tune after real-world testing.
   */
  clearAstraThreshold: number;
  /**
   * Evaluation criteria keyed by option name, sent as the System One question's
   * `criteria`. Operators can retune the engine's LOCAL/ASTRA bias here without
   * changing code. Defaults to the terse option-name values.
   */
  criteria: Record<VonChoice, string>;
}

export const DEFAULT_VON_CONFIG: VonConfig = {
  url: "http://127.0.0.1:8100",
  enabled: false,
  timeoutMs: 800,
  model: "von-latest",
  // Conservative: ASTRA must be clearly indicated before overriding LOCAL.
  // The local Von engine's answer probabilities cluster near 0.55-0.73 for a
  // discriminating task, so this is set to just-above half: the *dominant* class
  // (LOCAL or ASTRA) is treated as a clear signal. This keeps the escalation-only
  // policy intact (uncertainty still defaults to LOCAL) while letting the real
  // engine's ASTRA signal through when it is genuinely dominant.
  clearAstraThreshold: 0.65,
  criteria: { LOCAL: "LOCAL", ASTRA: "ASTRA" },
};

/* =========================================================
   ROUTING INSTRUCTION (centralized, configurable)
========================================================= */

/**
 * The routing instruction sent to Von. Centralized here so it lives in exactly
 * one place (not scattered across the codebase) and is easy to retune.
 */
export const ROUTING_INSTRUCTION =
  "You are a model-routing decision system. Choose LOCAL for routine, well-defined implementation tasks that can be completed with ordinary coding, straightforward tool use, or existing patterns. Choose ASTRA only when the task requires substantially deeper reasoning, difficult architecture or design decisions, security-sensitive analysis, ambiguous requirements that require expert judgment, repeated implementation failures, persistent test failures, repeated tool errors, or diagnosis of a problem that the local coding model has been unable to solve. Do not choose ASTRA merely because a task involves coding, multiple files, or normal debugging. Prefer LOCAL whenever the task is straightforward and the available evidence does not clearly justify escalation.";

/**
 * The question key inside the System One `questions` envelope. Fixed value so the
 * request builder and the response extractor agree on which answer to read.
 */
export const ROUTING_QUESTION_KEY = "routing";

/**
 * Evaluation criteria keyed by the OPTION NAME.
 *
 * Von's System One engine keys `criteria` by the option it will emit a `choice`
 * for; keys that are not option names produce a malformed `choice` (the router
 * rejects it and falls back). The values are kept intentionally terse and
 * NEUTRAL: the engine weights criterion text, so verbose descriptions bias the
 * answer, whereas terse option-name values yield the most discriminating
 * (least-biased) decisions.
 */
export const ROUTING_CRITERIA: Record<VonChoice, string> = {
  LOCAL: "LOCAL",
  ASTRA: "ASTRA",
};

/* =========================================================
   SNAPSHOT BUILDER
========================================================= */

/**
 * Derive the compact routing snapshot from the existing router state. The fields
 * are read from pi-router's own state — no second independent state system.
 */
export function buildRoutingSnapshot(
  s: {
    task?: string;
    attempts?: number;
    toolErrors?: number;
    testFailures?: number;
    filesChanged?: number;
    securitySensitive?: boolean;
    consecutiveFailures?: number;
    currentTarget: "local" | "astra" | null;
  },
  taskText: string
): RoutingSnapshot {
  // `phase` is DERIVED from the existing deterministic failure state, so we never
  // maintain a second independent notion of "what phase we are in".
  const phase: "normal" | "debugging" = (s.consecutiveFailures ?? 0) > 0
    ? "debugging"
    : "normal";
  return {
    task: (taskText || s.task || "").trim().slice(0, 2000),
    phase,
    attempts: clampInt(s.attempts, 0),
    toolErrors: clampInt(s.toolErrors, 0),
    testFailures: clampInt(s.testFailures, 0),
    filesChanged: clampInt(s.filesChanged, 0),
    securitySensitive: Boolean(s.securitySensitive),
    currentModel:
      s.currentTarget === "astra"
        ? "ASTRA"
        : s.currentTarget === "local"
          ? "LOCAL"
          : null,
  };
}

function clampInt(n: number | undefined, def: number): number {
  return Number.isFinite(n as number) && (n as number) > 0 ? (n as number) : def;
}

/* =========================================================
   POLICY ENGINE (local-first, escalation-only)
========================================================= */

/**
 * Apply the local-first, escalation-only policy to Von's decision.
 *
 *   Von decision
 *        │
 *        ├── Clear ASTRA signal (ASTRA prob >= threshold & dominant) ──► ASTRA
 *        ├── Clear LOCAL signal (LOCAL prob dominant)                  ──► LOCAL
 *        └── Uncertain (below threshold / ambiguous)                   ──► LOCAL
 *
 * Uncertainty ALWAYS defaults to LOCAL. Clarity is judged from the probability
 * distribution, NOT from `confidence` (which is preserved but not decisive).
 */
export function policyEngine(
  von: VonDecision | null,
  config: Pick<VonConfig, "clearAstraThreshold">
): PolicyOutcome {
  if (!von) {
    return { decision: "uncertain", reason: "von unavailable; using deterministic policy", von: null };
  }

  const { choice, probabilities } = von;
  const { LOCAL: localP, ASTRA: astraP } = probabilities;

  // Judge clarity from the probability DISTRIBUTION, not the engine's `choice`
  // field. The local Von engine's `choice` is occasionally inconsistent with
  // its own probabilities (e.g. choice=ASTRA while ASTRA < LOCAL), so the
  // dominant class + its probability is the robust signal.
  const clearAstra = astraP >= config.clearAstraThreshold && astraP > localP;
  if (clearAstra) {
    return {
      decision: "ASTRA",
      reason: `von: ASTRA ${round2(astraP)} (clear ASTRA signal; choice=${choice})`,
      von,
    };
  }

  // Clear LOCAL signal: LOCAL is the dominant class.
  const clearLocal = localP > astraP;
  if (clearLocal) {
    return {
      decision: "LOCAL",
      reason: `von: LOCAL ${round2(localP)} (clear LOCAL signal; choice=${choice})`,
      von,
    };
  }

  // Uncertain → LOCAL.
  return {
    decision: "uncertain",
    reason: `von: uncertain (ASTRA ${round2(astraP)} vs ${round2(localP)}); defaulting LOCAL`,
    von,
  };
}

function round2(n: number): string {
  return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}

/* =========================================================
   VON HTTP ADAPTER
========================================================= */

/**
 * Isolated Von HTTP client. Responsibilities:
 *   - build the Von request
 *   - send the localhost HTTP request (with a short timeout)
 *   - parse + normalize the response
 *   - return null on ANY failure (offline, timeout, malformed, bad choice)
 *
 * It knows nothing about routing policy. Policy lives in `policyEngine()`.
 */
export class VonClient {
  constructor(
    private readonly config: Pick<VonConfig, "url" | "timeoutMs" | "model" | "criteria">,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async decide(snapshot: RoutingSnapshot): Promise<VonDecision | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      // System One request shape:
      //   { model, state, questions: { <key>: { instructions, criteria, options } } }
      const body = {
        model: this.config.model,
        state: snapshot,
        questions: {
          [ROUTING_QUESTION_KEY]: {
            instructions: ROUTING_INSTRUCTION,
            criteria: this.config.criteria,
            options: ["LOCAL", "ASTRA"],
          },
        },
      };

      const res = await this.fetchImpl(`${this.config.url}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) return null;

      const json = await res.json().catch(() => null);
      // The answer lives under `answers[<questionKey>]`; pull it out of the
      // envelope so normalizeVonDecision sees the inner ChoiceAnswer shape
      // ({ choice, probabilities, confidence }).
      return normalizeVonDecision(extractChoiceAnswer(json));
    } catch {
      // AbortError (timeout), network error, DNS failure, etc.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pull the per-question ChoiceAnswer out of the System One response envelope
 * `{ model, answers: { <key>: ChoiceAnswer }, usage }`.
 *
 * Returns the raw inner answer for `ROUTING_QUESTION_KEY`, or the input itself
 * if the envelope is absent (defensive: a flat `{ choice, ... }` object passes
 * straight through to normalizeVonDecision). Returns null when the routing
 * question's answer is missing so normalizeVonDecision rejects it.
 */
export function extractChoiceAnswer(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== "object") return envelope;
  const r = envelope as Record<string, unknown>;
  const answers = r.answers;
  if (!answers || typeof answers !== "object") return r; // flat shape
  const q = (answers as Record<string, unknown>)[ROUTING_QUESTION_KEY];
  return q ?? null;
}

/**
 * Validate + normalize a raw Von response into a VonDecision, or return null if
 * the shape is wrong. Defensive on every field so malformed data can never crash
 * the router.
 */
export function normalizeVonDecision(raw: unknown): VonDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const choice = r.choice;
  if (choice !== "LOCAL" && choice !== "ASTRA") return null;

  const probs = r.probabilities;
  if (!probs || typeof probs !== "object") return null;
  const p = probs as Record<string, unknown>;
  const localP = toProb("LOCAL", p.LOCAL);
  const astraP = toProb("ASTRA", p.ASTRA);
  if (localP === null || astraP === null) return null;

  const confidence = toConfidence(r.confidence);

  return { choice, probabilities: { LOCAL: localP, ASTRA: astraP }, confidence };
}

function toProb(label: string, v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.max(0, Math.min(1, v));
  return n;
}

function toConfidence(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/* =========================================================
   CONFIG LOADER (router's normal config mechanism)
========================================================= */

/**
 * Merge the compiled-in defaults with an optional `von.config.json` living next
 * to this module. Never throws: a missing or unreadable config file simply yields
 * the defaults. Personal/system-specific values must never be committed here.
 *
 * `overrides` lets callers (and tests) pin specific values without a config file.
 */
export function loadVonConfig(
  overrides: Partial<VonConfig> = {}
): VonConfig {
  const merged: VonConfig = { ...DEFAULT_VON_CONFIG, ...overrides };
  try {
    const file = new URL("./von.config.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(file.toString(), "utf-8"));
    if (parsed && typeof parsed === "object") {
      const c = parsed as Record<string, unknown>;
      if (typeof c.url === "string" && c.url.trim()) merged.url = c.url.trim();
      if (typeof c.enabled === "boolean") merged.enabled = c.enabled;
      if (typeof c.timeoutMs === "number" && c.timeoutMs > 0) merged.timeoutMs = c.timeoutMs;
      if (typeof c.clearAstraThreshold === "number") {
        merged.clearAstraThreshold = Math.max(0, Math.min(1, c.clearAstraThreshold));
      }
      if (typeof c.model === "string" && c.model.trim()) merged.model = c.model.trim();
      const crit = c.criteria;
      if (crit && typeof crit === "object") {
        const mergedCrit: Record<VonChoice, string> = {};
        for (const key of ["LOCAL", "ASTRA"] as const) {
          if (typeof crit[key] === "string" && crit[key].trim()) mergedCrit[key] = crit[key];
        }
        if (Object.keys(mergedCrit).length > 0) merged.criteria = mergedCrit;
      }
    }
  } catch {
    /* config file missing/unreadable -> keep defaults */
  }
  return merged;
}

/* =========================================================
   MODULE-LEVEL SEAM (config + client, injectable for tests)
========================================================= */

// The live, merged config. Initialized once at import from the router's config
// file; overridable in tests via setVonConfigForTests().
let currentConfig: VonConfig = loadVonConfig();

// Factory that produces a VonClient. The default uses the real global fetch and
// the live config; tests inject a factory that returns a fake client (so no real
// HTTP server is ever required).
type VonClientFactory = (config: VonConfig) => VonClient;
let vonClientFactory: VonClientFactory = (cfg) => new VonClient(cfg);

/** Pin a specific VonConfig (used by tests). */
export function setVonConfigForTests(cfg: VonConfig): void {
  currentConfig = cfg;
}

/** The live, merged config. The router reads the *enabled* flag from here so
 * there is a single source of truth (tests can flip it on). */
export function getVonConfig(): VonConfig {
  return currentConfig;
}

/** Restore the production config loader (used by tests). */
export function resetVonConfigForTests(): void {
  currentConfig = loadVonConfig();
}

/** Inject a custom VonClient factory (used by tests). */
export function setVonClientFactoryForTests(fn: VonClientFactory | null): void {
  vonClientFactory = fn ?? ((cfg) => new VonClient(cfg));
}

/**
 * The single entry point the router calls. Honors the `enabled` flag: when Von
 * integration is disabled this returns null (pure fallback). When enabled it
 * builds the snapshot, calls the (possibly injected) client, and normalizes.
 * Returns null on ANY failure so the router can fall back safely.
 */
export async function getVonDecision(
  snapshot: RoutingSnapshot
): Promise<VonDecision | null> {
  if (!currentConfig.enabled) return null;
  try {
    return await vonClientFactory(currentConfig).decide(snapshot);
  } catch {
    return null;
  }
}
