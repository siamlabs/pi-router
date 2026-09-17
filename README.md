# pi-router

Automatic model routing for [Pi](https://github.com/badlogic/pi-mono) through a lightweight Pi extension.

`pi-router` lets you use a **local model**, a **remote model**, or let Pi **automatically choose between them per turn**.

It works through Pi's existing `/model` selector and does not replace or hide it.

## Features

* **AUTO** — automatically chooses LOCAL or REMOTE based on the task
* **LOCAL** — always use your local model
* **REMOTE** — always use your configured remote model
* Uses Pi's existing `/model` selector
* Slash commands for quick switching
* Automatic fallback after repeated tool failures
* Routing state persists across session compaction and restore
* Lightweight keyword-based routing policy
* Self-contained extension with no external service required

## How it works

`pi-router` adds a virtual `AUTO` model to Pi's existing model selector.

```text
                    ┌─────────────┐
                    │      Pi     │
                    └──────┬──────┘
                           │
                       /model
                           │
                    ┌──────▼──────┐
                    │  pi-router  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
            AUTO         LOCAL        REMOTE
              │            │            │
              ▼            ▼            ▼
           Router       llama.cpp    OpenAI-compatible
           decides       server        provider
```

The `AUTO` entry is implemented as a virtual provider registered through Pi's `registerProvider()` API.

The virtual model is **inert**. It does not make LLM requests itself. Instead, `pi-router` intercepts the selection and switches Pi to the appropriate configured model.

## Routing modes

| Mode     | Behavior                             |
| -------- | ------------------------------------ |
| `AUTO`   | Choose LOCAL or REMOTE for each turn |
| `LOCAL`  | Force the configured local model     |
| `REMOTE` | Force the configured remote model    |

### AUTO routing

The default routing policy is intentionally simple and easy to modify.

#### 1. Repeated failures

If the current model encounters **two consecutive tool failures**, the router switches to the other backend.

A successful tool call resets the failure counter.

#### 2. Task classification

The router looks for simple keywords in the incoming task.

**Architecture / reasoning signals**

Examples:

```text
architecture
design
refactor
performance
tradeoff
pattern
schema
system design
compare
evaluate
```

These currently route to `REMOTE`.

**Implementation signals**

Examples:

```text
implement
fix
add
build
test
bug
run
execute
quick
```

These currently route to `LOCAL`.

#### 3. No clear signal

If neither category produces a clear signal, the router keeps the previous target.

If there is no previous target, it defaults to `LOCAL`.

The policy is implemented by:

```text
classifyTask()
decideTarget()
```

You can modify the `ARCHITECTURE_HINTS` and `IMPLEMENTATION_HINTS` arrays in `index.ts` to fit your workflow.

## Commands

| Command   | Description                       |
| --------- | --------------------------------- |
| `/auto`   | Enable automatic routing          |
| `/local`  | Force the local model             |
| `/astra`  | Force the configured remote model |
| `/router` | Show the current router status    |

Force commands wait until the agent is idle before switching models.

## Model selector

The router also integrates with Pi's existing `/model` selector.

After installation, the selector contains:

```text
AUTO
LOCAL
REMOTE
...
```

Selecting a mode from the selector and using the corresponding slash command update the same router state.

## Configuration

Before using the extension, configure your local and remote providers normally in Pi.

For example, a local llama.cpp server might expose:

```text
http://127.0.0.1:1234/v1
```

The router does **not** start llama.cpp, configure API credentials, or provision remote models.

It only switches between models that are already available to Pi.

### Remote model

Set the remote model in `index.ts`:

```ts
const MODEL_ASTRA = "your-remote-model";
```

You can rename the constant if you prefer a different name such as `MODEL_REMOTE`.

## Installation

### 1. Clone the repository

```bash
git clone <repository-url>
cd pi-router
```

### 2. Add the extension to Pi

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
    "E:/path/to/pi-router/router"
  ]
}
```

Use your own local path here.

### 3. Restart or reload Pi

Reload the extensions or restart Pi.

### 4. Open the model selector

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

The stored state contains routing metadata such as:

* Current mode
* Current target
* Failure counters
* Decision counters
* Switch history
* Last routing decision

User prompts are **not stored by `pi-router` as part of this routing state**.

## Status

Use:

```text
/router
```

to display the current state.

Example:

```text
Router: AUTO → REMOTE
(decisions 12, switches 10, failures 3, last: remote architecture/design signals)
```

## Development

The extension is intentionally self-contained.

Main source:

```text
router/
└── index.ts
```

Tests use a mock Pi extension API covering:

* `registerProvider`
* `on`
* `registerCommand`
* `setModel`
* `sendMessage`
* `appendEntry`

Run all tests:

```bash
cd router
bun _run.ts
```

Run an individual test:

```bash
bun _run.ts 3
```

## Limitations

### Heuristic routing

AUTO currently uses keyword-based classification rather than an LLM classifier.

This keeps routing:

* Fast
* Local
* Predictable
* Cheap
* Easy to modify

However, keyword routing can misclassify ambiguous tasks.

### Failure threshold

The fallback mechanism requires two consecutive tool failures before switching models. This is intentional to reduce unnecessary model switching caused by transient failures.

### Existing providers required

`pi-router` does not provision or configure model backends.

Your LOCAL and REMOTE providers must already be configured and available in Pi.

## Privacy

`pi-router` does not contain hard-coded API keys, credentials, usernames, or machine-specific paths.

The extension itself does not persist user prompts as routing state.

Model requests are still subject to the privacy and logging behavior of the provider handling the request.

## License

Add your preferred license here.
