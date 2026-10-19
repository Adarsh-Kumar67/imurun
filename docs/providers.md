# Providers

**What this covers:** how IMURUN talks to model services — the difference between
local and online providers, the 11 built-in presets, how to add and remove them,
how to point IMURUN at any OpenAI-compatible endpoint, and how the reasoning
effort setting is transmitted. Local models are covered in
[Models](models.md); the daemon that serves them is in [Runtime](runtime.md).

## Local by default, online by choice

IMURUN's provider registry holds two kinds of provider:

- **local** — the built-in engines, `llama-cpp` and `ollama`. These are the
  default. They are configured by the runtime settings, not by a key.
- **api** — an online service. These are optional; you add one only if you want
  to use a cloud model.

You can mix them. A model reference like `local/qwen2.5-coder-7b` goes to the
local runtime, while `groq/llama-3.3-70b-versatile` goes to the Groq provider.
The setup wizard lets you choose either path on first run.

## Built-in presets

```
imurun providers presets
```

| Id | Label | Style | Endpoint | Key variable | Where to get a key |
| --- | --- | --- | --- | --- | --- |
| `openai` | OpenAI | native | `https://api.openai.com/v1` | `OPENAI_API_KEY` | platform.openai.com/api-keys |
| `anthropic` | Anthropic | native | — | `ANTHROPIC_API_KEY` | console.anthropic.com/settings/keys |
| `google` | Google Gemini | native | — | `GEMINI_API_KEY` | aistudio.google.com/apikey |
| `openrouter` | OpenRouter | native | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | openrouter.ai/keys |
| `groq` | Groq | native | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | console.groq.com/keys |
| `nvidia` | NVIDIA NIM | OpenAI-compatible | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` | build.nvidia.com/settings/api-keys |
| `deepseek` | DeepSeek | OpenAI-compatible | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | platform.deepseek.com/api_keys |
| `mistral` | Mistral | OpenAI-compatible | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | console.mistral.ai/api-keys |
| `xai` | xAI | OpenAI-compatible | `https://api.x.ai/v1` | `XAI_API_KEY` | console.x.ai |
| `together` | Together AI | OpenAI-compatible | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` | api.together.ai/settings/api-keys |
| `custom` | Other (OpenAI-compatible) | OpenAI-compatible | you supply it | you supply it | — |

"NVIDIA NIM", "DeepSeek", "Mistral", "xAI", and "Together AI" are configured as
OpenAI-compatible (`custom` type) endpoints. The only preset that does not
require a key is `custom`; every other preset prompts for one.

A preset is a starting point. Each provider's own `/models` endpoint is the
source of truth once the provider answers; the model list a preset shows is only
a hint for the moment a key is being added.

## Adding a provider from the CLI

```
imurun providers add <preset> --key <k> [--url <u>] [--model <m>]
```

| Option | Description |
| --- | --- |
| `--key` | The API key, or an `{env:VAR}` reference. |
| `--url` | Endpoint, required for the `custom` preset (or to override one). |
| `--model` | Remember this model as the active one. |

```bash
imurun providers add groq --key "{env:GROQ_API_KEY}"
imurun providers add openai --key sk-... --model gpt-5.1
imurun providers add custom --url http://127.0.0.1:8000/v1 --key local
```

Adding always writes to the global config (`~/.imurun/imurun.json`), so the key is
not stored in a project that might be committed. When `--model` is given, the
global `model` is set to `<provider>/<model>`.

Using an `{env:VAR}` reference keeps the literal secret out of the config file
entirely; IMURUN reads it from the environment when the provider is used.

## Adding a provider from the interface

```
/provider            # picker; then a short wizard
/provider list       # configured providers and their state
/provider remove <id>
```

The wizard asks for the key, then optionally a URL, then a model, and `Esc` steps
back one question at a time. The model list prefers whatever the provider is
actually serving, falling back to the preset's curated hints when it cannot be
reached.

## Listing providers

```
imurun providers
```

Each line shows a readiness badge:

| Badge | Meaning |
| --- | --- |
| `● ready` | The provider answered and its models are available. |
| `○ unreachable` | Configured, but the endpoint could not be reached. |
| `○ disabled` | Present but disabled. |
| `● <status>` | Another error state, shown in red. |

Each provider is tagged `[local]` or `[api]`, followed by its type, and its
models are listed (up to six). Reachability is checked live, so it is normal for
this to take a moment.

## Removing a provider

```bash
imurun providers remove groq
```

This deletes the provider from the global config. It does not touch any local
models or the runtime.

## Reasoning effort

Some providers accept a "thinking budget". IMURUN sends the configured
`reasoningEffort` only when the provider takes one — for an API provider whose
type is not one of the providers that expose their own reasoning controls. On a
provider that does not accept a reasoning effort, the setting is remembered but
not transmitted, so it never breaks a request.

The four levels are `low`, `medium`, `high`, and `max`. `max` is deliberately the
same knob as `high` on most APIs; it means "do not hold back" rather than a
separate level. If a provider rejects the value, IMURUN steps it down
(`max` → `high` → off) instead of failing the turn. Set it with `/effort` in the
interface or with `reasoningEffort` in config.

## Custom endpoints

The `custom` preset is for any endpoint that speaks the OpenAI API — a gateway, a
proxy, or a self-hosted server. It is the only preset without a built-in URL:

```bash
imurun providers add custom --url http://127.0.0.1:8000/v1 --key local
```

A local server often accepts any non-empty key, so a placeholder is fine there.

## Where providers are stored

Providers live in the `providers` map of the config, keyed by id. Each entry has
an id, a kind (`local` or `api`), a type, a base URL where relevant, an API key
or `{env:VAR}` reference, a list of models, and an enabled flag. See
[Configuration](configuration.md) and [Configuration](configuration.md#top-level-fields).
