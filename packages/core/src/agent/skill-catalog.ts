/**
 * Built-in skill catalog — 50 ready-to-use skills covering the tasks a coding
 * agent is actually asked to do: building web apps, shaping APIs, testing,
 * reviewing, securing, documenting, shipping, and reasoning about data.
 *
 * Each entry is a compact, self-contained instruction. They are written to be
 * *loadable at any time*: the router (see ./skills) scores them against what the
 * user asked and injects the best match into the system prompt, so the model
 * gets the right method without the user having to remember a command.
 *
 * Keep the prompts short and opinionated. A skill that rambles costs context on
 * every turn it is active.
 */
import type { SkillDefinition } from "./skills"

function skill(
  id: string,
  name: string,
  description: string,
  tags: string[],
  prompt: string,
): SkillDefinition {
  return { id, name, description, tags, prompt, source: "builtin" }
}

export const SKILL_CATALOG: SkillDefinition[] = [
  // ── Web & frontend ────────────────────────────────────────────────────────
  skill(
    "build-website",
    "Build a website",
    "Plan and build a complete website or web page from a description",
    ["web", "frontend", "html", "css", "site"],
    "Build this as a real, working website. First decide the stack from what is already in the project (plain HTML/CSS, a framework, or a generator) — do not add a framework that is not there. Then produce the page structure, the styles, and the content. Requirements: responsive down to 360px, semantic HTML landmarks, real accessible text (no lorem ipsum unless asked), system font stack, no external CDN unless the project already uses one. Open the result with the project's own dev command. Report the files you created.",
  ),
  skill(
    "landing-page",
    "Landing page",
    "Write a conversion-focused landing page with real copy",
    ["web", "marketing", "copy", "landing"],
    "Write a landing page with a clear hierarchy: hero (headline + one-line value prop + primary call to action), the problem, how it works in three steps, proof (features or numbers), one objection-handling section, and a closing call to action. Write real, specific copy for the product described — no placeholders. Keep sections scannable and under one screen of text each.",
  ),
  skill(
    "responsive-layout",
    "Responsive layout",
    "Make an existing layout work on phones, tablets, and desktop",
    ["web", "css", "responsive", "layout"],
    "Make the layout responsive. Audit the current CSS for fixed widths, absolute positioning, overflowing text, and touch targets under 44px. Switch to a mobile-first flow using flex/grid and modern units. Test by reasoning through 360px, 768px, and 1440px widths and fix what breaks. Do not rewrite what already works.",
  ),
  skill(
    "accessibility-audit",
    "Accessibility audit",
    "Audit and fix a page against WCAG basics",
    ["web", "a11y", "accessibility", "audit"],
    "Audit this UI for accessibility. Check and fix, in order: (1) keyboard reachability and visible focus, (2) landmarks and heading order, (3) labels on every input plus error text tied by aria-describedby, (4) colour contrast at 4.5:1 for body text, (5) alt text that carries meaning, (6) no information conveyed by colour alone. Report each issue as file:line with the fix you applied.",
  ),
  skill(
    "seo-audit",
    "SEO audit",
    "Improve a page's technical SEO and metadata",
    ["web", "seo", "metadata"],
    "Improve technical SEO on this page: one h1, descriptive title under 60 characters, meta description under 155 characters, canonical URL, Open Graph and Twitter card tags, structured data where it genuinely applies, internal links with descriptive anchor text, and no client-side-only content the crawler cannot read. Show the tags you changed.",
  ),
  skill(
    "web-performance",
    "Web performance",
    "Measure and fix the slow parts of a web page",
    ["web", "performance", "lighthouse", "speed"],
    "Find and fix the performance problems. Look for: render-blocking assets, oversized or unoptimised images, layout shift from missing dimensions, unused JavaScript, and synchronous third-party scripts. Measure before and after with whatever is available (build output size, Lighthouse, or timing logs). Report the numbers.",
  ),
  skill(
    "design-system",
    "Design system",
    "Extract or extend a consistent design system",
    ["web", "design", "css", "tokens"],
    "Extract the interface into a small design system: colour tokens, a type scale, spacing steps, radii, shadows, and state styles for buttons/inputs/cards. Replace ad-hoc values in the components with the tokens. Keep it to CSS custom properties unless the project already has a system, and do not change the visual result except where it is inconsistent.",
  ),
  skill(
    "css-animation",
    "CSS animation",
    "Add tasteful, performant motion to an interface",
    ["web", "css", "animation", "motion"],
    "Add motion to this interface using CSS only. Only animate transform and opacity so it stays on the compositor. Duration 120–240ms, easing that decelerates on entry, and nothing that blocks input. Respect prefers-reduced-motion by disabling non-essential motion. Keep it subtle — motion should explain a state change, not decorate.",
  ),
  skill(
    "web-components",
    "Framework-agnostic component",
    "Build a reusable component without a framework",
    ["web", "component", "javascript"],
    "Build this as a self-contained component with no framework dependency: plain DOM APIs or a custom element, styles scoped to the component, props/attributes documented, events emitted instead of reaching into parents, and teardown that removes its listeners. Include a short usage example.",
  ),
  skill(
    "form-handling",
    "Form handling",
    "Build a form with validation, states, and submission",
    ["web", "forms", "validation", "ux"],
    "Build this form properly: labelled inputs, inline validation on blur (not on every keystroke), a disabled-and-busy submit state, server error mapping back to fields, keyboard submission, and success feedback. Validate on the server too — client checks are UX, not security. Show the validation rules you used.",
  ),

  // ── Backend & APIs ────────────────────────────────────────────────────────
  skill(
    "rest-api",
    "REST API",
    "Design and implement a REST resource",
    ["api", "rest", "backend", "http"],
    "Implement this REST resource. Use plural nouns, the right verbs and status codes (201 with Location on create, 204 on delete, 404/409/422 for real failures), pagination on collections, and a consistent error body { error: { code, message, details } }. Validate input at the boundary. Document each route with a one-line example request and response.",
  ),
  skill(
    "graphql-api",
    "GraphQL API",
    "Add or refine a GraphQL schema and resolvers",
    ["api", "graphql", "schema"],
    "Design this GraphQL API. Use nullable fields only where absence is meaningful, define input types for mutations, return a payload union for expected errors, and paginate connections with cursors. Watch for N+1 queries and resolve them with batching or a dataloader. Include one example query and one mutation.",
  ),
  skill(
    "auth-flow",
    "Authentication flow",
    "Add sign-in, sessions, and authorisation checks",
    ["auth", "security", "session", "jwt"],
    "Implement authentication. Store password hashes with a memory-hard algorithm (bcrypt/argon2) — never reversible encryption. Use httpOnly, SameSite=Lax cookies for sessions, rotate the session id on privilege change, and add CSRF protection to state-changing routes. Enforce authorisation on the server for every resource, with the check next to the data access, not only in middleware. Never log tokens or secrets.",
  ),
  skill(
    "rate-limiting",
    "Rate limiting",
    "Protect an endpoint from abuse",
    ["api", "security", "rate-limit", "abuse"],
    "Add rate limiting to this endpoint. Prefer a sliding window or token bucket keyed by user id when authenticated, else by IP. Return 429 with a Retry-After header. Keep the limit in one place with named constants and make it configurable. Make sure a legitimate burst is not penalised and that failures of the limiter fail open with a log line.",
  ),
  skill(
    "api-docs",
    "API reference",
    "Document an API surface accurately",
    ["docs", "api", "reference"],
    "Document this API from the code — do not invent endpoints. For each route: method, path, purpose, auth requirement, parameters with types and whether they are required, a minimal request example, a success response, and each error it can return. Note rate limits and pagination. Keep examples copy-pasteable.",
  ),
  skill(
    "websocket-server",
    "Realtime connection",
    "Add a WebSocket or SSE channel",
    ["realtime", "websocket", "sse", "backend"],
    "Add a realtime channel for this feature. Choose SSE for one-way server push and WebSocket when the client also sends. Handle: connection auth, heartbeats, reconnect with backoff on the client, message framing with a type field, backpressure, and clean teardown on disconnect. On reconnect, define how the client catches up on missed messages.",
  ),
  skill(
    "background-jobs",
    "Background jobs",
    "Move slow work out of the request path",
    ["jobs", "queue", "backend", "async"],
    "Move this work into a background job. Define the job payload as a serialisable object, make the handler idempotent (safe to run twice), add retries with exponential backoff and a dead-letter path, and log a correlation id. Make sure the enqueue happens in the same transaction as the state change that requires it, or explain why it cannot be.",
  ),
  skill(
    "caching",
    "Caching",
    "Add a cache without creating stale-data bugs",
    ["cache", "performance", "backend"],
    "Add caching here. Decide the key from the inputs that actually affect the result, set an explicit TTL, and invalidate on every write path that changes the cached value. Prefer cache-aside. Handle a cold cache and a cache outage without failing the request. State clearly what staleness window the user will observe.",
  ),

  // ── Data ──────────────────────────────────────────────────────────────────
  skill(
    "schema-design",
    "Database schema",
    "Design tables, keys, and indexes",
    ["database", "schema", "sql", "data"],
    "Design the schema for this feature. Normalise to third normal form unless there is a measured reason not to, use a surrogate primary key plus the natural unique constraint, add NOT NULL and foreign keys with explicit delete behaviour, and index every column used in a lookup or join. Write the migration in a form that is safe to run on a live table.",
  ),
  skill(
    "migration",
    "Migration",
    "Write a safe, reversible migration",
    ["database", "migration", "sql", "ops"],
    "Write this migration so it is safe on a live database: separate schema changes from data backfills, add columns as nullable (or with a default) first, create indexes concurrently where the engine supports it, and provide the down migration. Never lock a large table for a rewrite in a single statement. Order the steps so the previous application version keeps working during the deploy.",
  ),
  skill(
    "query-optimize",
    "Query optimisation",
    "Find and fix slow queries",
    ["database", "performance", "sql", "index"],
    "Optimise this query. Start from the query plan, not from intuition. Look for sequential scans on large tables, missing indexes, functions applied to indexed columns, N+1 patterns, and over-fetching columns. Propose the index or rewrite, state the expected effect on the plan, and measure before and after with real data if any is available.",
  ),
  skill(
    "data-seed",
    "Seed data",
    "Create realistic test fixtures",
    ["database", "seed", "fixtures", "testing"],
    "Generate realistic seed data for this schema. Use plausible names, domains, dates, and consistent relationships — respect foreign keys and make derived fields agree with their source. Make the seed deterministic with a fixed random seed so tests are reproducible, and make it idempotent so it can be run repeatedly.",
  ),
  skill(
    "etl-pipeline",
    "Data pipeline",
    "Build or fix an extract-transform-load flow",
    ["data", "etl", "pipeline"],
    "Build this pipeline in clear stages: extract (with the source's pagination and rate limits respected), validate, transform, load (idempotent upsert), and record a run summary. Make each stage resumable so a failure does not restart from zero, and make malformed records land in a quarantine table rather than killing the run.",
  ),
  skill(
    "data-analysis",
    "Analyse a dataset",
    "Answer a question from data, honestly",
    ["data", "analysis", "statistics"],
    "Answer this question from the data. State the assumption you are making about each column before you use it, check for missing and duplicate rows, and report counts alongside percentages. Show the query or script you ran. If the data cannot answer the question, say so and name what data would. Never round away a small sample.",
  ),

  // ── Testing ───────────────────────────────────────────────────────────────
  skill(
    "unit-tests",
    "Unit tests",
    "Write focused unit tests for a function or module",
    ["testing", "unit", "coverage"],
    "Write unit tests for this code. One behaviour per test with a name that states the expectation, table-driven cases where the inputs vary, and no network, clock, or filesystem dependence (inject or freeze them). Cover the happy path, each branch, and the boundaries. Match the project's existing test framework and file layout.",
  ),
  skill(
    "integration-tests",
    "Integration tests",
    "Test that components work together",
    ["testing", "integration"],
    "Write integration tests for this flow. Exercise the real wiring (router through to storage) but keep external systems either real-and-local or faked at the boundary. Assert on observable outcomes, not on internal calls. Include the failure paths: validation errors, missing records, and duplicate submission.",
  ),
  skill(
    "e2e-tests",
    "End-to-end tests",
    "Drive the app the way a user does",
    ["testing", "e2e", "browser", "playwright"],
    "Write end-to-end tests for this user journey. Use role- and label-based selectors so the test survives refactors, wait on observable state rather than timers, and clean up the data the test creates. Assert the outcome the user cares about. Keep each test independent so it can run in any order.",
  ),
  skill(
    "test-fixtures",
    "Test fixtures",
    "Build small, explicit test data builders",
    ["testing", "fixtures", "factory"],
    "Create fixtures for these tests. Use a builder or factory with sensible defaults so each test states only the fields it cares about, keep fixtures in memory rather than on disk where possible, and make them independent between tests. Never share mutable fixture state across tests.",
  ),
  skill(
    "flaky-tests",
    "Fix flaky tests",
    "Find and remove the cause of an unreliable test",
    ["testing", "flaky", "ci"],
    "Diagnose this flaky test. The usual causes, in order of likelihood: reliance on wall-clock time, unordered collection assertions, shared state between tests, real network or DNS, animation/timing races, and port collisions. Reproduce it by running the test repeatedly, fix the root cause, and do not paper over it with a sleep or a retry.",
  ),

  // ── Quality & review ──────────────────────────────────────────────────────
  skill(
    "review",
    "Review changes",
    "Review a diff for bugs, style, and missing tests",
    ["review", "diff", "quality"],
    "Review the current diff. Report concrete problems in priority order — correctness bugs first, then edge cases, then style mismatches, then missing tests — each with a file:line reference and the smallest fix. Say explicitly when something is fine. Do not change files unless asked.",
  ),
  skill(
    "refactor",
    "Refactor",
    "Improve structure without changing behaviour",
    ["refactor", "quality", "design"],
    "Refactor this code without changing behaviour. Do it in small, reviewable steps, each of which keeps the tests green. Extract what is repeated, name things for their purpose, collapse needless indirection, and reduce the number of concepts a reader must hold at once. If there are no tests, add a characterisation test first.",
  ),
  skill(
    "bug-hunt",
    "Find a bug",
    "Track a defect down to its root cause",
    ["debug", "bug", "diagnosis"],
    "Find the root cause of this bug. Reproduce it first and write down the exact steps. Then form a hypothesis, and test it by observation rather than by reading code alone — add a log, a breakpoint, or a failing test. Fix the cause, not the symptom, and add a regression test that fails before your fix and passes after.",
  ),
  skill(
    "type-safety",
    "Tighten types",
    "Remove unsafe types and make illegal states unrepresentable",
    ["types", "typescript", "quality"],
    "Tighten the types here. Replace `any` with a real type or `unknown` plus a narrowing check, model the states as a discriminated union so illegal combinations cannot be constructed, and push validation to the boundary. Do not silence the compiler with assertions unless you can state the invariant that makes it safe.",
  ),
  skill(
    "dependency-audit",
    "Audit dependencies",
    "Review what the project depends on",
    ["dependencies", "security", "maintenance"],
    "Audit the dependencies. List direct dependencies with their purpose, flag any that are unmaintained (no release in two years, archived repo), duplicated by another dependency, or trivially replaceable with a few lines. Check the lockfile for known vulnerabilities. For each removal you propose, state what has to change.",
  ),
  skill(
    "dead-code",
    "Remove dead code",
    "Delete what nothing uses",
    ["cleanup", "dead-code", "quality"],
    "Find and remove dead code. Trace every candidate to its callers, including dynamic imports, string references, config files, and tests, before deleting anything. Remove the code, its tests, and its exports together. Report anything you were unsure about rather than guessing.",
  ),
  skill(
    "error-handling",
    "Error handling",
    "Make failures explicit and recoverable",
    ["errors", "robustness", "quality"],
    "Improve the error handling here. Distinguish expected failures from programmer errors; model the expected ones in the return type or a typed error union. Add context as errors cross a boundary, never swallow one silently, clean up resources with finally or a scope guard, and make sure a user-facing message says what to do next. Log the detail, show the summary.",
  ),
  skill(
    "logging-observability",
    "Observability",
    "Add logging and metrics that help in production",
    ["logging", "observability", "ops"],
    "Add observability here. Log structured fields (ids, durations, outcome) rather than prose, at the right level, without secrets or personal data. Add a counter and a duration for the operation, and a correlation id that ties a request across the layers. Make sure a failure is visible without having to reproduce it.",
  ),
  skill(
    "performance-profile",
    "Profile performance",
    "Find where the time actually goes",
    ["performance", "profiling", "optimisation"],
    "Profile this before changing it. Measure the current behaviour, find the hot path from real numbers, change the single biggest contributor, then measure again. Do not optimise what the profile says is cheap. Report the before/after numbers and what you deliberately left alone.",
  ),

  // ── Operations & shipping ─────────────────────────────────────────────────
  skill(
    "dockerize",
    "Containerise",
    "Write a correct, small Dockerfile",
    ["docker", "container", "ops", "deploy"],
    "Write a Dockerfile for this app. Use a multi-stage build, pin the base image by digest or minor tag, run as a non-root user, copy the lockfile before the source so dependency layers cache, and set a healthcheck and an explicit entrypoint. Use .dockerignore to keep the context small. Build it and report the final image size.",
  ),
  skill(
    "ci-pipeline",
    "CI pipeline",
    "Set up continuous integration",
    ["ci", "github-actions", "automation"],
    "Set up CI for this project. Run install, typecheck, tests, and build on every push and pull request, pinned to a specific toolchain version, with dependency caching. Fail on the first real error, keep the job under ten minutes, and make the failure message say what broke. Report the workflow file.",
  ),
  skill(
    "deploy-script",
    "Deployment",
    "Automate a repeatable deploy",
    ["deploy", "release", "ops"],
    "Write the deployment for this project. Make it idempotent, check the preconditions explicitly (build artefacts present, environment variables set, migrations applied), and fail before making a destructive change. Include a rollback path and a smoke check that proves the new version is serving. Print what it did at each step.",
  ),
  skill(
    "env-config",
    "Configuration",
    "Handle configuration and secrets correctly",
    ["config", "env", "secrets"],
    "Sort out the configuration. Read every setting from one place, give each a default that is safe for development, validate them at startup so the process fails fast with a clear message, and document each one. Secrets come from the environment only — never commit them, never log them, and never ship a default value for one.",
  ),
  skill(
    "release",
    "Release",
    "Cut a version and prepare release notes",
    ["release", "versioning", "changelog"],
    "Prepare this release. Determine the version bump from the actual changes following semver, update the version in every place it appears, write release notes grouped into added/changed/fixed/deprecated with the user-visible effect of each, and list the migration steps a user must take. Tag the commit.",
  ),

  // ── Documentation & process ───────────────────────────────────────────────
  skill(
    "readme",
    "README",
    "Write a README that gets someone running the project",
    ["docs", "readme", "onboarding"],
    "Write the README. Lead with one sentence on what the project is and who it is for, then a five-line quick start that actually works from a clean checkout, then the features, configuration, and architecture in that order. Include prerequisites, the exact commands, and a troubleshooting section for the two or three things that usually go wrong. Assume the reader has never seen the repository.",
  ),
  skill(
    "docs",
    "Update docs",
    "Bring documentation in line with the code",
    ["docs", "maintenance"],
    "Find the documentation that no longer matches the code and update it. Check every command, flag, path, and example against the source. Keep the existing documentation style and structure, and only change what is genuinely stale — do not rewrite for taste. Report each file you touched and why it had drifted.",
  ),
  skill(
    "adr",
    "Decision record",
    "Record an architecture decision and its trade-offs",
    ["docs", "architecture", "decision"],
    "Write an architecture decision record: the context and the forces at play, the decision in one sentence, the alternatives considered with the reason each was rejected, and the consequences — including what becomes harder. Write it so a reader in a year understands why, not just what.",
  ),
  skill(
    "commit",
    "Commit message",
    "Turn staged changes into a conventional commit",
    ["git", "commit", "workflow"],
    "Inspect the staged changes (`git diff --cached`) and write a conventional-commit message: type(scope): imperative summary under 72 characters, then a body explaining why the change is needed, then any breaking change or issue reference. Show the message only; do not commit unless I ask.",
  ),
  skill(
    "explain",
    "Explain code",
    "Explain how code works, step by step",
    ["explain", "learning", "code"],
    "Explain this code: what it does, the flow through it in order, the parts that are not obvious from a quick read, and the assumptions it depends on. Reference files by path. Where it is wrong or fragile, say so. Keep it concise and grounded in the actual source — do not describe what the name suggests it does.",
  ),
  skill(
    "onboarding",
    "Onboarding tour",
    "Orient a newcomer in an unfamiliar codebase",
    ["onboarding", "architecture", "docs"],
    "Give me a tour of this codebase. Start with the entry point and follow one real request end to end, naming the files on the way. Then describe the main directories and what belongs in each, the conventions a contributor must follow, and the three things that would surprise a newcomer. Point at the files rather than paraphrasing them.",
  ),

  // ── Product & design ──────────────────────────────────────────────────────
  skill(
    "ux-copy",
    "Interface copy",
    "Write the words in an interface",
    ["copy", "ux", "writing"],
    "Write the interface copy. Buttons are a verb naming what happens, empty states say what would be here and how to create it, errors say what went wrong and what to do next, and confirmation dialogs name the irreversible action on the button. Be specific and human — no 'An error occurred', no 'Are you sure?'. Give the copy per element.",
  ),
  skill(
    "cli-tool",
    "CLI tool",
    "Build a command-line tool people can use",
    ["cli", "tooling", "automation"],
    "Build this command-line tool. Support `--help` with an example for every flag, read configuration from flags then environment then a file, exit non-zero on failure with the reason on stderr, write data to stdout so it can be piped, and handle Ctrl+C without leaving partial state. Keep the happy path a single command.",
  ),
  skill(
    "script-automation",
    "Automation script",
    "Automate a repetitive task safely",
    ["automation", "script", "ops"],
    "Write this automation. Default to a dry run that prints exactly what it would change, support an explicit --apply to do it, and make the action idempotent so a second run is a no-op. Fail loudly on an unexpected state rather than skipping it, and log each action with what it changed.",
  ),
  skill(
    "security-review",
    "Security review",
    "Check code for the common exploitable flaws",
    ["security", "review", "audit"],
    "Review this code for security. Check specifically for: injection through string-built queries or commands, missing authorisation on a data path, secrets in code or logs, unvalidated input crossing a trust boundary, unsafe deserialisation, path traversal, and SSRF from a user-supplied URL. For each finding give the attack, the impact, and the fix — ordered by severity. Say plainly if you find nothing.",
  ),
]

/** Alias map so the same skill is reachable under common names. */
export const SKILL_ALIASES: Record<string, string> = {
  code_review: "review",
  "code-review": "review",
  tests: "unit-tests",
  testing: "unit-tests",
  website: "build-website",
  web: "build-website",
  frontend: "build-website",
  documentation: "docs",
  onboarding_guide: "onboarding",
}

export function catalogSize(): number {
  return SKILL_CATALOG.length
}
