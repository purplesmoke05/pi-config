# pi-ollama-cloud-provider

Ollama Cloud provider extension for [pi](https://github.com/badlogic/pi-mono) coding agent with dynamic model discovery.

[![npm version](https://img.shields.io/npm/v/pi-ollama-cloud-provider.svg)](https://www.npmjs.com/package/pi-ollama-cloud-provider)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pi-package](https://img.shields.io/badge/pi--package-yes-brightgreen)](https://pi.dev/packages)

## Features

- **Dynamic model discovery** — fetches all available Ollama Cloud models at startup
- **Interactive management** — `/ollama-cloud` menu for refresh, status, and cache inspection
- **Persistent cache** — model details cached for 1 hour for instant subsequent startups
- **Capability detection** — reasoning (thinking) and vision support from `/api/show`
- **Reasoning effort control** — maps models.dev `reasoning_options` to pi thinking levels, so effort-tier models (e.g. GLM-5.2's `high`/`max`) expose a real `high`↔`xhigh` picker and send `reasoning_effort` to the API. Toggle-only models keep legacy behavior.
- **Accurate context windows** — extracted from model metadata, not hardcoded
- **Fallback chain** — when `/api/show` fails, resolves from models.dev or name inference
- **Source tracking** — cache records where each model's metadata came from
- **Zero-cost tracking** — Ollama Cloud uses flat subscription pricing
- **OpenAI-compatible** endpoint via `openai-completions` API

## Installation

```bash
# npm (recommended — versioned, respects pi update)
pi install npm:pi-ollama-cloud-provider

# git (bleeding edge — always pulls main)
pi install git:github.com/mario-gc/pi-ollama-cloud-provider

# local path (development)
pi install /path/to/pi-ollama-cloud-provider
```

## Quick Start

### 1. Get an API key

Sign up at [ollama.com](https://ollama.com) and generate an API key from your account settings.

### 2. Configure the API key

**Option A:** Set the environment variable:
```bash
export OLLAMA_CLOUD_API_KEY="your-key"
```

**Option B:** Add to `~/.pi/agent/auth.json`:
```json
{
  "ollama-cloud": {
    "type": "api_key",
    "key": "your-key"
  }
}
```

### 3. Select a model

Start pi and use `/model`, `Ctrl+P` (cycle), or `Ctrl+L` (list) to select an Ollama Cloud model. All available models appear under the `ollama-cloud` provider.

## Available Models

Models are fetched dynamically from the Ollama Cloud API at startup. All available models are registered with accurate context windows and capability detection (reasoning, vision).

Run `pi --list-models | grep ollama-cloud` to see the full list.

The catalog includes models from various families: GLM, Qwen, DeepSeek, Kimi, GPT OSS, MiniMax, Gemma, Mistral, Nemotron, Cogito, Gemini, and more.

## Commands

### `/ollama-cloud`

Opens an interactive TUI menu with the following options:

| Option | Description |
|--------|-------------|
| **Refresh Models** | Submenu to update model list |
| **Status** | View connection info, source breakdown, and cache status |
| **Cache Info** | Cache age, size, and model count |

#### Refresh Models Submenu

| Option | Description |
|--------|-------------|
| **From Ollama API** | Fetches `/api/show` for all models, falls back to models.dev if needed (default) |
| **From models.dev** | Bypasses `/api/show`, uses models.dev metadata directly for all models |

After refresh, the menu shows the source breakdown: e.g., `Registered 39 models (28 ollama, 10 modelsdev, 1 inference)`.

#### Status Submenu

Displays:
- Total registered models
- Source breakdown (how many models from Ollama API, models.dev, or inference)
- API endpoint URL
- Cache status (age, size, model count)
- Cache TTL (1 hour)

## How it Works

### Discovery Flow

On first startup (or when cache expires):

1. **Fetch model IDs** — `GET https://ollama.com/v1/models` returns all available model IDs
2. **Fetch per-model details** — `POST https://ollama.com/api/show` for each model (parallel, 10s timeout each)
3. **Extract metadata** — context length from `model_info.*.context_length`, capabilities from `capabilities` array
4. **Register provider** — all models registered with pi under the `ollama-cloud` provider
5. **Write cache** — results cached to `~/.pi/agent/cache/ollama-cloud/models.json`

### Fallback Chain

If `/api/show` fails for a model (network issue, rate limit, new model not yet indexed), metadata is resolved through:

1. **https://models.dev/api.json** — fetches the `ollama-cloud` section (cached separately for 24h). Only fetched when at least one model fails `/api/show`.
2. **Name-based inference** — pattern matching on model ID (e.g., `kimi-*` → 262K context, reasoning enabled)
3. **Safe defaults** — 128K context, 32K max output, text-only, no reasoning

All fallback metadata uses zero cost since Ollama Cloud uses flat subscription pricing, not per-token billing.

### Cache

| File | TTL | Purpose |
|------|-----|---------|
| `~/.pi/agent/cache/ollama-cloud/models.json` | 1 hour | Raw `/api/show` responses per model |
| `~/.pi/agent/cache/ollama-cloud/models-dev.json` | 24 hours | Full models.dev `ollama-cloud` section |

Each cache entry tracks its source: `ollama` (from `/api/show`), `modelsdev` (from models.dev), or `inference` (name-based).

### Refresh Sources

The `/ollama-cloud` menu lets you choose the refresh source:

- **From Ollama API** — hits `/api/show` for all models, uses fallback chain for failures. Most accurate but slowest.
- **From models.dev** — bypasses `/api/show` entirely, uses models.dev metadata for all models. Fast, but may lack the latest models.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OLLAMA_CLOUD_API_KEY` | Ollama Cloud API key | *(required)* |
| `PI_CODING_AGENT_DIR` | Custom pi agent directory | `~/.pi/agent` |
| `PI_OLLAMA_CLOUD_NO_EFFORT` | Set to `1` to disable `reasoning_effort` control and restore legacy behavior (no effort param sent). Useful if a provider rejects the field. | unset |

### API Key Resolution

The extension resolves the API key in this order:
1. Environment variable `OLLAMA_CLOUD_API_KEY`
2. `~/.pi/agent/auth.json` entry for `ollama-cloud`
3. pi's built-in auth storage

## Troubleshooting

### No models appear under ollama-cloud

1. Check your API key is set: `echo $OLLAMA_CLOUD_API_KEY`
2. Run `/ollama-cloud` → **Status** to verify connectivity
3. Try **Refresh Models** → **From Ollama API**
4. Check pi's logs for error messages

### Cache not working

1. Check cache directory exists: `ls -la ~/.pi/agent/cache/ollama-cloud/`
2. Delete cache to force fresh fetch: `rm -rf ~/.pi/agent/cache/ollama-cloud/`
3. Restart pi

### Models show incorrect context window

Context windows come from `/api/show` (primary) or models.dev (fallback). If you see unexpected values:
1. Run **Refresh Models** → **From Ollama API** to get fresh data
2. Check the **Status** submenu for source breakdown

### "400 developer is not one of ['system', 'assistant', 'user', 'tool']" error

Some Ollama Cloud models may reject the `developer` message role. The extension sets `compat.supportsDeveloperRole: false` at the provider level to prevent this. If you still see this error, report it as an issue.

### Models reject `reasoning_effort` (400 / unknown field)

Effort-tier models send `reasoning_effort` based on models.dev's `reasoning_options`. If a provider rejects that field, disable effort control globally:

```bash
export PI_OLLAMA_CLOUD_NO_EFFORT=1
```

This restores legacy behavior (no `reasoning_effort` sent; pi shows the default `off`..`high` levels but the model runs at its own default intensity). Toggle-only reasoning models are unaffected either way.

## How is this different from `ollama launch pi`?

[`ollama launch pi`](https://docs.ollama.com/integrations/pi) is Ollama's built-in one-command setup that configures pi to talk to your **local Ollama server**. This extension takes a different approach: it connects pi **directly** to Ollama Cloud's hosted API at `ollama.com`.

| | `ollama launch pi` | `pi-ollama-cloud-provider` |
|---|---|---|
| **Provider name** | `ollama` | `ollama-cloud` |
| **Endpoint** | Local Ollama server (`http://localhost:11434/v1`) | Ollama Cloud (`https://ollama.com/v1`) |
| **Local models** | Yes | No |
| **Cloud models** | Proxied through local server | Connected directly |
| **Local Ollama required?** | Yes | No |
| **Authentication** | Handled by local server | Ollama Cloud API key |
| **Model discovery** | `ollama launch pi` or `--model qwen3.5:cloud` | Dynamic — fetches all available cloud models |
| **Use when** | You're running Ollama locally and want the default experience | You want direct cloud access without a local server |

**You can use both at the same time.** The providers live under different names, so you can switch between them with `/model`, `Ctrl+P`, or `Ctrl+L`.

## Contributing

Contributions are welcome! Please open an issue or pull request on [GitHub](https://github.com/mario-gc/pi-ollama-cloud-provider).

### Development

```bash
# Clone the repo
git clone https://github.com/mario-gc/pi-ollama-cloud-provider.git
cd pi-ollama-cloud-provider

# Install dependencies
npm install

# Test locally
pi install /path/to/pi-ollama-cloud-provider
```

### Project structure

```
├── extensions/
│   └── ollama-cloud/
│       ├── index.ts        # Entry point, command registration, main menu
│       ├── discovery.ts    # API fetch, model assembly, provider registration
│       ├── cache.ts        # Persistent cache with TTL and source tracking
│       ├── fallback.ts     # models.dev fetch, name inference
│       └── menu.ts         # Interactive TUI menu with SettingsList
├── package.json            # pi package manifest + release-it config
├── CHANGELOG.md            # Auto-generated by release-it
└── README.md               # This file
```

## License

MIT
