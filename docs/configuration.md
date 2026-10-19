# Configuration

**What this covers:** where configuration lives, how project and global files
combine, and every field IMURUN reads — its type and its default. The schema is
`packages/schema/src/config.ts`, and these tables mirror it.

## Where config lives

IMURUN reads JSON (or JSONC) configuration from two scopes. Project config
overrides global config, and a closer project directory overrides a more distant
one:

1. **Global** — `~/.imurun/imurun.json` (or `imurun.jsonc`).
2. **Project** — `imurun.json` or `imurun.jsonc` in the working directory or
   `.imurun/`, and in every ancestor directory up to the filesystem root. This
   is scanned from the root down, so a config closest to the working directory
   wins and a package inherits its repository-level config.

If no config file exists, IMURUN runs on the defaults below. You do not need a
config file to use IMURUN.

Environment variables that affect behaviour:

| Variable | Effect |
| --- | --- |
| `IMURUN_HOME` | Root of all IMURUN state (default `~/.imurun`). |
| `IMURUN_LLAMA_VARIANT` | Prefer a specific llama.cpp build: `auto`, `vulkan`, `cuda`, `rocm`, `metal`, `cpu`. |
| `GITHUB_TOKEN` | Sent when the engine installer queries GitHub releases, to avoid rate limits. |
| Provider key variables | e.g. `OPENAI_API_KEY`; referenced from a provider as `{env:OPENAI_API_KEY}`. See [Providers](providers.md). |

## Top-level fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `$schema` | string | — | Optional JSON-schema hint for editors. |
| `model` | string | — | Default model id, e.g. `qwen2.5-coder-7b`. |
| `smallModel` | string | — | Small fast model for titles and summaries. |
| `reasoningEffort` | `low` \| `medium` \| `high` \| `max` | — | Thinking budget sent to providers that accept one. |
| `providers` | map | `{}` | Provider definitions keyed by id. |
| `runtime` | object | see below | Local inference runtime settings. |
| `memory` | object | see below | Memory behaviour. |
| `rag` | object | see below | Project index behaviour. |
| `tui` | object | see below | Interface appearance. |
| `web` | object | see below | Web search and fetch behaviour. |
| `permissions` | object | see below | Approval mode and rules. |
| `disabledTools` | string[] | `[]` | Tool names disabled entirely for this project. |
| `instructions` | string[] | `[]` | Extra instructions appended to the system prompt. |

### `reasoningEffort`

`max` is deliberately the same knob as `high` on most APIs; it means "do not hold
back" rather than a separately-defined level, so sending it is safe everywhere
`high` works. The value is only sent when the provider takes one (see
[Providers](providers.md#reasoning-effort)).

## `runtime`

Settings for the local inference daemon. See [Runtime](runtime.md).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `engine` | `llama-cpp` \| `ollama` | `llama-cpp` | Which engine to use. |
| `engineVariant` | `auto` \| `vulkan` \| `cuda` \| `rocm` \| `metal` \| `cpu` | `auto` | Which llama.cpp build to install; `auto` picks the best fit for the hardware, with automatic fallback. |
| `port` | integer (1024–65535) | `42425` | Local OpenAI-compatible port. |
| `idleUnloadMinutes` | integer ≥ 0 | `10` | Unload the model after this many idle minutes; `0` never. |
| `shutdownGraceSeconds` | integer ≥ 0 | `30` | Keep the server alive after the last session ends. |
| `threads` | integer ≥ 0 | `0` | CPU threads for inference; `0` is auto (half the cores). |
| `gpuLayers` | integer | `-1` | GPU layers to offload; `-1` all (auto), `0` CPU only. |
| `contextSize` | integer ≥ 0 | `0` | Context window override; `0` uses the model's trained window. |
| `ropeScaling` | `auto` \| `none` \| `linear` \| `yarn` | `auto` | RoPE scaling to reach past the trained window. |
| `ropeScale` | number ≥ 0 | `0` | Explicit context-extension factor; `0` derives it. |
| `flashAttention` | boolean | `true` | Pass `--flash-attn auto` to llama.cpp. |
| `speculativeDecoding` | boolean | `false` | Opt into speculative decoding when a draft model is available. |

## `memory`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch for memory. |
| `learnStyle` | boolean | `true` | Learn coding style from edits and generations. |
| `crossSession` | boolean | `true` | Recall relevant summaries from past sessions. |
| `autoSummarize` | boolean | `true` | Summarize sessions automatically on close. |
| `maxRecallEntries` | integer > 0 | `5` | How many recalled memories to include. |

See [Memory](memory.md).

## `rag`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch for the project index. |
| `watch` | boolean | `true` | Watch project files and re-index incrementally. |
| `autoInject` | boolean | `true` | Automatically inject retrieved context into prompts. |
| `maxInjectChunks` | integer > 0 | `6` | Maximum chunks injected per prompt. |
| `chunkSize` | integer > 0 | `800` | Target chunk size. |
| `chunkOverlap` | integer ≥ 0 | `120` | Overlap between chunks. |
| `maxFileSizeKB` | integer > 0 | `1024` | Skip files larger than this. |
| `excludeGlobs` | string[] | `node_modules/**`, `.git/**`, `dist/**`, `build/**`, `out/**`, `*.min.*`, `*.lock` | Paths excluded from the index. |
| `embeddingModel` | string | `all-MiniLM-L6-v2` | Embedding model name (configuration surface). |

See [RAG](rag.md).

## `tui`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `theme` | string | `imurun-dark` | Theme name. |
| `showRagSources` | boolean | `true` | Show RAG source indicators on messages. |
| `showMemoryUsage` | boolean | `true` | Show memory usage indicators on messages. |

## `web`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `searchBackend` | `duckduckgo` \| `brave` \| `searxng` | `duckduckgo` | Search backend; `duckduckgo` needs no key. |
| `searxngURL` | string | — | Base URL when the backend is `searxng`. |
| `cacheFetches` | boolean | `true` | Cache fetched pages for later reuse. |
| `maxPageKB` | integer > 0 | `2048` | Maximum page size to fetch. |

The web tools themselves are described in [Tools](tools.md#web-search-and-web-fetch).

## `permissions`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `manual` \| `auto` \| `readonly` | `auto` | How tool calls are approved. |
| `rules` | array of rules | `[]` | Explicit allow/ask/deny rules. |

A rule has:

| Field | Type | Meaning |
| --- | --- | --- |
| `tool` | string | Tool name, or `*` for all tools. |
| `pattern` | string | Optional: a file path for filesystem tools, or a command prefix for `shell`. A trailing `*` means "starts with". |
| `action` | `allow` \| `ask` \| `deny` | What to do when the rule matches. |
| `source` | `config` \| `saved` \| `session` | Where the rule came from (default `config`). |

See [Permissions](permissions.md) for the full decision order.

## A worked example

```jsonc
{
  "$schema": "https://imutechz.in/imurun.schema.json",
  "model": "qwen2.5-coder-7b",
  "smallModel": "qwen2.5-coder-1.5b",
  "runtime": {
    "contextSize": 16384,
    "idleUnloadMinutes": 20,
    "threads": 8
  },
  "permissions": {
    "mode": "manual",
    "rules": [
      { "tool": "shell", "pattern": "git status*", "action": "allow" },
      { "tool": "shell", "pattern": "rm *", "action": "deny" }
    ]
  },
  "rag": {
    "excludeGlobs": ["node_modules/**", ".git/**", "dist/**", "fixtures/**"]
  },
  "instructions": ["Prefer pnpm over npm in this repository."]
}
```

## Credentials

Do not paste API keys into project config you intend to commit. Use the
`{env:VAR}` form in `providers`, or add providers through `imurun providers add`
or `/provider`, which writes them to the global config under `~/.imurun`. This
documentation never contains real keys or tokens.
