![pi-router](./pi-router.jpg)
#pi-router

Automatic model routing for Pi through a lightweight Pi extension.

pi-router lets you use a LOCAL model, an ASTRA model, or let Pi automatically choose between them per turn.

It works through Pi's existing /model selector and does not replace or hide it.



> **Experimental / Personal Project**
>
> `pi-router` is an experimental project that was originally developed
> for personal use and is now being shared publicly in case it is useful to others.
>
> The project may change significantly over time and may not cover every use case
> or environment. You are free to fork it, modify it, extend it, or adapt it to
> your own requirements.
>
> Use it as a starting point and make whatever changes are appropriate for your
> own setup and workflow.

## Features

* **AUTO** — automatically chooses LOCAL or ASTRA based on the current task
* **LOCAL** — always use the configured local model
* **ASTRA** — always use the configured ASTRA model
* Uses Pi's existing `/model` selector
* Slash commands for quick switching
* Von classifier integration for automatic routing decisions
* Deterministic fallback when Von is unavailable or cannot make a decision
* Automatic escalation after repeated failures
* Security-sensitive task detection
* Tracks tool errors and test failures
* Routing decisions can use task context and current session state
* Routing state persists across session compaction and restore
* Local-first routing policy
* No external routing service is required when Von is disabled

## How it works

`pi-router` adds a virtual `AUTO` model to Pi's existing model selector.

```text
                         ┌─────────────┐
                         │     Pi      │
                         └──────┬──────┘
                                │
                              /model
                                │
                         ┌──────▼──────┐
                         │  pi-router  │
                         └──────┬──────┘
                                │
                         ┌──────▼──────┐
                         │ AUTO Router │
                         └──────┬──────┘
                                │
                    ┌───────────▼───────────┐
                    │     Von Classifier    │
                    │                       │
                    │ task + routing state  │
                    │ + failure signals     │
                    └───────────┬───────────┘
                                │
                     ┌──────────┴──────────┐
                     │                     │
                   LOCAL                 ASTRA
                     │                     │
                     ▼                     ▼
                llama.cpp            OpenAI-compatible
                   server                provider
```

The `AUTO` entry is implemented as a virtual provider registered through Pi's `registerProvider()` API.

The virtual model is **inert**. It does not make LLM requests itself. Instead, `pi-router` intercepts the selection and switches Pi to the appropriate configured model.

### Routing flow

In AUTO mode, the router evaluates the current task and routing state.

The normal flow is:

```text
User input
    │
    ▼
pi-router
    │
    ├── Current mode?
    │       │
    │       ├── LOCAL → use LOCAL
    │       │
    │       ├── ASTRA → use ASTRA
    │       │
    │       └── AUTO
    │
    ▼
Routing decision
    │
    ├── Von classifier
    │      │
    │      └── LOCAL / ASTRA probabilities
    │
    ├── Local policy
    │
    └── Deterministic fallback
           │
           ▼
      LOCAL or ASTRA
```

Von is used as a lightweight classifier rather than as the model that performs the user's task.

The selected model then performs the actual work.

## Routing modes

| Mode    | Behavior                            |
| ------- | ----------------------------------- |
| `AUTO`  | Automatically choose LOCAL or ASTRA |
| `LOCAL` | Force the configured local model    |
| `ASTRA` | Force the configured ASTRA model    |

## AUTO routing

AUTO uses a local-first routing policy.

The router considers signals such as:

* Task description
* Architecture and design requirements
* Security-sensitive requirements
* Current model
* Number of attempts
* Tool errors
* Test failures
* Files changed
* Previous routing state
* Consecutive failures

### Von classifier

When Von is enabled, `pi-router` sends a compact routing snapshot to the configured Von endpoint.

Von evaluates the routing criteria and returns a classification containing probabilities and confidence for the available targets.

Conceptually:

```text
Routing snapshot
      │
      ▼
     Von
      │
      ├── LOCAL probability
      │
      ├── ASTRA probability
      │
      └── confidence
             │
             ▼
        Policy engine
             │
       ┌─────┴─────┐
       │           │
     LOCAL       ASTRA
```

The policy layer applies the configured threshold and requires ASTRA to have both sufficient probability and a higher probability than LOCAL before selecting it.

If the result is uncertain, the router falls back to LOCAL.

### Local-first policy

The routing policy is intentionally biased toward LOCAL for routine work.

Typical LOCAL work includes:

* Straightforward implementation
* Ordinary coding tasks
* Existing patterns
* Simple file changes
* Routine tool usage
* Tasks that do not require deeper architectural reasoning

ASTRA may be selected for signals such as:

* Difficult architecture or system design
* Complex reasoning
* Security-sensitive work
* Ambiguous requirements
* Repeated failures
* Repeated test failures
* Repeated tool errors
* Diagnosis that LOCAL has not successfully resolved

The router does not select ASTRA simply because a task involves coding, multiple files, or ordinary debugging.

### Deterministic fallback

Von is not required for the router to remain functional.

If Von is disabled, unavailable, times out, or returns an unusable decision, `pi-router` falls back to its deterministic routing policy.

The fallback also includes hard escalation when the current model has accumulated **three consecutive failures**.

This keeps routing functional even when the classifier service is unavailable.

## Von — External Optional Dependency

**Von is a separate open-source project and is not owned, developed, or distributed by SiamLabs.**

`pi-router` integrates with Von as an optional external classifier.

Von is maintained separately:

**Von:** https://github.com/wfzyx/von

Von must be **installed and run separately** if you want to use Von-based AUTO classification.

The `pi-router` repository does **not** include:

* Von itself
* Von's server implementation
* Von model weights
* Von's Python environment
* Von installation dependencies

Installing `pi-router` does **not** install Von.

The relationship is:

```text
┌─────────────────────────┐
│       pi-router         │
│                         │
│  AUTO routing logic     │
│  policy + state         │
└────────────┬────────────┘
             │
             │ HTTP
             ▼
┌─────────────────────────┐
│          Von            │
│                         │
│ External classifier     │
│ Separate installation   │
└────────────┬────────────┘
             │
             │ classification
             ▼
       LOCAL / ASTRA
```

Von provides the classification used by AUTO routing. `pi-router` remains responsible for:

* Routing policy
* Probability threshold handling
* Fallback behavior
* Failure escalation
* Routing state
* Session persistence
* Switching Pi's active model

### Installing Von

Install and run Von separately by following the official Von project documentation:

https://github.com/wfzyx/von

Von's installation and runtime requirements are maintained by the Von project and may change independently of `pi-router`.

## Failure handling

The router tracks model failures and distinguishes between different failure signals.

Tracked signals include:

* Consecutive failures
* Tool errors
* Test failures
* Context-window overflow
* Files changed
* Attempts

After **three consecutive model failures**, the router escalates to the other configured target.

Context-window overflow is treated separately and does not automatically count as an ordinary model failure.

A successful turn resets the consecutive failure streak.

## Commands

| Command   | Description                |
| --------- | -------------------------- |
| `/auto`   | Enable automatic routing   |
| `/local`  | Force the local model      |
| `/astra`  | Force the ASTRA model      |
| `/router` | Show current router status |

Manual LOCAL and ASTRA selections are respected and are not automatically overridden by AUTO routing.

`/auto` changes the routing mode. The next task is then evaluated by the router.

## Model selector

The router integrates with Pi's existing `/model` selector.

After installation, the selector contains:

```text
AUTO
LOCAL
ASTRA
...
```

Selecting AUTO, LOCAL, or ASTRA updates the same router state used by the slash commands.

The router-generated model changes are distinguished from user selections so that internal routing does not incorrectly change the user's selected routing mode.

## Configuration

Before using the extension, configure your model providers normally in Pi.

The router does not provision model backends.

### LOCAL

A local OpenAI-compatible server such as llama.cpp can expose:

```text
http://127.0.0.1:1234/v1
```

Configure the corresponding local provider in Pi.

A local provider does not require an external API key when using a local server configured without authentication.

### ASTRA

Configure your ASTRA/OpenAI-compatible provider normally in Pi.

The production router uses:

```text
gpt-6-astra
```

as the ASTRA model identifier.

You must provide your **own API credentials** for the ASTRA provider.

`pi-router` does not:

* provide API keys
* generate API keys
* store API keys
* distribute API keys
* require you to place an API key in the `pi-router` source code

Configure the API key through Pi's normal provider configuration.

Conceptually:

```text
Provider: OpenAI
API key: <your own API key>
Model: gpt-6-astra
```


If your Pi configuration uses a different provider or model identifier, configure the provider in Pi and update the router's ASTRA model identifier accordingly.

### Von

Von is optional and must be installed separately.

The generic Von endpoint is:

```text
http://127.0.0.1:8100
```

A public configuration can keep Von disabled until a Von server is available.

Example:

```json
{
  "url": "http://127.0.0.1:8100",
  "enabled": false
}
```

When Von is enabled, `pi-router` uses it as the routing classifier.

Von does not perform the actual user task.

## Installation

### 1. Clone the repository

```bash
git clone <repository-url>
cd pi-router
```

### 2. Configure your model providers

Configure your LOCAL provider normally in Pi.

Configure your ASTRA/OpenAI-compatible provider in Pi and provide **your own API key** through Pi's provider configuration.

Do not put your API key in the `pi-router` source code.

If you want Von-based AUTO classification, install and run Von separately according to the official Von documentation:

https://github.com/wfzyx/von

### 3. Add the extension to Pi

Add the extension directory to your Pi settings:

```json
{
  "extensions": [
    "/path/to/pi-router/router"
  ]
}
```

On Windows, for example:

```json
{
  "extensions": [
    "C:/path/to/pi-router/router"
  ]
}
```

Use your own local path here.

### 4. Configure Von if desired

If Von is installed and running, configure `router/von.config.json` with the appropriate Von endpoint.

Von is optional. AUTO routing remains available without it through the router's deterministic fallback policy.

### 5. Restart or reload Pi

Reload the extensions or restart Pi.

### 6. Open the model selector

Run:

```text
/model
```

You should see the `AUTO` entry alongside your existing models.

## State & persistence

Routing state is kept in memory while Pi is running.

The extension also stores its routing state as a Pi custom session entry so it can survive:

* Session compaction
* Rollback
* Session restoration

Stored routing metadata includes:

* Current mode
* Current target
* Failure counters
* Decision counters
* Switch history
* Last routing decision
* Attempts
* Tool errors
* Test failures
* Files changed
* Security-sensitive state

User prompts are **not stored by `pi-router` as part of this routing state**.

## Status

Use:

```text
/router
```

to display the current state.

Example:

```text
Router: AUTO → ASTRA
(decisions 12, switches 4, failures 3, last: Von selected ASTRA)
```

## Development

The extension is intentionally self-contained.

Main source:

```text
router/

├── index.ts
├── von.ts
├── von.config.json
├── README.md
└── VON_INTEGRATION.md
```

Tests use a mock Pi extension API covering functionality such as:

* `registerProvider`
* `on`
* `registerCommand`
* `setModel`
* `sendMessage`
* `appendEntry`

Run all tests:

```bash
bun _run.ts
```

Run an individual test:

```bash
bun _run.ts 3
```

## Architecture

The router has three distinct responsibilities:

```text
┌───────────────────────────────────────┐
│                 Pi                    │
│                                       │
│  Model selector + extension lifecycle │
└───────────────────┬───────────────────┘
                    │
                    ▼
┌───────────────────────────────────────┐
│              pi-router                │
│                                       │
│  State + policy + model switching     │
└───────────────────┬───────────────────┘
                    │
                    ▼
┌───────────────────────────────────────┐
│                 Von                   │
│                                       │
│       External routing classifier     │
└───────────────────┬───────────────────┘
                    │
              LOCAL / ASTRA
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
       llama.cpp             ASTRA
```

This separation is intentional:

* **Pi** owns the agent session and model configuration.
* **pi-router** owns routing state, policy, fallback, and model switching.
* **Von** performs routing classification when enabled.
* **LOCAL/ASTRA** perform the actual user task.

## Limitations

### External classifier dependency

When Von is enabled, AUTO routing can use Von for classification.

Von is an optional external dependency and must be installed separately.

If Von is unavailable or cannot provide a usable decision, the router uses its deterministic fallback policy.

### Routing is not task execution

Von is a classifier. It does not replace the selected LLM and does not perform the user's coding or agent task.

### Classification is not perfect

Routing decisions are based on the available task and session signals. Ambiguous tasks may still be classified incorrectly.

### Failure escalation

Three consecutive failures trigger escalation to the other target.

This provides a deterministic recovery mechanism without switching models after every transient failure.

### Existing providers required

`pi-router` does not provision or configure model backends.

Your LOCAL and ASTRA providers must already be configured and available in Pi.

## Privacy

`pi-router` does not contain hard-coded API keys, credentials, usernames, or machine-specific paths.

The extension itself does not persist user prompts as routing state.

When Von is enabled, routing information is sent to the configured Von endpoint for classification.

The router sends a compact routing snapshot rather than the full conversation.

Your ASTRA API key is managed through Pi's provider configuration and should never be committed to the `pi-router` repository.

Model requests are still subject to the privacy and logging behavior of the provider handling the request.

## License

Add your preferred license here.
