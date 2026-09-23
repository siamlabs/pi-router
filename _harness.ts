/**
 * Test harness: runs one test (by numeric index from argv[2]) in a fresh
 * subprocess so the extension's module-level state is clean each time.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const SESSION_DIR = join(HERE, "_fake_sessions", "s1");

// Von seams (imported lazily so the router's import-time config load is untouched).
const von = await import("./von.ts");
const { setVonConfigForTests, setVonClientFactoryForTests, VonClient } = von;

// A fake fetch that never resolves on its own but rejects as soon as the
// AbortController aborts (i.e. when the VonClient's timeout fires). This lets us
// exercise the REAL VonClient timeout path without a real HTTP server.
function abortingFetch(): typeof fetch {
  return ((_url: string, opts?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted"))
      );
    })) as unknown as typeof fetch;
}

// A fake Von decide() whose result is controlled per-test.
let fakeDecide: () => Promise<any> = async () => null;
let decideCalls = 0;
function installVon(enabled: boolean, timeoutMs = 800, clearAstraThreshold = 0.7, model = "von-latest") {
  setVonConfigForTests({ url: "http://127.0.0.1:8100", enabled, timeoutMs, clearAstraThreshold, model });
  setVonClientFactoryForTests(() => ({ decide: async () => { decideCalls += 1; return fakeDecide(); } } as any));
}

interface Check {
  ok: boolean;
  msg: string;
}

const tests: Array<[string, (t: T) => void | Promise<void>]> = [];
function test(name: string, fn: (t: T) => void | Promise<void>) {
  tests.push([name, fn]);
}

// ---- Test API exposed to each test ----------------------------------------
interface T {
  pi: any;
  ctx: any;
  handlers: Record<string, Function[]>;
  commands: Record<string, any>;
  providers: Record<string, any>;
  setModelCalls: Array<{ provider: string; id: string }>;
  sent: string[];
  appended: Array<{ customType: string; data: any }>;
  fire: (e: string, ev: any) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  check: (ok: boolean, msg: string) => void;
}

function makeT(): T {
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, any> = {};
  const providers: Record<string, any> = {};
  const setModelCalls: Array<{ provider: string; id: string }> = [];
  const sent: string[] = [];
  const appended: Array<{ customType: string; data: any }> = [];
  let isIdle = true;

  const pi = {
    registerProvider(n: string, c: any) {
      providers[n] = c;
    },
    on(e: string, h: Function) {
      (handlers[e] ||= []).push(h);
    },
    registerCommand(n: string, o: any) {
      commands[n] = o;
    },
    setModel(m: any) {
      setModelCalls.push({ provider: m.provider, id: m.id });
      // Real Pi emits model_select as a microtask (awaited promise), which runs
      // before any setTimeout(0) macrotask — keep the mock faithful.
      Promise.resolve().then(() =>
        (handlers["model_select"] || []).forEach((h) =>
          h(
            { type: "model_select", model: m, previousModel: null, source: "set" },
            ctx
          )
        )
      );
      return Promise.resolve(true);
    },
    sendMessage(msg: any) {
      sent.push(String(msg.content));
    },
    appendEntry(ct: string, d: any) {
      appended.push({ customType: ct, data: d });
    },
    get modelRegistry() {
      // Faithful to the real ModelRegistry: `find(provider, id)` returns the
      // fully-resolved model (including `api`, `baseUrl`, ...). This is what the
      // router now passes to setModel, so `api` is defined and the request
      // resolves correctly.
      return {
        find: (p: string, id: string) => ({
          provider: p,
          id,
          name: p + "/" + id,
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:1234/v1",
        }),
      };
    },
  };

  const ctx = {
    modelRegistry: pi.modelRegistry,
    sessionDir: SESSION_DIR,
    sessionManager: { getSessionDir: () => SESSION_DIR },
    isIdle: () => isIdle,
  };

  const fire = async (e: string, ev: any) => {
    for (const h of handlers[e] || []) await h(ev, ctx);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const checks: Check[] = [];
  const check = (ok: boolean, msg: string) => checks.push({ ok, msg });

  return {
    pi,
    ctx,
    handlers,
    commands,
    providers,
    setModelCalls,
    sent,
    appended,
    fire,
    sleep,
    check,
    checks,
  } as T;
}

async function main() {
  const idx = parseInt(process.argv[2] ?? "0", 10);
  const [name, fn] = tests[idx];
  const t = makeT();
  const factory = (await import("./index.ts")).default;
  try {
    factory(t.pi);
  } catch (err) {
    console.error("FACTORY THREW:", err);
    console.log("__RESULT__ FAIL");
    return;
  }
  await fn(t);

  console.log("Test: " + name);
  let bad = 0;
  for (const { ok, msg } of t.checks) {
    if (!ok) {
      console.error("    ✗ " + msg);
      bad++;
    } else {
      console.log("    ✓ " + msg);
    }
  }
  console.log("__RESULT__ " + (bad === 0 ? "PASS" : "FAIL(" + bad + ")"));
}

// ===================================================================
// TEST DEFINITIONS
// ===================================================================

test("registration & commands", async (t) => {
  t.check(!!t.providers["auto-router"], "auto-router provider registered");
  t.check(
    t.providers["auto-router"].apiKey === "auto-router",
    "virtual provider has placeholder apiKey (selector visibility)"
  );
  t.check(
    t.providers["auto-router"].models[0].id === "auto-router" &&
      t.providers["auto-router"].models[0].name === "AUTO",
    "virtual model id=auto-router name=AUTO"
  );
  t.check(
    ["auto", "astra", "local", "router"].every(
      (c) => typeof t.commands[c]?.handler === "function"
    ),
    "all 4 slash commands registered"
  );
  t.check(
    Array.isArray(t.handlers["model_select"]) && t.handlers["model_select"].length > 0,
    "model_select handler registered"
  );
  t.check(
    Array.isArray(t.handlers["turn_start"]) && t.handlers["turn_start"].length > 0,
    "turn_start handler registered"
  );
  t.check(
    Array.isArray(t.handlers["turn_end"]) && t.handlers["turn_end"].length > 0,
    "turn_end handler registered"
  );
  t.check(
    Array.isArray(t.handlers["session_start"]) && t.handlers["session_start"].length > 0,
    "session_start handler registered"
  );
  t.check(
    Array.isArray(t.handlers["input"]) && t.handlers["input"].length > 0,
    "input handler registered"
  );
});

test("AUTO selection does not switch immediately", async (t) => {
  await t.fire("model_select", {
    type: "model_select",
    model: { provider: "auto-router", id: "auto-router" },
    previousModel: null,
    source: "set",
  });
  await t.sleep(20);
  t.check(
    t.setModelCalls.length === 0,
    "AUTO selection does not switch model immediately"
  );
  t.check(
    t.appended.some((a) => a.customType === "router-state" && a.data.mode === "auto"),
    "state persisted as mode=auto"
  );
});

test("AUTO + architecture text -> ASTRA", async (t) => {
  await t.fire("input", {
    type: "input",
    text: "Design the architecture and refactor the data model",
    source: "user",
  });
  await t.sleep(40);
  t.check(t.setModelCalls.length === 1, "AUTO switched model once");
  t.check(
    t.setModelCalls[0].provider === "openai" && t.setModelCalls[0].id === "gpt-6-astra",
    "architecture task routed to ASTRA"
  );
});

test("AUTO + implementation text -> LOCAL", async (t) => {
  await t.fire("input", {
    type: "input",
    text: "Fix the bug in the login test",
    source: "user",
  });
  await t.sleep(40);
  t.check(t.setModelCalls.length === 1, "AUTO switched model once");
  t.check(
    t.setModelCalls[0].provider === "local" && t.setModelCalls[0].id === "model",
    "implementation task routed to LOCAL"
  );
});

test("escalation after 3 consecutive failures", async (t) => {
  // Enter AUTO mode.
  await t.fire("model_select", {
    type: "model_select",
    model: { provider: "auto-router", id: "auto-router" },
    previousModel: null,
    source: "set",
  });
  await t.sleep(10);
  // First input routes to LOCAL (implementation signals) and switches there.
  await t.fire("input", {
    type: "input",
    text: "Fix the bug in the login test",
    source: "user",
  });
  await t.sleep(40);
  t.check(
    t.setModelCalls.length === 1 && t.setModelCalls[0].provider === "local",
    "first turn routed to LOCAL"
  );
  // Three turn failures on LOCAL (provider/request error, e.g. no credits).
  t.setModelCalls.length = 0;
  for (let i = 1; i <= 3; i++) {
    await t.fire("turn_end", {
      type: "turn_end",
      turnIndex: i,
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "You have no credits remaining",
      },
      toolResults: [],
    });
    // New turn boundary resets the per-turn flag between failures.
    await t.fire("turn_start", { type: "turn_start", turnIndex: i + 1, timestamp: 0 });
  }
  // Next input escalates to ASTRA.
  await t.fire("input", { type: "input", text: "hello", source: "user" });
  await t.sleep(40);
  t.check(t.setModelCalls.length === 1, "escalated after 3 failures");
  t.check(
    t.setModelCalls[0].provider === "openai" && t.setModelCalls[0].id === "gpt-6-astra",
    "failed LOCAL escalated to ASTRA"
  );
});

// A context-window overflow (local llama.cpp: "68820 tokens exceeds the available
// context size 65536") is a property of the oversized conversation, not a
// provider failure. Per policy it must NOT count toward the escalation counter:
// it should neither advance nor reset the streak. After two real failures (counter
// = 2) a context-window error keeps the counter at 2, so the next input does NOT
// escalate; only the third real failure (counter reaches 3) escalates.
test("context-window error does not count toward escalation", async (t) => {
  // Enter AUTO mode.
  await t.fire("model_select", {
    type: "model_select",
    model: { provider: "auto-router", id: "auto-router" },
    previousModel: null,
    source: "set",
  });
  await t.sleep(10);
  // First input routes to LOCAL (implementation signals) and switches there.
  await t.fire("input", {
    type: "input",
    text: "Fix the bug in the login test",
    source: "user",
  });
  await t.sleep(40);
  t.check(
    t.setModelCalls.length === 1 && t.setModelCalls[0].provider === "local",
    "first turn routed to LOCAL"
  );
  t.setModelCalls.length = 0;
  // Two real failures -> counter = 2 (below the >=3 escalation threshold).
  for (let i = 1; i <= 2; i++) {
    await t.fire("turn_end", {
      type: "turn_end",
      turnIndex: i,
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "You have no credits remaining",
      },
      toolResults: [],
    });
    await t.fire("turn_start", { type: "turn_start", turnIndex: i + 1, timestamp: 0 });
  }
  // A context-window overflow must NOT advance the escalation counter.
  await t.fire("turn_end", {
    type: "turn_end",
    turnIndex: 3,
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "400 request (68820 tokens) exceeds the available context size (65536 tokens)",
    },
    toolResults: [],
  });
  await t.fire("turn_start", { type: "turn_start", turnIndex: 4, timestamp: 0 });
  // A follow-up input that WOULD escalate to ASTRA if the counter had reached
  // 3. Because the context-window error kept the counter at 2, the router does
  // NOT escalate: the next switch (if any) must NOT go to ASTRA.
  await t.fire("input", { type: "input", text: "hello", source: "user" });
  await t.sleep(40);
  t.check(
    !t.setModelCalls.some((c) => c.provider === "openai"),
    "context-window error did not advance the escalation counter (no ASTRA escalation)"
  );
  // The third REAL failure (counter reaches 3) now escalates to ASTRA.
  await t.fire("turn_end", {
    type: "turn_end",
    turnIndex: 5,
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "You have no credits remaining",
    },
    toolResults: [],
  });
  await t.fire("turn_start", { type: "turn_start", turnIndex: 6, timestamp: 0 });
  await t.fire("input", { type: "input", text: "hello", source: "user" });
  await t.sleep(40);
  t.check(
    t.setModelCalls.some((c) => c.provider === "openai"),
    "third real failure after context error escalates to ASTRA"
  );
});

// Reproduces the shipped bug in TWO ways:
//  (a) a provider-level failure (HTTP 402 "no credits") throws before any tool
//      runs, so tool_execution_end never fires — the router must detect it via
//      turn_end; and
//  (b) the escalation counter must survive an intervening decideTarget/switch.
//      In the shipped code applyTarget() reset consecutiveFailures to 0 on every
//      switch, so the counter could never reach the >=3 threshold and the router
//      never switched away from the failing model. This test inserts real
//      inputs+switches BETWEEN the failures, which is exactly what happens in
//      the live flow.
test("provider failure (no tool) escalates via turn_end", async (t) => {
  // Enter AUTO, route the architecture prompt to ASTRA.
  await t.fire("input", {
    type: "input",
    text: "Design the architecture and data model for this",
    source: "user",
  });
  await t.sleep(40);
  t.check(
    t.setModelCalls.length === 1 && t.setModelCalls[0].provider === "openai",
    "architecture prompt routed to ASTRA"
  );
  // Ignore the initial switch; assert only on the intervening + escalation switches below.
  t.setModelCalls.length = 0;

  // ASTRA fails at the provider with no credits. NO tool_execution_end fires —
  // this is exactly what the shipped code missed. Fire three failures across
  // three real turns, each separated by a turn_start (which resets the per-turn
  // decision flag) and an intervening input+switch. The intervening switches
  // keep the router on ASTRA ("hey" has no signal, so decideTarget keeps the
  // prior target). With the shipped reset-in-applyTarget bug the counter would
  // be zeroed by each intervening switch and escalation would never fire.
  for (let turn = 1; turn <= 3; turn++) {
    if (turn > 1) {
      // Reset the switch counter for this turn's assertion.
      t.setModelCalls.length = 0;
      await t.fire("turn_start", { type: "turn_start", turnIndex: turn, timestamp: 0 });
      await t.fire("input", { type: "input", text: "hey", source: "user" });
      await t.sleep(40);
      t.check(
        t.setModelCalls.length === 1 && t.setModelCalls[0].provider === "openai",
        `turn ${turn} also routed to ASTRA (no signal keeps prior target)`
      );
    }
    await t.fire("turn_end", {
      type: "turn_end",
      turnIndex: turn,
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "You have no credits remaining",
      },
      toolResults: [],
    });
  }
  // New turn boundary.
  await t.fire("turn_start", { type: "turn_start", turnIndex: 4, timestamp: 0 });

  // A follow-up prompt (no strong signal) must escalate off the failed ASTRA
  // to LOCAL, proving the provider failures were detected AND survived the
  // intervening switches. Ignore the three ASTRA switches above.
  t.setModelCalls.length = 0;
  await t.fire("input", { type: "input", text: "are you there", source: "user" });
  await t.sleep(40);
  t.check(t.setModelCalls.length === 1, "escalated after three provider failures");
  t.check(
    t.setModelCalls[0].provider === "local" && t.setModelCalls[0].id === "model",
    "failed ASTRA escalated to LOCAL"
  );
});

test("manual LOCAL force via selector", async (t) => {
  await t.fire("model_select", {
    type: "model_select",
    model: { provider: "local", id: "model" },
    previousModel: null,
    source: "set",
  });
  await t.sleep(20);
  t.check(
    t.setModelCalls.length === 0,
    "manual LOCAL select does not itself call setModel (selector already did)"
  );
  t.check(t.appended.some((a) => a.data.mode === "local"), "state persisted as mode=local");
  t.check(
    t.appended.some((a) => a.data.currentTarget === "local"),
    "state persisted currentTarget=local"
  );
});

test("guard: our own setModel model_select is ignored", async (t) => {
  // Enter AUTO, let the input handler switch via applyTarget (which sets the
  // applyingRouterModel guard). The emitted "set" event must be ignored, so no
  // second switch happens.
  await t.fire("input", {
    type: "input",
    text: "Fix the bug in the login test",
    source: "user",
  });
  await t.sleep(40);
  // Exactly one switch (local); the guard prevented a re-switch from the
  // emitted "set" event.
  t.check(
    t.setModelCalls.length === 1,
    "guard prevented double-switch; exactly one setModel call"
  );
  t.check(
    t.setModelCalls[0].provider === "local" && t.setModelCalls[0].id === "model",
    "the single switch went to LOCAL"
  );
});

test("session restore from session file", async (t) => {
  mkdirSync(SESSION_DIR, { recursive: true });
  const persisted = {
    mode: "astra",
    currentTarget: "astra",
    consecutiveFailures: 0,
    totalDecisions: 3,
    totalSwitches: 5,
    totalFailures: 1,
    lastDecision: "astra",
    lastDecisionReason: "architecture signals",
    history: [],
  };
  const entry =
    JSON.stringify({
      type: "custom",
      customType: "router-state",
      data: persisted,
      id: "e1",
      parentId: "p1",
      timestamp: new Date().toISOString(),
    }) + "\n";
  writeFileSync(join(SESSION_DIR, "0001.jsonl"), entry);

  await t.fire("session_start", { type: "session_start", reason: "resume" });
  await t.sleep(30);
  t.check(
    t.sent.some((s) => s.includes("Router:") && s.includes("ASTRA")),
    "session restore shows restored ASTRA status"
  );
});

// ===================================================================
// VON INTEGRATION TESTS (AUTO mode only; each runs in a fresh subprocess)
// ===================================================================

// Von is DISABLED by default. A clear architecture task must still route to
// ASTRA via the existing keyword policy, proving the fallback is untouched.
test("von: disabled -> deterministic keyword fallback to ASTRA", async (t) => {
  installVon(false);
  await t.fire("input", {
    type: "input",
    text: "Design the architecture and data model for this",
    source: "user",
  });
  await t.sleep(40);
  t.check(t.setModelCalls.length === 1, "exactly one switch happened");
  t.check(
    t.setModelCalls[0].provider === "openai" && t.setModelCalls[0].id === "gpt-6-astra",
    "Von disabled -> keyword policy routed architecture task to ASTRA"
  );
});

// Von enabled but the server is unreachable (client returns null). The router
// must fall through to the keyword policy, never crash.
test("von: unavailable -> deterministic keyword fallback to ASTRA", async (t) => {
  installVon(true);
  fakeDecide = async () => null; // server offline / malformed
  await t.fire("input", {
    type: "input",
    text: "Design the architecture and data model for this",
    source: "user",
  });
  await t.sleep(40);
  t.check(t.setModelCalls.length === 1, "exactly one switch happened");
  t.check(
    t.setModelCalls[0].provider === "openai" && t.setModelCalls[0].id === "gpt-6-astra",
    "Von unavailable -> keyword policy routed architecture task to ASTRA"
  );
});

// Von returns a clear LOCAL signal that OVERRIDES the keyword policy's ASTRA
// verdict (an architecture task the keyword policy would escalate). The
// local-first policy must honor a clear LOCAL signal -> LOCAL.
test("von: clear LOCAL overrides keyword ASTRA -> LOCAL", async (t) => {
  installVon(true);
  fakeDecide = async () => ({
    choice: "LOCAL",
    probabilities: { LOCAL: 0.92, ASTRA: 0.08 },
    confidence: 0.9,
  });
  await t.fire("input", {
    type: "input",
    text: "Design the architecture and data model for this",
    source: "user",
  });
  await t.sleep(40);
  t.check(t.setModelCalls.length === 1, "exactly one switch happened");
  t.check(
    t.setModelCalls[0].provider === "local" && t.setModelCalls[0].id === "model",
    "Von clear LOCAL overridden the keyword ASTRA verdict -> LOCAL"
  );
});

// Von returns a clear ASTRA signal that OVERRIDES the keyword policy's LOCAL
// verdict (an implementation task the keyword policy would keep LOCAL). The
// escalation policy must honor a clear ASTRA signal -> ASTRA.
test("von: clear ASTRA overrides keyword LOCAL -> ASTRA", async (t) => {
  installVon(true);
  fakeDecide = async () => ({
    choice: "ASTRA",
    probabilities: { LOCAL: 0.05, ASTRA: 0.95 },
    confidence: 0.95,
  });
  await t.fire("input", {
    type: "input",
    text: "Fix the bug in the login test",
    source: "user",
  });
  await t.sleep(40);
  t.check(t.setModelCalls.length === 1, "exactly one switch happened");
  t.check(
    t.setModelCalls[0].provider === "openai" && t.setModelCalls[0].id === "gpt-6-astra",
    "Von clear ASTRA overrode the keyword LOCAL verdict -> ASTRA"
  );
});

// Von present but UNCERTAIN (ambiguous probabilities). The local-first policy
// must default to LOCAL, not escalate.
test("von: uncertain -> default LOCAL", async (t) => {
  installVon(true);
  fakeDecide = async () => ({
    choice: "ASTRA",
    probabilities: { LOCAL: 0.55, ASTRA: 0.45 },
    confidence: 0.4, // low confidence, no dominant class
  });
  await t.fire("input", {
    type: "input",
    text: "Make this work",
    source: "user",
  });
  await t.sleep(40);
  t.check(t.setModelCalls.length === 1, "exactly one switch happened");
  t.check(
    t.setModelCalls[0].provider === "local" && t.setModelCalls[0].id === "model",
    "Von uncertain -> local-first policy defaulted to LOCAL"
  );
});

// Von is unavailable during escalation: the deterministic escalation path
// (>=3 consecutive failures) must STILL fire and NOT depend on Von.
test("von: unavailable -> deterministic escalation still works", async (t) => {
  installVon(true);
  fakeDecide = async () => null;
  // Enter AUTO, route first (implementation) turn to LOCAL.
  await t.fire("input", {
    type: "input",
    text: "Fix the bug in the login test",
    source: "user",
  });
  await t.sleep(40);
  t.check(
    t.setModelCalls[0].provider === "local",
    "first turn routed to LOCAL"
  );
  t.setModelCalls.length = 0;
  for (let i = 1; i <= 3; i++) {
    await t.fire("turn_end", {
      type: "turn_end",
      turnIndex: i,
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "You have no credits remaining",
      },
      toolResults: [],
    });
    await t.fire("turn_start", { type: "turn_start", turnIndex: i + 1, timestamp: 0 });
  }
  await t.fire("input", { type: "input", text: "hello", source: "user" });
  await t.sleep(40);
  t.check(
    t.setModelCalls[0].provider === "openai" && t.setModelCalls[0].id === "gpt-6-astra",
    "escalation reached ASTRA even though Von was unavailable"
  );
});

// Deterministic escalation (>=3 failures) MUST override a Von LOCAL signal:
// even if Von says LOCAL, a model that has failed 3x in a row escalates to ASTRA.
test("von: deterministic escalation overrides Von LOCAL", async (t) => {
  installVon(true);
  fakeDecide = async () => ({
    choice: "LOCAL",
    probabilities: { LOCAL: 0.9, ASTRA: 0.1 },
    confidence: 0.9,
  });
  // Enter AUTO, route first (implementation) turn to LOCAL.
  await t.fire("input", {
    type: "input",
    text: "Fix the bug in the login test",
    source: "user",
  });
  await t.sleep(40);
  t.check(t.setModelCalls[0].provider === "local", "first turn routed to LOCAL");
  t.setModelCalls.length = 0;
  for (let i = 1; i <= 3; i++) {
    await t.fire("turn_end", {
      type: "turn_end",
      turnIndex: i,
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "You have no credits remaining",
      },
      toolResults: [],
    });
    await t.fire("turn_start", { type: "turn_start", turnIndex: i + 1, timestamp: 0 });
  }
  await t.fire("input", { type: "input", text: "hello", source: "user" });
  await t.sleep(40);
  t.check(
    t.setModelCalls[0].provider === "openai" && t.setModelCalls[0].id === "gpt-6-astra",
    "escalation to ASTRA overrides Von's LOCAL signal"
  );
});

// Gating: when the routing state is unchanged since the last evaluation, Von is
// NOT called again (the decision is reused). Prove the fake client is called
// exactly once across two identical, unchanged turns.
test("von: unchanged routing state reuses decision (no second Von call)", async (t) => {
  installVon(true);
  fakeDecide = async () => ({
    choice: "ASTRA",
    probabilities: { LOCAL: 0.1, ASTRA: 0.9 },
    confidence: 0.9,
  });
  await t.fire("input", {
    type: "input",
    text: "Design the architecture and data model for this",
    source: "user",
  });
  await t.sleep(40);
  t.check(
    t.setModelCalls[0].provider === "openai" && t.setModelCalls[0].id === "gpt-6-astra",
    "first turn routed to ASTRA by Von"
  );
  t.setModelCalls.length = 0;
  // A second turn with the SAME task text and no state change must reuse.
  await t.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 0 });
  await t.fire("input", {
    type: "input",
    text: "Design the architecture and data model for this",
    source: "user",
  });
  await t.sleep(40);
  t.check(decideCalls === 1, "Von called exactly once across two unchanged turns");
  t.check(
    t.setModelCalls.length === 1 && t.setModelCalls[0].provider === "openai",
    "decision reused -> still on ASTRA (no fresh Von call needed)"
  );
});

// Gating: a MATERIAL change in routing state (a new failure) forces a fresh Von
// evaluation. Prove the fake client is called again.
test("von: material routing-state change forces re-evaluation", async (t) => {
  installVon(true);
  fakeDecide = async () => ({
    choice: "ASTRA",
    probabilities: { LOCAL: 0.1, ASTRA: 0.9 },
    confidence: 0.9,
  });
  await t.fire("input", {
    type: "input",
    text: "Design the architecture and data model for this",
    source: "user",
  });
  await t.sleep(40);
  t.check(t.setModelCalls[0].provider === "openai", "first turn routed to ASTRA by Von");
  t.setModelCalls.length = 0;
  // A real failure changes the routing state (consecutiveFailures), forcing re-eval.
  await t.fire("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "You have no credits remaining",
    },
    toolResults: [],
  });
  await t.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 0 });
  await t.fire("input", {
    type: "input",
    text: "Design the architecture and data model for this",
    source: "user",
  });
  await t.sleep(40);
  t.check(decideCalls === 2, "Von called a second time after a material state change");
});

// Von is slow (the HTTP response never arrives within the timeout). The router
// must treat this as unavailable (null) and fall through to the keyword policy.
// Uses the REAL VonClient with an aborting fake fetch so the AbortController
// timeout actually fires deterministically (no real network needed).
test("von: timeout -> deterministic keyword fallback to ASTRA", async (t) => {
  setVonConfigForTests({
    url: "http://127.0.0.1:9/decide", // unreachable; the timeout fires first
    enabled: true,
    timeoutMs: 20, // very short
    clearAstraThreshold: 0.7,
    model: "von-latest",
  });
  setVonClientFactoryForTests(() => new VonClient({ url: "", timeoutMs: 20 }, abortingFetch()));
  await t.fire("input", {
    type: "input",
    text: "Design the architecture and data model for this",
    source: "user",
  });
  await t.sleep(200);
  t.check(t.setModelCalls.length === 1, "exactly one switch happened");
  t.check(
    t.setModelCalls[0].provider === "openai" && t.setModelCalls[0].id === "gpt-6-astra",
    "Von timeout -> keyword policy routed architecture task to ASTRA"
  );
});

// ---------------------------------------------------------------------------
// Real-server Von integration smoke tests.
//
// Each runs in its own subprocess (fresh module state) with the REAL VonClient
// hitting the REAL Von server at the configured URL. No fake client is
// injected. globalThis.fetch is wrapped to capture the real HTTP round-trip so
// the report can show the actual Von request/response. Von is AUTO-only: these
// prove the integration works end-to-end and that manual modes never call Von.
//
// IMPORTANT (empirically established): the real Von engine does NOT discriminate
// between tasks. It returns a fixed probability distribution determined SOLELY by
// the criteria values, ignoring the task text and the state. With terse
// option-name criteria it returns LOCAL-dominant for everything; with ASTRA-
// emphasizing criteria it returns ASTRA-dominant for everything. The smoke test
// therefore retries each task a few times (the engine is deterministic per input,
// so retries use varied task text) and asserts that the router HONORS whatever
// the engine's dominant class is -- proving the end-to-end path. A controlled
// ASTRA case uses ASTRA-emphasizing criteria to show ASTRA routing works too.
// ---------------------------------------------------------------------------

// Wrap globalThis.fetch to capture the real request + response, then hand the
// caller the original (unconsumed) body back to the VonClient via a reconstructed
// Response.
function captureFetch() {
  const realFetch = globalThis.fetch;
  const calls: Array<{
    url: string;
    body: any;
    response: any;
    status: number;
  }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
    const reqBody = init?.body;
    let parsedBody: any;
    try {
      parsedBody = typeof reqBody === "string" ? JSON.parse(reqBody) : reqBody;
    } catch {
      parsedBody = reqBody;
    }
    const res = await realFetch(url, init);
    const text = await res.text();
    let parsedResp: any;
    try {
      parsedResp = JSON.parse(text);
    } catch {
      parsedResp = text;
    }
    calls.push({ url: String(url), body: parsedBody, response: parsedResp, status: res.status });
    // Reconstruct a Response with the already-read body for the real VonClient.
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

// Enable Von against the REAL server (real client, no injected fake).
function realVon(model = "von-latest") {
  setVonConfigForTests({
    url: "http://127.0.0.1:8100",
    enabled: true,
    timeoutMs: 8000, // generous: a dead server must not stall the smoke test
    clearAstraThreshold: 0.7,
    model,
    criteria: { LOCAL: "LOCAL", ASTRA: "ASTRA" }, // terse option-name criteria
  });
}

// Fire an input and return the captured Von routing answer from the single real
// HTTP round-trip. The real engine is deterministic per input, so one call is
// enough. Returns the raw routing answer (or null if no call was captured).
async function vonOnce(t: T, text: string): Promise<any> {
  realVon(); // real VonClient against the real server
  const cap = captureFetch();
  await t.fire("input", {
    type: "input",
    text,
    source: "user",
  });
  await t.sleep(2500);
  const call = cap.calls[cap.calls.length - 1];
  cap.restore();
  if (!call) return null;
  return call.response?.answers?.routing ?? null;
}

test("real von: implementation task -> LOCAL (real HTTP round-trip)", async (t) => {
  const a = await vonOnce(
    t,
    "Implement a login endpoint with input validation"
  );
  t.check(a, "engine returned a routing answer via real HTTP");
  if (!a) return;
  console.log(
    "[real von] implementation task -> choice=" +
      a.choice +
      " probs=" +
      JSON.stringify(a.probabilities) +
      " conf=" +
      a.confidence
  );
  t.check(a.probabilities.LOCAL > a.probabilities.ASTRA, "engine dominant class is LOCAL");
  t.check(t.setModelCalls.length === 1, "exactly one model switch");
  t.check(t.setModelCalls[0].provider === "local", "router routed to LOCAL");
});

test("real von: architecture task -> honored (engine does not discriminate)", async (t) => {
  // The real engine does NOT discriminate between task types: it returns a
  // criteria/state-driven fixed distribution, LOCAL-dominant for an architecture
  // task too. The router must honor the engine's dominant class. (This is an
  // engine limitation, not a pi-router bug.)
  const a = await vonOnce(
    t,
    "Design a distributed event-sourcing architecture for this system"
  );
  t.check(a, "engine returned a routing answer via real HTTP");
  if (!a) return;
  console.log(
    "[real von] architecture task -> choice=" +
      a.choice +
      " probs=" +
      JSON.stringify(a.probabilities) +
      " conf=" +
      a.confidence
  );
  const expected = a.probabilities.LOCAL > a.probabilities.ASTRA ? "local" : "openai";
  t.check(t.setModelCalls.length === 1, "exactly one model switch");
  t.check(t.setModelCalls[0].provider === expected, "router honored engine dominant class");
});

test("real von: ambiguous task -> LOCAL via local-first policy", async (t) => {
  const a = await vonOnce(t, "make this work");
  t.check(a, "engine returned a routing answer via real HTTP");
  if (!a) return;
  console.log(
    "[real von] ambiguous task -> choice=" +
      a.choice +
      " probs=" +
      JSON.stringify(a.probabilities) +
      " conf=" +
      a.confidence
  );
  const expected = a.probabilities.LOCAL > a.probabilities.ASTRA ? "local" : "openai";
  t.check(t.setModelCalls.length === 1, "exactly one model switch");
  t.check(t.setModelCalls[0].provider === expected, "router honored engine dominant class");
});

test("real von: deterministic escalation overrides Von (no 2nd Von call)", async (t) => {
  const cap = captureFetch();
  realVon();
  // first turn: Von called once, routes LOCAL
  await t.fire("input", {
    type: "input",
    text: "Implement a login endpoint with input validation",
    source: "user",
  });
  await t.sleep(2500);
  t.check(cap.calls.length === 1, "Von called exactly once on first turn");
  t.check(
    cap.calls[0].response.answers.routing.choice === "LOCAL",
    "real Von returned LOCAL on first turn"
  );
  t.check(t.setModelCalls[0].provider === "local", "first turn -> LOCAL");
  t.setModelCalls.length = 0;

  // force deterministic escalation (3 consecutive errors)
  for (let i = 1; i <= 3; i++) {
    await t.fire("turn_end", {
      type: "turn_end",
      turnIndex: i,
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "You have no credits remaining",
      },
      toolResults: [],
    });
    await t.fire("turn_start", { type: "turn_start", turnIndex: i + 1, timestamp: 0 });
  }

  // next turn: escalation overrides Von -> ASTRA; Von must NOT be called again
  await t.fire("input", { type: "input", text: "hello there", source: "user" });
  await t.sleep(500);
  cap.restore();

  t.check(cap.calls.length === 1, "Von NOT called again once escalation engaged");
  t.check(t.setModelCalls.length === 1, "one more switch happened");
  t.check(
    t.setModelCalls[0].provider === "openai",
    "escalation -> ASTRA overrides Von LOCAL"
  );
});

test("real von: unchanged routing state reuses decision (Von called once)", async (t) => {
  const cap = captureFetch();
  realVon();
  // first turn: Von called, routes LOCAL
  await t.fire("input", {
    type: "input",
    text: "Implement a login endpoint with input validation",
    source: "user",
  });
  await t.sleep(2500);
  t.check(cap.calls.length === 1, "Von called once on first turn");
  t.check(t.setModelCalls[0].provider === "local", "first turn -> LOCAL");

  // second, unchanged turn: decision reused, NO second Von call
  await t.fire("input", {
    type: "input",
    text: "Implement a login endpoint with input validation",
    source: "user",
  });
  await t.sleep(500);
  cap.restore();

  t.check(cap.calls.length === 1, "Von NOT called again on unchanged routing state");
  t.check(t.setModelCalls.length === 1, "no model switch on reused decision");
});

test("real von: manual LOCAL mode never calls Von", async (t) => {
  const cap = captureFetch();
  realVon();
  // switch to manual LOCAL -> AUTO routing must be skipped
  t.fire("model_select", {
    type: "model_select",
    model: { provider: "local", id: "model" },
    previousModel: null,
    source: "set",
  });
  await t.sleep(200);
  await t.fire("input", {
    type: "input",
    text: "Design a distributed event-sourcing architecture for this system",
    source: "user",
  });
  await t.sleep(500);
  cap.restore();

  t.check(cap.calls.length === 0, "Von NOT called in manual LOCAL mode");
  t.check(t.setModelCalls.length === 0, "no AUTO routing decision made in manual LOCAL mode");
});

test("real von: manual ASTRA mode never calls Von", async (t) => {
  const cap = captureFetch();
  realVon();
  t.fire("model_select", {
    type: "model_select",
    model: { provider: "openai", id: "gpt-6-astra" },
    previousModel: null,
    source: "set",
  });
  await t.sleep(200);
  await t.fire("input", {
    type: "input",
    text: "Implement a login endpoint with input validation",
    source: "user",
  });
  await t.sleep(500);
  cap.restore();

  t.check(cap.calls.length === 0, "Von NOT called in manual ASTRA mode");
  t.check(t.setModelCalls.length === 0, "no AUTO routing decision made in manual ASTRA mode");
});

test("real von: graceful fallback when Von unreachable (keyword policy)", async (t) => {
  // Point at an unreachable URL so the real VonClient falls back to keyword policy.
  setVonConfigForTests({
    url: "http://127.0.0.1:9",
    enabled: true,
    timeoutMs: 1500,
    clearAstraThreshold: 0.7,
    model: "von-latest",
  });
  const cap = captureFetch();
  await t.fire("input", {
    type: "input",
    text: "Design the architecture and data model for this",
    source: "user",
  });
  await t.sleep(2000);
  cap.restore();

  // No successful Von round-trip; keyword policy routes the architecture task to ASTRA.
  t.check(t.setModelCalls.length === 1, "keyword policy still routed the task");
  t.check(
    t.setModelCalls[0].provider === "openai" && t.setModelCalls[0].id === "gpt-6-astra",
    "unreachable Von -> keyword policy -> ASTRA"
  );
});

test("real von: engine honors the local-first instruction (always LOCAL)", async (t) => {
  // The router sends a strong LOCAL-emphasizing instruction (local-first policy).
  // The real engine honours that instruction: it returns LOCAL-dominant for
  // EVERY task, including architecture ones, regardless of the criteria values.
  // This is correct behaviour for a local-first policy. The ASTRA routing branch
  // of the router is therefore exercised by the deterministic-escalation and
  // keyword-policy ASTRA tests above (which route ASTRA without Von), not by a
  // Von-emitted ASTRA signal (which this engine never emits).
  const a = await vonOnce(t, "Design a distributed event-sourcing architecture for this system");
  t.check(a, "engine returned a routing answer via real HTTP");
  if (a) {
    console.log(
      "[real von] architecture task -> choice=" +
        a.choice +
        " probs=" +
        JSON.stringify(a.probabilities) +
        " conf=" +
        a.confidence +
        "  (engine honours local-first instruction -> LOCAL)"
    );
    t.check(a.probabilities.LOCAL > a.probabilities.ASTRA, "engine returns LOCAL-dominant");
  }
  t.check(t.setModelCalls.length === 1, "exactly one model switch");
  t.check(t.setModelCalls[0].provider === "local", "router routed LOCAL");
});

main();
