# Third-party notices

IMURUN is MIT-licensed (see [LICENSE](LICENSE)) and ships only free, open-source
dependencies. This file records the projects whose **ideas or algorithms** were
reimplemented in IMURUN's own code, and the licence each one carries.

None of the code below is copied verbatim. The clean-room rule for this
repository is that an upstream project is read for its design, then the
behaviour is written again against IMURUN's own store, configuration, and
terminology. Where a port exists, the file that contains it is named so the
lineage is checkable.

## Ported designs

### `smixs/agent-second-brain`

- **Licence:** MIT
- **Used for:** the memory-vault design — typed cards, Ebbinghaus-style decay
  (`strength = 1 + ln(accesses)`), five temperature tiers, promotion on use,
  random resurfacing, self-maintenance, and a 100-point vault health score.
- **In IMURUN:** `packages/core/src/memory/cards.ts` (card model and tier
  arithmetic), `packages/core/src/memory/brain.ts` (the vault: markdown on
  disk, ageing, link repair, duplicate quarantine, map-of-content), and the
  memory sections of the system prompt.
- **Deliberate differences:** IMURUN's vault is plain Obsidian-compatible
  markdown with a YAML subset, not a database; ranking is lexical (token
  coverage) scaled by decay rather than embedding-based, so it works offline
  with no model; maintenance never deletes a card — duplicates go to
  `.trash/`, and orphans are reported only.

### `smixs/autograph`

- **Licence:** MIT
- **Used for:** the shape of an agent-maintained knowledge graph (nodes,
  edges, and a map-of-content entry point), which informed the `[[wiki-link]]`
  link graph and the generated `MEMORY.md`.
- **In IMURUN:** `packages/core/src/memory/brain.ts` (`wikiLinks`, `health`,
  `renderMoc`).

### Skill packs

Skill packs imported with `imurun skills sync` are third-party content, not
part of this repository. Each imported skill records its `origin` and `license`
in its frontmatter, and IMURUN refuses source-available packs unless the user
passes `--include-restricted`. The built-in presets are:

| Preset | Source | Licence |
| --- | --- | --- |
| `anthropic` | `anthropics/skills` | mixed, recorded per skill |
| `second-brain` | `smixs/agent-second-brain` | MIT |

## Runtime dependencies

Every runtime dependency is free and open source; the full set is pinned in
`bun.lock`. The notable ones:

| Package | Licence | Used for |
| --- | --- | --- |
| `ai`, `@ai-sdk/openai-compatible` | Apache-2.0 | streaming model calls |
| `zod` | MIT | configuration and tool schemas |
| `chalk` | MIT | terminal colour |
| `commander` | MIT | the command line |
| `bun:sqlite` (Bun) | MIT | the session store |

The inference engine (llama.cpp) and the models themselves are downloaded at
the user's request and are not distributed with IMURUN; their own licences
apply.
