# RAG (the project index)

**What this covers:** the offline index that answers "where does this live?" in a
project. It explains what gets indexed, how files are chunked and tokenized, how
results are ranked, how the index is kept up to date, and the exact limits
involved. The tool that uses it is [`code_search`](tools.md#code_search); the CLI
and slash commands that expose it are below.

## What the index is

The index is **lexical**, not vector-based. Every source file is split into
overlapping chunks, each chunk is tokenized, and retrieval is BM25. That sounds
old-fashioned next to embedding search, but it is the right trade here: it runs
in-process, it is instant, it works on a fresh machine with nothing loaded and no
network, and for code — where identifiers are unusual words with a precise
spelling — lexical matching is genuinely strong.

There is no embedding server, no model call, and no download. Everything is capped
so a huge or hostile directory can never exhaust memory or stall a turn.

The agent never has to be told to "index the project". The first search builds the
index; later searches re-check only the files that changed; and a `write` or `edit`
marks it stale so the very next search sees the new contents.

## What gets indexed

A project-relative path is indexed when it passes all of these:

- it is not in an ignored directory (`node_modules`, `.git`, `dist`, `build`,
  `out`, and the other directories `glob` and `grep` skip — see
  [Tools](tools.md#glob));
- its file name does not start with a dot;
- it is not a known lock file (`package-lock.json`, `bun.lock`, `bun.lockb`,
  `yarn.lock`, `pnpm-lock.yaml`, `composer.lock`, `Gemfile.lock`,
  `poetry.lock`, `uv.lock`, `Cargo.lock`); and
- it either has a source-like extension **or** is a known extensionless file.

Source-like extensions include TypeScript and JavaScript (including `.tsx`,
`.jsx`, `.mjs`, `.cjs`, and the `.mts`/`.cts` variants), JSON, Markdown and text,
Python, Ruby, PHP, Go, Rust, Java, Kotlin, Swift, Scala, Lua, Dart, C and C++
family, C#, F#, Objective-C, shell scripts (`sh`, `bash`, `zsh`, `fish`, `ps1`,
`psm1`, `bat`, `cmd`), SQL, GraphQL, Prisma, YAML, TOML, INI and config files,
HTML, CSS and friends, `vue`, `svelte`, `astro`, XML and SVG, CSV, patches and
diffs, and TeX.

The recognised extensionless files are `Dockerfile`, `Makefile`, `Rakefile`,
`Procfile`, `Justfile`, `Caddyfile`, `Brewfile`, `LICENSE`, `NOTICE`, `README`,
`CHANGELOG`, `CONTRIBUTING`, `AUTHORS`, and `TODO` (case-insensitively).

A file with a NUL byte in its first 2 KB is treated as binary and skipped.

## How files are chunked

Each file is split into overlapping line windows:

| Setting | Value |
| --- | --- |
| Lines per chunk | 60 |
| Characters per chunk | 1600 |
| Overlap | 8 lines |
| Minimum tokens for a chunk | 3 |

The overlap is what stops a function that straddles a chunk boundary from being
invisible to search. Windows are bounded by both a line count and a character
count, because a "line" in generated or minified code can be enormous. Chunks with
fewer than three tokens are dropped, so blank or trivial regions do not take up
room.

These are defaults, not laws: `rag.chunkLines`, `rag.chunkOverlapLines`, and
`rag.chunkChars` change them, and a project with long minified data files or very
short modules can tune the shape to suit.

## How text is tokenized

The base tokenizer lowercases, splits on punctuation, drops single-character
tokens and a built-in stopword list. That alone would leave `computeWidgetTotal`
and `MAX_RETRY_COUNT` as single opaque words, so searching for "widget" would never
find the function.

The index therefore also breaks identifiers at case boundaries and underscores,
and indexes **both** forms: the whole identifier (so an exact symbol search is
precise) and its parts (so a plain word finds it). The same tokenizer is used for
the query, so `widget`, `computeWidgetTotal`, and `MAX_RETRY_COUNT` all connect.

## How results are ranked

Ranking is BM25 with `k1 = 1.2` and `b = 0.75`, then two adjustments:

- A chunk that covers more of the question beats one that merely repeats a word:
  the score is multiplied by `1 + 0.25 × (matched terms − 1)`.
- A term that also appears in the file path wins, because the path often names the
  file you are looking for: the score is multiplied by ×1.4.

Each hit reports its path, line range, score, and a short **excerpt** — the first
line containing a query term, plus a few lines after it, clipped to 600
characters and marked with `…` where it was cut. Results sort by score, then path,
then start line. The default limit is 8, the maximum is 40 at the index level
(the `code_search` tool defaults to 8 and caps at 30).

## Keeping the index fresh

The index is never rebuilt from scratch on every search. Each indexed file records
its modification time and size, so a refresh only re-reads the files that actually
changed, and drops the ones that disappeared.

| Behaviour | Value |
| --- | --- |
| Freshness window before a re-check | 5 seconds |
| Invalidation | `write` and `edit` mark the index stale immediately. |
| Snapshot | `~/.imurun/rag/<name>-<hash>.json` |
| Snapshot version | 1 (old snapshots are ignored, not migrated). |
| Snapshot write | On any change, and at most once a minute otherwise. |

Because a new session loads the snapshot, it starts warm. If the snapshot's
recorded root does not match the project, it is ignored. A snapshot is also
skipped if its shape version differs.

`rag.watch: false` turns the automatic re-check off. The index is then only
rebuilt when you ask — `/index`, `imurun rag index`, or a `write`/`edit` marking
it stale — which is the setting for a very large tree on a slow disk, or a
directory that changes constantly under something else's control. `imurun rag
index` always refreshes regardless of the setting.

## Limits

| Cap | Value | Setting |
| --- | --- | --- |
| Indexed files | 3000 | `rag.maxFiles` |
| Bytes per file | 400 KB | `rag.maxFileSizeKB` |
| Chunks | 6000 | `rag.maxChunks` |
| Total indexed characters | 6 MB | fixed |

These are hard limits: past them the index simply covers fewer files. Files that
were skipped because a budget was already spent still get their metadata recorded,
so a later refresh never re-reads them. Files are scanned in sorted order, so the
file cap always keeps the same files.

## Using it

The agent uses the index through the `code_search` tool, which the system prompt
tells it to reach for first, before reading files:

| Argument | Notes |
| --- | --- |
| `query` | Natural language or identifiers. |
| `path` | Restrict matches to paths containing this fragment. |
| `limit` | Maximum results (default 8, max 30). |

From the shell and the TUI:

```bash
imurun rag                 # show what is indexed for this directory
imurun rag index           # build or update it now
imurun rag search "where are permissions checked"
imurun rag clear           # delete the index and its snapshot
```

```text
/rag [status|index|search <query>|clear]
```

`imurun rag <words>` is shorthand for `imurun rag search <words>`. Both the CLI
command and the tool accept `--path <fragment>` and `--limit N`; the CLI also
accepts `--json`. `imurun rag search` exits non-zero when nothing matches. The
command exists so you can see what the index knows, warm it before a long session,
or work out why a search missed. See
[CLI reference](cli-reference.md#rag) and [Slash commands](slash-commands.md).

## Automatic context (auto-inject)

`code_search` is the tool; auto-inject is the same index used *without* the model
asking. Before a turn is sent, IMURUN searches the index with the user's message as
the query and puts the best few chunks into the system prompt under a
`## Project context` heading:

```markdown
## Project context

Relevant project material, retrieved for this message. Cite paths when you use it.

### src/parser.ts:41-96
export function parse(input: string) { … }
```

This is what makes a local model feel like it knows the codebase rather than
guessing at it: the material is on hand before the first token is generated, at no
extra round trip.

The knobs are `rag.autoInject` (on by default), `rag.maxInjectChunks` (6), and
`rag.enabled`. Injection also needs the `code_search` tool to be present in the
current agent's tool set — a role you have locked down to read-only tools gets no
injected block either.

The side panel names what was injected, so the provenance of an answer is visible
rather than implied:

```text
 SOURCES  3
 parser.ts:41
 agent.ts:318
 rag.ts:112
```

`tui.showRagSources: false` hides that section. The sources are also recorded on
the turn's first assistant message, so resuming that session from `/session`
brings the same list back rather than showing an empty panel.

## Configuration

The `rag` section of `imurun.json` (see
[Configuration](configuration.md#rag)) — every field is read:

```jsonc
{
  "rag": {
    "enabled": true,
    "watch": true,
    "autoInject": true,
    "maxInjectChunks": 6,
    "maxFileSizeKB": 400,
    "maxFiles": 3000,
    "maxChunks": 6000,
    "chunkLines": 60,
    "chunkOverlapLines": 8,
    "chunkChars": 1600,
    "excludeGlobs": ["node_modules/**", ".git/**", "fixtures/**"]
  }
}
```

`excludeGlobs` is *added* to the built-in ignore list, so `excludeGlobs: []` still
skips `node_modules` and lock files; use it to exclude things specific to your
project (fixtures, generated clients, another package's build output). Patterns are
read like `.gitignore`: `vendor/**` matches a directory's contents, `*.generated.ts`
matches at any depth, and a bare name matches anywhere in the tree.
