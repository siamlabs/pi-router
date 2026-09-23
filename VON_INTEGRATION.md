# Von Integration — Architecture and Integration Analysis

## 1. Where Von connects

Von is used only in **AUTO mode**, at the point where the router determines the per-turn target: `decideTarget()`.

```text
handleInput (idle) ─┐
handleTurnStart ────┘
        │
        ▼
   decideTarget(text, prevTarget)
        │
        ├─ deterministic escalation
        │  (consecutiveFailures >= 3)
        │
        ├─ Von available?
        │      │
        │      ├─ no ──► deterministic + keyword fallback
        │      │
        │      └─ yes ──► policyEngine(vonDecision)
        │                    │
        │                    ├─ ASTRA signal ──► ASTRA
        │                    ├─ LOCAL signal ──► LOCAL
        │                    └─ uncertain ─────► LOCAL
        │
        └─ deterministic + keyword fallback
```

The deterministic three-failure escalation is evaluated first and remains an override.

Von is never consulted for manual `LOCAL` or `ASTRA` modes. Manual model selection sets the corresponding router mode, and the AUTO routing handlers do not perform routing while the router is in a manual mode.

## 2. Routing state

The live `RouterState` is the single source of truth for routing state.

The routing snapshot is derived from the existing router state rather than maintaining a separate state system.

Relevant routing signals include:

| Field                 | Purpose                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| `consecutiveFailures` | Deterministic escalation signal                                              |
| `totalFailures`       | Cumulative failure count                                                     |
| `toolErrors`          | Tool-error tracking                                                          |
| `testFailures`        | Test-failure tracking                                                        |
| `filesChanged`        | File-change signal                                                           |
| `securitySensitive`   | Security-sensitive task signal                                               |
| `phase`               | Current routing phase                                                        |
| `routingSignature`    | Derived signature used to determine whether routing state materially changed |

The routing snapshot sent to Von is derived from these values.

## 3. Files involved

### `router/index.ts`

The main Pi extension is responsible for:

* Maintaining router state
* Handling AUTO/LOCAL/ASTRA modes
* Calling the Von adapter when appropriate
* Applying deterministic escalation
* Tracking routing signals
* Switching the active Pi model
* Persisting router state
* Handling Pi lifecycle events

### `router/von.ts`

The Von integration is isolated in a dedicated adapter and policy layer.

It contains functionality for:

* Von decision types
* HTTP request construction
* Von response parsing
* Probability and confidence normalization
* Request timeout handling
* Routing policy evaluation
* Routing snapshot construction
* Von configuration loading

### `router/von.config.json`

Contains generic Von configuration such as:

* Von endpoint
* Enabled/disabled state
* Routing threshold
* Optional routing criteria

The public configuration contains no personal, machine-specific, or credential-bearing values.

## 4. Existing behavior that remains unchanged

The Von integration preserves the existing router behavior, including:

* Manual LOCAL / ASTRA mode bypassing Von
* `applyTarget()` and Pi model switching
* Model-switching guard logic
* Turn-end failure detection
* Context-window error exclusion
* Three-consecutive-failure escalation
* Keyword-based fallback classification
* State persistence
* Status reporting
* Slash commands
* AUTO virtual provider

Von is an additional classification layer inside the existing AUTO routing path rather than a replacement for the router's existing policy.

## 5. Routing evaluation point

Von is evaluated at the same point where the router determines the next model target.

The relevant handlers are:

* `handleInput`
* `handleTurnStart`

The router does not call Von for every tool call or internal event.

A routing signature is used to determine whether relevant routing state has changed enough to justify another classification request.

Conceptually:

```text
Task / routing state
        │
        ▼
routingSignature
        │
        ├─ unchanged ──► reuse existing routing decision
        │
        └─ changed ────► evaluate routing again
```

This keeps the classifier outside the individual tool-execution loop.

## 6. Failure handling

The Von adapter treats classifier failures as non-fatal.

A Von decision is considered unavailable when the request encounters conditions such as:

* Von server unavailable
* HTTP failure
* Request timeout
* Malformed JSON
* Missing required fields
* Invalid probability values
* Unexpected classification value

When Von cannot provide a usable decision, the router falls back to its deterministic routing policy.

The adapter does not allow a Von request failure to propagate as a router or model-execution failure.

The default classifier timeout is intentionally short so that routing does not introduce a significant delay to normal task execution.

## 7. Routing policy

The router uses a local-first policy.

Typical LOCAL tasks include:

* Routine implementation
* Straightforward coding
* Existing code patterns
* Ordinary tool usage
* Simple file changes
* Routine debugging

ASTRA may be selected when routing signals indicate a need for deeper reasoning, such as:

* Difficult architecture or system design
* Complex reasoning
* Security-sensitive work
* Ambiguous requirements
* Repeated failures
* Test failures
* Tool errors
* Diagnosis that has not been successfully resolved locally

The router does not select ASTRA merely because a task involves coding, multiple files, or ordinary debugging.

When the classifier result is uncertain, the policy defaults to LOCAL.

## 8. Von decision policy

Von returns a classification containing probabilities for the available routing targets and a confidence value.

The policy layer then interprets that result.

Conceptually:

```text
Von
 │
 ├── LOCAL probability
 ├── ASTRA probability
 └── confidence
          │
          ▼
    Policy evaluation
          │
     ┌────┴────┐
     │         │
   LOCAL     ASTRA
```

ASTRA is selected only when its probability satisfies the configured threshold and exceeds the LOCAL probability.

An uncertain result defaults to LOCAL.

This keeps Von responsible for classification while keeping the final routing policy inside `pi-router`.

## 9. Real-server integration smoke test

A separate real-server smoke test was performed against a **locally running Von server** at:

```text
http://127.0.0.1:8100
```

The smoke test uses the real Von HTTP path rather than an injected test double.

It exercises:

1. Von HTTP request construction
2. Real HTTP POST
3. Response parsing
4. Probability normalization
5. `policyEngine`
6. AUTO routing
7. Model-target application

The real-server test is separate from the automated tests that use the Von test seam.

### Observed routing cases

| Test case                | Von result     | Router target |
| ------------------------ | -------------- | ------------- |
| Implementation           | LOCAL-dominant | LOCAL         |
| Architecture             | LOCAL-dominant | LOCAL         |
| Ambiguous task           | LOCAL-dominant | LOCAL         |
| Three-failure escalation | Von not called | ASTRA         |

The exact probabilities returned by Von are implementation- and configuration-dependent and should not be treated as fixed API behavior.

### Observed classifier behavior

The tested Von configuration showed a strong dependence on the routing instruction and criteria.

With the local-first routing instruction, the real-server tests produced LOCAL-dominant classifications across the tested tasks, including the architecture/design case.

Changing the criteria and instruction affected the resulting probabilities, demonstrating that the classifier responds strongly to the supplied routing configuration.

In the tested configuration, task text and most routing-state fields had less observable influence than the routing instruction and criteria.

This means the Von integration should be understood as a **criteria-driven classification component**, not as an independent general-purpose task-understanding system.

The routing instruction and policy therefore remain important parts of the overall routing behavior.

## 10. ASTRA routing verification

The ASTRA branch is also covered independently of a Von-emitted ASTRA classification.

Two deterministic paths can select ASTRA without consulting Von:

### Three-failure escalation

```text
consecutiveFailures >= 3
        │
        ▼
   hard escalation
        │
        ▼
      ASTRA
```

The escalation rule takes precedence over the Von classification path.

### Deterministic fallback

When Von is unavailable, the existing keyword classifier remains available.

For example, an architecture-oriented task can be classified as an ASTRA candidate through the deterministic fallback path when the Von service is unavailable.

The Von-emitted ASTRA branch itself is covered by automated tests using controlled Von responses.

This separates verification of:

* Real Von HTTP communication
* Von response parsing
* Policy evaluation
* Deterministic fallback
* Failure escalation
* ASTRA target application

## 11. Tests

Automated tests use the Von integration test seam rather than requiring a running Von server.

This keeps the normal test suite deterministic and allows specific Von responses to be tested.

The test coverage includes:

* LOCAL routing
* ASTRA routing
* Uncertain classification
* Von unavailable
* HTTP failure
* Timeout
* Invalid response
* Manual LOCAL bypass
* Manual ASTRA bypass
* AUTO routing
* Three-failure escalation
* Routing-state changes
* Model switching
* State persistence

A separate real-server smoke test can be run when a local Von server is available.

## 12. Separation of responsibilities

The integration intentionally keeps the components separate:

```text
┌─────────────────────────────┐
│             Pi              │
│                             │
│ Session + model management  │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│         pi-router           │
│                             │
│ Routing state               │
│ Routing policy              │
│ Fallback                    │
│ Failure escalation          │
│ Model switching             │
└──────────────┬──────────────┘
               │
               │ optional HTTP
               ▼
┌─────────────────────────────┐
│            Von              │
│                             │
│ External classifier         │
│ Routing classification      │
└─────────────────────────────┘
```

Von does not execute the user's task.

`pi-router` remains responsible for deciding how the classification is interpreted and which Pi model is ultimately selected.

## 13. Configuration and external dependency

Von is an **optional external dependency**.

It is not bundled with `pi-router`.

Users who want Von-based AUTO classification must install and run Von separately.

The `pi-router` repository does not include:

* Von's server implementation
* Von model weights
* Von's runtime environment
* Von installation dependencies
* API credentials for external providers

A generic local configuration may look like:

```json
{
  "url": "http://127.0.0.1:8100",
  "enabled": false
}
```

Users can enable the integration after installing and running their own Von instance.

## 14. Security and public-repository considerations

The integration configuration is designed to remain generic and safe for source control.

The repository should not contain:

* API keys
* Access tokens
* Passwords
* Cookies
* Private credentials
* Machine-specific filesystem paths
* Personal usernames
* Private service URLs
* Local environment secrets

Localhost addresses such as `127.0.0.1` are examples of local service endpoints and do not identify a remote production service.

Users are responsible for configuring their own model-provider credentials through their normal Pi/provider configuration.

## 15. Summary

The Von integration adds an optional classifier to the existing AUTO routing path.

The resulting architecture is:

```text
                    Pi
                     │
                     ▼
                pi-router
                     │
                  AUTO mode
                     │
             ┌───────┴───────┐
             │               │
          Von available?     │
             │               │
        ┌────┴────┐          │
       yes         no         │
        │           │         │
        ▼           ▼         ▼
      Von       deterministic policy
        │           │
        └─────┬─────┘
              │
         LOCAL / ASTRA
```

The integration preserves the existing deterministic routing and failure-handling behavior while allowing an optional external classifier to participate in AUTO decisions.

When Von is unavailable, the router continues to operate using its existing fallback logic.
