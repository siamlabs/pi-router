/**
 * pi-router — Automatic model routing for Pi
 *
 * Exposes three routing modes through Pi's existing `/model` selector:
 *
 *   AUTO   -> Pi decides between LOCAL and ASTRA, per turn, based on the task
 *   LOCAL  -> force provider=local  model=model  (llama.cpp @ 127.0.0.1:1234/v1)
 *   ASTRA  -> force provider=openai model=gpt-6-astra
 *
 * Routing happens entirely at the Pi extension layer. Pi's `/model` selector is
 * never replaced or hidden. AUTO is represented as a *virtual* model registered
 * through the supported `registerProvider()` API so that it shows up as a normal
 * entry in the existing selector (sorted first, because "auto-router" sorts
 * before "local"/"openai"). Selecting AUTO, LOCAL or ASTRA in the selector, or
 * via the `/auto` `/local` `/astra` slash commands, drives the same state.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  ModelSelectEvent,
  TurnEndEvent,
  TurnStartEvent,
  InputEvent,
  AgentMessage,
} from "@earendil-works/pi-coding-agent";
import {
  buildRoutingSnapshot,
  policyEngine,
  getVonDecision,
  getVonConfig,
  setVonConfigForTests,
  loadVonConfig,
} from "./von.ts";

/* =========================================================
   CONSTANTS
========================================================= */

const PROVIDER_LOCAL = "local";
const MODEL_LOCAL = "model";
const PROVIDER_ASTRA = "openai";
const MODEL_ASTRA = "gpt-6-astra";

// Virtual provider/model that stands in for the AUTO option inside the selector.
const PROVIDER_AUTO = "auto-router";
const MODEL_AUTO = "auto-router";

// Custom-entry types persisted into the session file (not sent to the LLM).
const STATE_CUSTOM_TYPE = "router-state";
const DISPLAY_CUSTOM_TYPE = "router-status";

type Mode = "auto" | "local" | "astra";
type Target = "local" | "astra" | null;

interface RouterState {
  mode: Mode;
  currentTarget: Target;
  consecutiveFailures: number;
  totalDecisions: number;
  totalSwitches: number;
  totalFailures: number;
  lastFailure: string;
  lastDecision: string;
  lastDecisionReason: string;
  history: Array<{ ts: string; from: Target; to: Target; reason: string }>;
  // ---- Routing-snapshot fields (used to build the compact Von request) ----
  // These are derived from, and augment, the deterministic state above; they do
  // NOT replace it. Every field has a safe default so an absent value never
  // breaks routing.
  attempts: number; // model-generation attempts in the current phase
  toolErrors: number; // repeated tool errors so far
  testFailures: number; // persistent test failures so far
  filesChanged: number; // files written in the current phase
  securitySensitive: boolean; // security-sensitive work detected
  lastDecisionReasonVon: string; // last Von/policy rationale (status line)
}

const DEFAULT_STATE: RouterState = {
  mode: "auto",
  currentTarget: null,
  consecutiveFailures: 0,
  totalDecisions: 0,
  totalSwitches: 0,
  totalFailures: 0,
  lastFailure: "",
  lastDecision: "",
  lastDecisionReason: "",
  history: [],
  attempts: 0,
  toolErrors: 0,
  testFailures: 0,
  filesChanged: 0,
  securitySensitive: false,
  lastDecisionReasonVon: "",
};

/* =========================================================
   PATHS
========================================================= */

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

/* =========================================================
   VON (AUTO mode only)
========================================================= */

// Von is an independent local HTTP service. pi-router is only its client.
// Configuration comes from the router's normal config mechanism (compiled-in
// defaults, overridable by von.config.json). Von is DISABLED by default, so the
// existing deterministic policy is unchanged until it is explicitly enabled —
// this keeps manual LOCAL/ASTRA and the fallback behavior safe out of the box.
if (loadVonConfig().enabled) {
  // Enable at import time only if the config explicitly turned it on. This pins
  // the live config in the von module so the router and the von adapter agree.
  setVonConfigForTests(loadVonConfig());
}

// Signature of the routing state last sent to Von (gating). Von is only called
// when the routing state has *materially* changed since the last evaluation.
let routingSignatureCache = "";
// The last target Von (via the policy engine) resolved to, so an unchanged
// signature can reuse the decision instead of re-calling Von.
let lastVonTarget: Target = null;

/* =========================================================
   STATE
========================================================= */

// In-memory state is the source of truth for the live session.
let state: RouterState = { ...DEFAULT_STATE };
// Guards against re-entrancy: when we programmatically switch the model via
// setModel(), Pi emits a "set" model_select that we must not treat as a manual
// user selection.
let applyingRouterModel = false;
// Whether the AUTO target has already been decided for the current turn. Reset
// at turn_start so each new turn re-decides. currentTarget itself persists
// across turns and is used as the escalation baseline.
let decidedThisTurn = false;
// Captured task text, used to drive AUTO decisions at the turn boundary when
// the input event fired while the agent was busy (so we cannot switch then).
let pendingInputText = "";

function cloneState(): RouterState {
  return {
    ...state,
    history: state.history.map((h) => ({ ...h })),
  };
}

function persistState(): void {
  try {
    // appendEntry writes a custom entry into the session file so routing state
    // survives compaction/rollback. It is never sent to the LLM.
    (pi as unknown as {
      appendEntry: (customType: string, data?: unknown) => void;
    }).appendEntry(STATE_CUSTOM_TYPE, cloneState());
  } catch {
    /* non-critical */
  }
}

function recordSwitch(from: Target, to: Target, reason: string): void {
  const ts = new Date().toISOString();
  state.totalSwitches += 1;
  state.history.push({ ts, from, to, reason });
  if (state.history.length > 50) state.history.shift();
  persistState();
}

/* =========================================================
   PROVIDER / MODEL LOOKUPS
========================================================= */

// Resolve the FULLY-CONFIGURED model from Pi's registry so that `api`,
// `baseUrl`, headers, and every other piece of provider configuration are
// preserved when passed to `pi.setModel()`.
//
// WHY THIS MATTERS: `pi.setModel(model)` stores the passed object *verbatim*
// as `agent.state.model`. If we pass a bare `{ provider, id }` reference, its
// `api` field is `undefined`, so the subsequent provider request resolves with
// `api: undefined` -> "No API provider registered for api: undefined".
//
// The normal Pi `/model` selector works with `local/model` precisely because it
// passes the *fully-resolved* registry model (which always carries an `api`).
// `ctx.modelRegistry.find(provider, id)` is the supported lookup that returns a
// complete `Model`, so we use it instead of constructing a minimal reference.
function targetModel(ctx: ExtensionContext, target: Target): ReturnType<
  typeof ctx.modelRegistry.find
> {
  const provider = target === "astra" ? PROVIDER_ASTRA : PROVIDER_LOCAL;
  const id = target === "astra" ? MODEL_ASTRA : MODEL_LOCAL;

  const resolved = ctx.modelRegistry.find(provider, id);
  if (resolved) return resolved;

  // Fallback: minimal reference; setModel's own auth validation will fail
  // loudly with "No API key" rather than silently producing `api: undefined`.
  return { provider, id } as unknown as ReturnType<typeof ctx.modelRegistry.find>;
}

// Whether a target provider is configured with auth (so setModel won't throw
// "No API key"). Defensive: if the registry API is unavailable, assume it is
// configured and let setModel's own validation decide.
function isTargetAvailable(ctx: ExtensionContext, target: Target): boolean {
  try {
    const reg = (ctx as unknown as {
      modelRegistry?: { hasConfiguredAuth?: (m: { provider: string }) => boolean };
    }).modelRegistry;
    if (reg?.hasConfiguredAuth) {
      return reg.hasConfiguredAuth(targetModel(ctx, target));
    }
  } catch {
    /* fall through */
  }
  return true;
}

/* =========================================================
   TASK CLASSIFICATION (AUTO policy)
========================================================= */

// Signals that the task is a deep, cross-cutting "thinking" concern that the
// local model is typically weaker at, and that a remote reasoning model handles
// better.
const ARCHITECTURE_HINTS = [
  "architecture",
  "architect",
  "design",
  "designs",
  "refactor",
  "scal",
  "performance",
  "trade",
  "tradeoff",
  "tradeoffs",
  "pattern",
  "patterns",
  "system design",
  "data model",
  "schema",
  "overview",
  "high-level",
  "high level",
  "roadmap",
  "plan the",
  "how should we",
  "evaluate",
  "compare",
];

// Signals that the task is a concrete, self-contained implementation step that
// the local model is typically good at.
const IMPLEMENTATION_HINTS = [
  "implement",
  "write a ",
  "write the ",
  "fix ",
  "add a ",
  "add the ",
  "build a ",
  "build the ",
  "test",
  "tests",
  "bug",
  "bugs",
  "run the",
  "run a ",
  "execute",
  "small",
  "quick",
  "update the ",
  "update a ",
];

// Failure-classification hints for the routing snapshot. Used only to populate
// the diagnostic counters (testFailures / toolErrors) sent to Von; they do not
// affect the deterministic escalation path.
const TEST_FAILURE_HINTS = [
  "test",
  "tests",
  "failing",
  "assertion",
  "assert failed",
  "expected",
  "snapshot mismatch",
  "jest",
  "vitest",
  "pytest",
];
const TOOL_ERROR_HINTS = [
  "tool",
  "tool_error",
  "tool call",
  "tool call failed",
  "function call",
  "tool execution",
];

function classifyTask(text: string): {
  score: number;
  architecture: number;
  implementation: number;
} {
  const lower = ` ${text.toLowerCase()} `;
  let architecture = 0;
  let implementation = 0;
  for (const h of ARCHITECTURE_HINTS) if (lower.includes(` ${h} `)) architecture += 1;
  for (const h of IMPLEMENTATION_HINTS) if (lower.includes(` ${h} `)) implementation += 1;
  return { score: architecture - implementation, architecture, implementation };
}

/**
 * AUTO policy: pick the target model for this turn.
 *
 * 1. Escalate once `consecutiveFailures` reaches the threshold (3): switch away
 *    from the model that just failed. The counter is only reset here (after an
 *    escalation switch) and on a successful turn in `handleTurnEnd` — it is
 *    deliberately NOT reset by `applyTarget`, so it survives the per-turn
 *    decide/switch and can actually reach the threshold.
 * 2. Otherwise classify the incoming task text and route accordingly.
 * 3. Ties / no signal fall back to the previous target, else local.
 *
 * Precedence with Von: deterministic escalation (1) overrides Von; Von (2) is
 * the semantic signal for AUTO and is optional — any Von failure falls through
 * to keyword classify (3).
 */
async function decideTarget(
  text: string,
  prevTarget: Target
): Promise<{ target: Target; reason: string }> {
  // 1. Deterministic hard escalation — overrides Von when the existing policy
  //    clearly indicates escalation.
  if (state.consecutiveFailures >= 3) {
    const next =
      prevTarget === "local"
        ? "astra"
        : prevTarget === "astra"
          ? "local"
          : "local";
    const failures = state.consecutiveFailures;
    state.consecutiveFailures = 0;
    return {
      target: next,
      reason: `escalated after ${failures} consecutive failures`,
    };
  }

  // 2. Von (AUTO only). Optional; returns null on any failure so we fall through.
  const vonResult = await vonDecision(text);
  if (vonResult) return vonResult;

  // 3. Keyword classify (existing policy, unchanged).
  const { score } = classifyTask(text);
  if (score >= 1) return { target: "astra", reason: "architecture/design signals" };
  if (score <= -1) return { target: "local", reason: "implementation signals" };
  if (prevTarget) return { target: prevTarget, reason: "no signal; kept prior target" };
  return { target: "local", reason: "no signal; default local" };
}

/* =========================================================
   VON (AUTO only) — evaluation-point gating + policy
========================================================= */

// Security-sensitive keywords. When present in the task we flag it so Von sees a
// strong escalation signal. Derived from the task text (no second state system).
const SECURITY_HINTS = [
  "security",
  "vuln",
  "vulnerability",
  "auth",
  "authorization",
  "permission",
  "privilege",
  "crypto",
  "cryptography",
  "cve",
  "exploit",
  "injection",
  "sandbox",
  "isolation",
];

function isSecuritySensitive(text: string): boolean {
  const lower = ` ${text.toLowerCase()} `;
  return SECURITY_HINTS.some((h) => lower.includes(` ${h} `));
}

/**
 * Gating signature: the routing INPUT signals that matter for deciding whether
 * Von should be re-evaluated. The current model (currentTarget) is deliberately
 * excluded — it is the OUTPUT of routing, not an independent signal, so its
 * change must not itself force a fresh Von call. The truncated task is included
 * so re-evaluating the same task with unchanged state reuses the decision.
 */
function routingSignature(task: string): string {
  return [
    isSecuritySensitive(task) ? "sec" : "",
    state.consecutiveFailures, // failure streak flips phase -> material change
    state.toolErrors,
    state.testFailures,
    state.filesChanged,
    (task || "").trim().toLowerCase().slice(0, 200),
  ].join("|");
}

/**
 * The Von evaluation point. Called from decideTarget for AUTO only.
 *
 *   - Von disabled  -> null (pure fallback to keyword policy).
 *   - Routing state unchanged since last evaluation -> reuse last target.
 *   - Otherwise -> call Von, apply the policy engine, return a target.
 *
 * Returns null whenever Von cannot produce a decision (disabled, unavailable,
 * malformed) so decideTarget falls through to the existing keyword policy.
 */
async function vonDecision(text: string): Promise<{ target: Target; reason: string } | null> {
  if (!getVonConfig().enabled) return null;

  const sig = routingSignature(text);
  if (sig !== routingSignatureCache) {
    routingSignatureCache = sig;
    return evaluateVon(text);
  }
  // No material change since the last evaluation -> reuse the last decision.
  if (lastVonTarget) {
    return {
      target: lastVonTarget,
      reason: state.lastDecisionReasonVon || "von: reused decision (routing state unchanged)",
    };
  }
  return null;
}

/**
 * Build the compact snapshot, call Von, and apply the local-first policy. Any
 * failure yields null so the router falls back to the keyword policy.
 */
async function evaluateVon(text: string): Promise<{ target: Target; reason: string } | null> {
  try {
    // Flag security-sensitive work so Von sees it as a strong escalation signal.
    if (isSecuritySensitive(text)) state.securitySensitive = true;

    const snapshot = buildRoutingSnapshot(
      {
        consecutiveFailures: state.consecutiveFailures,
        attempts: state.attempts,
        toolErrors: state.toolErrors,
        testFailures: state.testFailures,
        filesChanged: state.filesChanged,
        securitySensitive: state.securitySensitive,
        currentTarget: state.currentTarget,
      },
      text
    );

    const von = await getVonDecision(snapshot);
    if (von === null) return null; // unavailable / malformed -> keyword fallback

    const outcome = policyEngine(von, {
      clearAstraThreshold: getVonConfig().clearAstraThreshold,
    });
    state.lastDecisionReasonVon = outcome.reason;
    lastVonTarget = outcome.decision === "ASTRA" ? "astra" : "local";
    return { target: lastVonTarget, reason: outcome.reason };
  } catch {
    // Von must never crash Pi.
    return null;
  }
}

/* =========================================================
   ROUTING ACTIONS
========================================================= */

function setMode(mode: Mode): void {
  const was = state.mode;
  state.mode = mode;
  if (mode === "auto") state.currentTarget = null;
  state.lastDecisionReason = `mode set to ${mode}`;
  if (was !== mode) persistState();
}

/**
 * Apply a routing decision by switching the active model through Pi's own
 * setModel(). We await the switch and only commit the routing state after it
 * completes successfully, so a failed switch is never reported as a success.
 * The resulting "set" model_select event is ignored via the applyingRouterModel
 * guard.
 */
async function applyTarget(
  ctx: ExtensionContext,
  target: Target,
  reason: string
): Promise<void> {
  if (!target) return;

  applyingRouterModel = true;
  const prev = state.currentTarget;
  try {
    await (pi as unknown as {
      setModel: (m: unknown) => Promise<boolean>;
    }).setModel(targetModel(ctx, target));
  } catch (err) {
    // On failure, do not pretend the switch succeeded: record the failure
    // reason and leave state.currentTarget pointing at the still-active model.
    state.lastDecisionReason = `cannot switch to ${target}: provider not configured`;
    state.lastFailure = (err as Error)?.message || "setModel failed";
    persistState();
    return;
  } finally {
    // Always release the guard once setModel() has settled.
    applyingRouterModel = false;
  }

  // Only reached on successful completion.
  state.currentTarget = target;
  state.lastDecision = target;
  state.lastDecisionReason = reason;
  state.totalDecisions += 1;
  recordSwitch(prev, target, reason);
  persistState();
}

/* =========================================================
   SESSION-FILE STATE RESTORE
========================================================= */

function restoreStateFromSession(ctx: ExtensionContext): void {
  try {
    // `ctx.sessionManager.getSessionDir()` is the supported (typed) way to reach
    // the session directory; `ctx.sessionDir` is not exposed on the type.
    const dir = ctx.sessionManager.getSessionDir();
    if (!dir || !existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    let restored: RouterState | null = null;
    for (const file of files) {
      const lines = readFileSync(join(dir, file), "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line);
        if (entry?.type === "custom" && entry?.customType === STATE_CUSTOM_TYPE) {
          restored = entry.data;
        }
      }
    }
    if (restored && typeof restored.mode === "string") {
      state = { ...DEFAULT_STATE, ...restored };
    }
  } catch {
    /* start from defaults */
  }
}

/* =========================================================
   STATUS DISPLAY
========================================================= */

function describeTarget(t: Target): string {
  return t === "local" ? "LOCAL" : t === "astra" ? "ASTRA" : "—";
}

function buildStatusLine(): string {
  const mode = state.mode.toUpperCase();
  const target = describeTarget(state.currentTarget);
  return (
    `Router: **${mode}** → ${target}  ` +
    `(decisions ${state.totalDecisions}, switches ${state.totalSwitches}, ` +
    `failures ${state.totalFailures}, last: ${state.lastDecision || "none"} ` +
    `${state.lastDecisionReason || ""}` +
    (state.lastFailure ? ` | last-failure: ${state.lastFailure}` : "") +
    `)`
  );
}

function showStatus(ctx: ExtensionContext): void {
  try {
    (pi as unknown as {
      sendMessage: (msg: unknown) => void;
    }).sendMessage({
      customType: DISPLAY_CUSTOM_TYPE,
      content: buildStatusLine(),
      display: true,
      details: cloneState(),
    });
  } catch {
    /* non-critical */
  }
}

/* =========================================================
   EVENT HANDLERS
========================================================= */

// User (or command) selected a model from the selector.
function handleModelSelect(event: ModelSelectEvent, ctx: ExtensionContext): void {
  const { model } = event;

  // Ignore switches we initiated ourselves.
  if (applyingRouterModel) return;

  // AUTO chosen in the selector.
  if (model.provider === PROVIDER_AUTO && model.id === MODEL_AUTO) {
    setMode("auto");
    state.lastDecisionReason = "user selected AUTO";
    persistState();
    // Decide + switch on the next turn boundary instead of interrupting the
    // selector flow.
    return;
  }

  // Explicit LOCAL force.
  if (model.provider === PROVIDER_LOCAL && model.id === MODEL_LOCAL) {
    setMode("local");
    state.currentTarget = "local";
    state.lastDecision = "local";
    state.lastDecisionReason = "user forced LOCAL";
    persistState();
    return;
  }

  // Explicit ASTRA force.
  if (model.provider === PROVIDER_ASTRA && model.id === MODEL_ASTRA) {
    setMode("astra");
    state.currentTarget = "astra";
    state.lastDecision = "astra";
    state.lastDecisionReason = "user forced ASTRA";
    persistState();
    return;
  }

  // Any other manual selection: leave routing untouched.
}

// Turn boundary: reset the per-turn decision flag so the next input re-decides,
// and drive the decision if the input event fired while the agent was busy
// (so the switch lands before the first provider request of the turn).
async function handleTurnStart(_event: TurnStartEvent, ctx: ExtensionContext): Promise<void> {
  decidedThisTurn = false;
  // New turn boundary => a fresh model-generation attempt (routing snapshot signal).
  state.attempts += 1;
  if (state.mode !== "auto") return;
  if (decidedThisTurn) return;
  if (!pendingInputText && state.currentTarget) return; // already decided
  // Von is async, so await the decision before committing the switch.
  const { target, reason } = await decideTarget(pendingInputText, state.currentTarget);
  pendingInputText = "";
  decidedThisTurn = true;
  void applyTarget(ctx, target, reason);
}

// User submitted input. This is where we have the task text, so for AUTO mode
// we decide + switch here if the agent is idle (so the switch is not torn down
// mid-stream).
async function handleInput(event: InputEvent, ctx: ExtensionContext): Promise<void> {
  if (state.mode !== "auto") return;
  if (decidedThisTurn) return; // already decided for this turn

  if (ctx.isIdle()) {
    // Von is async, so await the decision before committing the switch.
    const { target, reason } = await decideTarget(event.text || "", state.currentTarget);
    decidedThisTurn = true;
    void applyTarget(ctx, target, reason);
  } else {
    // Agent is busy: defer the decision to the next turn boundary.
    pendingInputText = event.text || "";
  }
}

// Per-turn outcome tracking for escalation.
//
// `turn_end` fires on EVERY turn — success and failure alike — carrying the
// final assistant message. On a provider/request failure (e.g. "no credits
// remaining" -> HTTP 402) the OpenAI SDK throws before any tool runs, so the
// tool_execution_end event never fires and the failure would otherwise go
// completely undetected. Inspecting `message.stopReason` here catches both
// provider failures AND tool errors from a single, reliable event.
function handleTurnEnd(event: TurnEndEvent): void {
  const msg = event?.message;
  // Only a real "error" counts toward escalation. An aborted turn (user
  // cancels) is not a provider failure and must not escalate the router.
  if (msg && msg.stopReason === "error") {
    // A context-window overflow (e.g. local llama.cpp: "68820 tokens exceeds
    // the available context size 65536") is NOT a routing failure — it is a
    // property of the current conversation, not the provider. It is therefore
    // neutral for escalation: it neither advances the failure streak nor
    // resets it. Escalating away would just move the same oversized context to
    // another model, so we let the turn simply not count.
    if (isContextWindowError(msg)) return;

    state.totalFailures += 1;
    state.consecutiveFailures += 1;
    state.lastFailure = msg.errorMessage || `${msg.stopReason} during turn`;
    // Classify the failure into the routing-snapshot counters. These are
    // diagnostic signals for Von; they never change the deterministic escalation
    // path above. A persistent test failure and a repeated tool error are both
    // "the model is misbehaving" signals, but they are tracked separately so Von
    // can react to them distinctly.
    const why = (msg.errorMessage || msg.stopReason || "").toLowerCase();
    if (TEST_FAILURE_HINTS.some((h) => why.includes(h))) {
      state.testFailures += 1;
    }
    if (TOOL_ERROR_HINTS.some((h) => why.includes(h))) {
      state.toolErrors += 1;
    }
    persistState();
  } else if (state.consecutiveFailures > 0) {
    // A successful turn resets the failure streak regardless of mode.
    state.consecutiveFailures = 0;
    persistState();
  }
}

// Context-window overflow detection.
//
// Local llama.cpp reports an oversized conversation as an "error" stopReason
// with a message like:
//   "400 request (68820 tokens) exceeds the available context size (65536 tokens)"
// We match a small set of case-insensitive substrings so such an error is not
// mistaken for a provider/credit failure.
function isContextWindowError(msg: AgentMessage): boolean {
  const text = (msg.errorMessage || msg.stopReason || "").toLowerCase();
  return (
    text.includes("context size") ||
    text.includes("context window") ||
    text.includes("context length") ||
    text.includes("exceeds the available context") ||
    text.includes("maximum context") ||
    text.includes("too many tokens") ||
    text.includes("token limit")
  );
}

// Session start: restore persisted routing state.
function handleSessionStart(event: { reason: string }, ctx: ExtensionContext): void {
  restoreStateFromSession(ctx);
  showStatus(ctx);
}

/* =========================================================
   SLASH COMMANDS
========================================================= */

function registerCommands(): void {
  pi.registerCommand("auto", {
    description: "Enable automatic model routing (Pi chooses LOCAL vs ASTRA)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      setMode("auto");
      state.lastDecisionReason = "command /auto";
      persistState();
      showStatus(ctx);
    },
  });

  pi.registerCommand("local", {
    description: "Force LOCAL model (llama.cpp) and disable auto-routing",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      if (!isTargetAvailable(ctx, "local")) {
        (pi as unknown as {
          sendMessage: (msg: unknown) => void;
        }).sendMessage({
          customType: DISPLAY_CUSTOM_TYPE,
          content: "LOCAL provider/model not found in the model registry.",
          display: true,
        });
        return;
      }
      setMode("local");
      // Await the switch so we can report a failed switch before committing.
      await applyTarget(ctx, "local", "command /local");
      // If the switch failed, applyTarget recorded the failure reason; surface
      // it so the user knows the model did not actually change.
      if (state.lastDecisionReason.startsWith("cannot switch to LOCAL")) {
        (pi as unknown as {
          sendMessage: (msg: unknown) => void;
        }).sendMessage({
          customType: DISPLAY_CUSTOM_TYPE,
          content: state.lastDecisionReason,
          display: true,
        });
        return;
      }
      persistState();
      showStatus(ctx);
    },
  });

  pi.registerCommand("astra", {
    description: "Force ASTRA model (openai gpt-6-astra) and disable auto-routing",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      if (!isTargetAvailable(ctx, "astra")) {
        (pi as unknown as {
          sendMessage: (msg: unknown) => void;
        }).sendMessage({
          customType: DISPLAY_CUSTOM_TYPE,
          content: "ASTRA provider/model not found in the model registry.",
          display: true,
        });
        return;
      }
      setMode("astra");
      // Await the switch so we can report a failed switch before committing.
      await applyTarget(ctx, "astra", "command /astra");
      // If the switch failed, applyTarget recorded the failure reason; surface
      // it so the user knows the model did not actually change.
      if (state.lastDecisionReason.startsWith("cannot switch to ASTRA")) {
        (pi as unknown as {
          sendMessage: (msg: unknown) => void;
        }).sendMessage({
          customType: DISPLAY_CUSTOM_TYPE,
          content: state.lastDecisionReason,
          display: true,
        });
        return;
      }
      persistState();
      showStatus(ctx);
    },
  });

  pi.registerCommand("router", {
    description: "Show the current router state and last decision",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      showStatus(ctx);
    },
  });
}

/* =========================================================
   EXTENSION ENTRY POINT
========================================================= */

// The `pi` reference is captured here so handlers and commands can call action
// methods (setModel, sendMessage, appendEntry). It is only valid after the
// runner binds its context, which happens during factory execution.
let pi: ExtensionAPI;

export default function (extensionPi: ExtensionAPI): void {
  pi = extensionPi;

  // Register the virtual AUTO model so it appears in Pi's existing /model
  // selector. `registerProvider` is queued at load and flushed once the model
  // registry is available, so this is safe without a /reload.
  //
  // The model is inert: every selector interaction with it is intercepted by
  // handleModelSelect and never results in a real provider request.
  try {
    pi.registerProvider(PROVIDER_AUTO, {
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-completions" as const,
      apiKey: "auto-router",
      models: [
        {
          id: MODEL_AUTO,
          name: "AUTO",
        },
      ],
    });
  } catch {
    /* provider may already be registered */
  }

  pi.on("model_select", handleModelSelect);
  pi.on("turn_start", handleTurnStart);
  pi.on("turn_end", handleTurnEnd);
  pi.on("session_start", handleSessionStart);
  pi.on("input", handleInput);

  registerCommands();
}
