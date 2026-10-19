# Models

**What this covers:** the 16-model catalog that ships with IMURUN, how it decides
which models and quantizations fit your machine, how it ranks recommendations,
and how to install, inspect, and remove models from the CLI or the interface.
For the mechanics of detection and downloading, see
[Local models](local-models.md).

## Local first

IMURUN's default is to run a model on your own hardware. The catalog is static
data, so `imurun models` and `imurun models recommend` work fully offline; the
network is touched only when you actually install something. You can add an
online provider instead, but nothing requires you to. See
[Providers](providers.md).

## The bundled catalog

Each model ships with ready-to-download GGUF quantizations from Hugging Face.
Sizes are estimated from the parameters and the quantization, plus about 15% of
GGUF container overhead, which lands within roughly 5% of the published files.

| Id | Name | Params | Context | Coding | Tools | Vision | License |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `qwen2.5-coder-1.5b` | Qwen2.5 Coder 1.5B | 1.5B | 32k | 45 | yes | no | apache-2.0 |
| `qwen2.5-coder-7b` | Qwen2.5 Coder 7B | 7B | 32k | 68 | yes | no | apache-2.0 |
| `qwen2.5-coder-14b` | Qwen2.5 Coder 14B | 14B | 32k | 78 | yes | no | apache-2.0 |
| `qwen2.5-coder-32b` | Qwen2.5 Coder 32B | 32B | 32k | 88 | yes | no | apache-2.0 |
| `qwen3-4b` | Qwen3 4B | 4B | 40k | 55 | yes | no | apache-2.0 |
| `qwen3-8b` | Qwen3 8B | 8B | 40k | 66 | yes | no | apache-2.0 |
| `qwen3-14b` | Qwen3 14B | 14B | 40k | 76 | yes | no | apache-2.0 |
| `qwen3-32b` | Qwen3 32B | 32B | 40k | 85 | yes | no | apache-2.0 |
| `deepseek-coder-v2-lite-16b` | DeepSeek Coder V2 Lite 16B | 16B (MoE) | 128k | 66 | no | no | deepseek-license |
| `codestral-22b` | Codestral 22B | 22B | 32k | 74 | no | no | mistral-ai-non-production |
| `yi-coder-9b` | Yi-Coder 9B Chat | 9B | 128k | 60 | no | no | apache-2.0 |
| `granite-3.1-8b` | Granite 3.1 8B Instruct | 8B | 128k | 52 | yes | no | apache-2.0 |
| `phi-4-mini-3.8b` | Phi-4 Mini 3.8B | 3.8B | 128k | 58 | yes | no | mit |
| `llama-3.2-3b` | Llama 3.2 3B Instruct | 3B | 128k | 42 | yes | no | llama3.2 |
| `gemma-3-12b` | Gemma 3 12B IT (QAT) | 12B | 32k | 63 | yes | no | gemma |
| `qwen2.5-vl-7b` | Qwen2.5 VL 7B | 7B | 32k | 55 | yes | yes | apache-2.0 |

"Tools" means the model supports tool calling, which is what lets it use
IMURUN's tools instead of only chatting. "Vision" means it can read images:
`qwen2.5-vl-7b` is the catalog entry for that and ships with a vision projector
file, and installing it is what makes the [`screenshot`](tools.md#screenshot) tool
and a `read` of a PNG actually useful. The coding and reasoning columns are
benchmark scores from the catalog.

Quantizations available per model vary. Most offer `Q4_K_M`, `Q5_K_M`, and
`Q3_K_M`; a few (Qwen3, Gemma 3 QAT, Qwen2.5 VL) offer a different set. Which
quantization you get is chosen for you unless you pass `--quant`.

## How a model is chosen for your machine

The recommendation engine is conservative, so "fits" stays a promise:

- **Usable RAM** is 80% of your total RAM; the operating system and other
  applications need the rest.
- **The weights plus about 2 GB of KV cache** must fit in usable RAM. If they do
  not, the quantization does not fit.
- **GPU offload.** If a usable GPU has enough VRAM for the weights plus the KV
  cache, the model fits fully on the GPU. If it has at least 60% of the needed
  VRAM, it fits partially — most layers on the GPU, which is still much faster
  than CPU.
- **Speed** is estimated from the model's baseline speed, a per-quantization
  factor, a hardware-tier factor, and a GPU boost (full offload, partial offload,
  or none).

For each model the engine evaluates every quantization and picks the highest
quality one that fits. `imurun models info <id>` prints that per-quant table with
a `✔` or `✖` and an estimated tokens-per-second figure for each.

Recommendations are ranked by coding quality, tempered by speed: a model scores
`coding × min(speed / 20, 1.5)`. That is why a 14B on a 16 GB machine can rank
above a 7B only when it still feels fast. Models that do not fit are listed
afterwards, smallest first, so you know the floor.

## Hardware tiers

Hardware is scored 0–100 and bucketed into a tier. The tier feeds the speed
estimate; the fit decision itself is driven by RAM, VRAM, and the model size.

| Tier | Score |
| --- | --- |
| `minimal` | below 20 |
| `low` | 20–39 |
| `mid` | 40–64 |
| `high` | 65–89 |
| `extreme` | 90+ |

## Using models from the CLI

```bash
imurun models                       # recommendations for this machine
imurun models list --all            # the whole catalog, with fit marks
imurun models recommend             # ranked recommendations with reasons
imurun models info qwen2.5-coder-7b # details and per-quant fit
imurun models install qwen2.5-coder-7b
imurun models install qwen2.5-coder-14b --quant Q5_K_M
imurun models remove qwen2.5-coder-7b
imurun models remove --all --yes --keep-files
imurun models clean --yes --engine
imurun models search deepseek coder
```

`list` and `recommend` print a header with your detected hardware summary, tier
and score, how much disk your models use, and how much the disk has free.

`install` always shows the model it selected and the Hugging Face repository it
is pulling from, then downloads with live progress. `info` shows the description,
family, parameters, context length, coding and reasoning scores, tool and vision
support, license, and per-quantization fit.

`remove` deletes a model and reports the space freed; `--all` removes everything
(and asks for `--yes`); `--keep-files` unregisters the model while leaving the
GGUF on disk. `clean` shows reclaimable space and, with `--yes`, frees it,
including interrupted partial downloads; add `--engine` to also remove the
llama.cpp engine binaries. See [Local models](local-models.md#removing-and-reclaiming-space).

## Using models from the interface

```
/model              # picker: switch model, or start a download
/model local/qwen2.5-coder-7b
/models             # installed models plus recommendations
/install <id> [q]   # download with a disk-impact preview
/remove <id>        # delete and free space
```

## Model references

A reference is resolved in this order:

| Form | Meaning |
| --- | --- |
| `qwen2.5-coder-7b` | An installed model with that id (treated as local). |
| `qwen2.5-coder-7b-Q4_K_M` | An exact installed registry id. |
| `local/qwen2.5-coder-7b` | Explicitly local. |
| `C:\models\x.gguf` | A raw GGUF file outside the store. |
| `openrouter/qwen/qwen3-32b` | A configured provider; passed through untouched. |

If no reference is given, IMURUN uses the most recently used installed model, or
the newest install.

## Next

- How installation, detection, and storage work: [Local models](local-models.md).
- Running the model and freeing RAM: [Runtime](runtime.md).
- Adding a cloud model: [Providers](providers.md).
