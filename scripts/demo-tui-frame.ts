/**
 * Full-screen frame preview — renders one complete TUI frame as plain text, so
 * the layout can be inspected (and regression-checked) without a terminal.
 * ANSI styling is stripped; the shape is exactly what the app paints.
 *
 *   bun run scripts/demo-tui-frame.ts
 */
import { composeFrame, renderTranscript, stripAnsi } from "@imurun/tui"
import type { Block } from "@imurun/tui"
import { buildPromptBox } from "@imurun/tui"
import { sidebarLines } from "@imurun/tui"
import { welcomeLines } from "@imurun/tui"

const WIDTH = 100
const HEIGHT = 30
const SIDEBAR = 26
const CONTENT = WIDTH - SIDEBAR - 1
const strip = stripAnsi

const welcome = welcomeLines({
  width: CONTENT,
  version: "0.1.0",
  model: "local/qwen2.5-coder-7b",
  agent: "build",
  workingDir: "C:/Users/imu/Desktop/ImuTechz/IMU CLI",
})

const transcriptBlocks: Block[] = [
  ...welcome.map((text) => ({ kind: "raw", text }) as Block),
  { kind: "user", text: "make the prompt box multi-line and queue anything I send while you are working" },
  {
    kind: "assistant",
    text: "I'll split long input into display lines, keep the **caret** on the right row, and park anything sent mid-turn in a queue that drains in order.",
  },
  { kind: "tool", title: "read packages/tui/src/app.ts", status: "ok", detail: "1800 lines" },
  {
    kind: "tool",
    title: "write docs/landing.html",
    status: "running",
    startedAt: 0,
    words: ["starting", "setting the structure", "adding the layers", "styling it", "finishing off"],
    estimateMs: 5000,
  },
  {
    kind: "code",
    text: "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <title>IMURUN</title>\n  </head>\n</html>\n",
    lang: "html",
    title: "wrote docs/landing.html",
    maxLines: 6,
  },
  { kind: "tool", title: "bun test packages/tui", status: "ok", detail: "42 pass, 0 fail" },
  { kind: "user", text: "also make the stats sit on the right", state: "pending" },
  { kind: "assistant", text: "Done. The sidebar shows context, todos and the working directory; pgup/pgdn scroll the transcript.", streaming: true },
  { kind: "gap" },
  { kind: "meta", text: "3 steps \u00b7 2235+140 tokens \u00b7 2m 4s \u00b7 qwen2.5-coder-7b" },
]

const overlay = [
  "  \u256d\u2500 \u25c6 commands " + "\u2500".repeat(50),
  "  \u2502 \u276f /permission  Choose auto / manual / read-only   \u2502",
  "  \u2502   /queue       Show or clear queued messages       \u2502",
  "  \u2502   /skills      Run a skill, or sync a skill pack   \u2502",
  "  \u2570\u2500 type to filter \u00b7 tab completes \u00b7 enter runs",
]

const status = "  \u25d0 working\u2026 2.4s \u00b7 2 queued \u00b7 esc interrupts"
const box = buildPromptBox({
  input: "and add /permission so I can pick auto-approve\nor manual without editing config",
  cursor: 62,
  width: WIDTH,
  maxRows: 3,
  hint: "2 queued \u00b7 esc interrupts",
  tone: "busy",
})

const sidebar = sidebarLines({
  width: SIDEBAR,
  model: "qwen2.5-coder-7b",
  agent: "build",
  session: "ses_9f2c1a4b",
  workingDir: "C:/Users/imu/Desktop/ImuTechz/IMU CLI",
  permissions: "manual",
  context: { used: 13_700, max: 32_768 },
  plan: { done: 2, total: 5 },
  todos: [
    { title: "queue draining after interrupt", status: "doing" },
    { title: "write the README", status: "open" },
    { title: "publish 0.1.0", status: "open" },
  ],
  queue: 2,
  busy: true,
})

const frame = composeFrame({
  width: WIDTH,
  height: HEIGHT,
  header: ["  IMURUN v0.1.0  \u2502  model qwen2.5-coder-7b  \u2502  agent build  \u2502  ~/Desktop/ImuTechz/IMU CLI"],
  sidebar: { width: SIDEBAR, lines: sidebar },
  transcript: renderTranscript(transcriptBlocks, CONTENT, { tick: 4, now: 3300 }),
  overlay,
  prompt: box.lines,
  promptCursor: box.cursor,
  status,
})

console.log("")
for (const [index, line] of frame.lines.entries()) {
  const marker = index + 1 === frame.cursor.row ? "\u2503" : "\u2502"
  console.log(`${marker} ${strip(line).padEnd(WIDTH)} ${marker}`)
}
console.log("")
console.log(`  frame: ${frame.lines.length} lines \u00b7 width ${WIDTH} \u00b7 sidebar ${SIDEBAR}`)
console.log(`  caret: row ${frame.cursor.row}, col ${frame.cursor.col}`)
console.log("")

const problems: string[] = []
if (frame.lines.length !== HEIGHT) problems.push(`expected ${HEIGHT} lines, got ${frame.lines.length}`)
if (!strip(frame.lines[frame.cursor.row - 1]!).includes("\u276f")) problems.push("caret row does not contain the prompt marker")
if (strip(frame.lines[frame.lines.length - 1]!).trim() !== status.trim()) problems.push("status line is not last")
for (const line of frame.lines) {
  if (strip(line).length > WIDTH) problems.push(`line wider than ${WIDTH}: ${strip(line).length}`)
}
if (!frame.lines.some((line) => strip(line).includes("IMURUN"))) problems.push("wordmark missing from the header")
if (!welcome.some((line) => strip(line).includes("by ImuTechz"))) problems.push("credit missing from the welcome")
if (!welcome.some((line) => strip(line).length >= 50 && /[\u2588\u2557\u2550]/.test(strip(line)))) {
  problems.push("big wordmark art missing from the welcome")
}
if (!frame.lines.some((line) => strip(line).includes("CONTEXT"))) problems.push("sidebar context section missing")
if (!frame.lines.some((line) => strip(line).includes("adding the layers"))) problems.push("running tool phase word missing")
if (!frame.lines.some((line) => strip(line).includes("\u2588"))) problems.push("running tool progress bar missing")
if (!frame.lines.some((line) => strip(line).includes("<!doctype html>"))) problems.push("written code preview missing")
if (!frame.lines.some((line) => strip(line).includes("2235+140 tokens"))) problems.push("stats line missing")
if (!frame.lines.some((line) => strip(line).includes("\u25cb"))) problems.push("queued message marker missing")

const metaLine = frame.lines.find((line) => strip(line).includes("2235+140 tokens")) ?? ""
// The stats sit at the right edge of the content column, which is now the left
// half of the frame; the session panel occupies the right.
const [metaContent = "", metaPanel = ""] = strip(metaLine).split("\u2502")
if (!metaContent.trimEnd().endsWith("qwen2.5-coder-7b")) problems.push("stats line is not right-aligned")
if (!/^\s{8,}/.test(metaContent)) problems.push("stats line is not pushed to the right of the content column")
if (metaPanel.trim().length === 0) problems.push("the panel is empty beside the transcript")
if ((strip(metaLine).match(/\u2502/g) ?? []).length !== 1) problems.push("content and panel are not separated by one divider")
const contextLine = frame.lines.find((line) => strip(line).includes("CONTEXT")) ?? ""
if (strip(contextLine).indexOf("CONTEXT") <= WIDTH / 2) problems.push("the panel is not on the right")

if (problems.length === 0) {
  console.log("  \u2714 frame layout OK\n")
  process.exit(0)
}
console.log("  \u2716 frame layout problems:")
for (const problem of problems) console.log(`    - ${problem}`)
console.log("")
process.exit(1)
