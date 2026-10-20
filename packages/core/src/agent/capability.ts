/**
 * Capability-refusal recovery.
 *
 * Small local models are trained as chat assistants, and their strongest prior
 * is "I'm an AI — I cannot run programs". IMURUN hands them a shell, file
 * tools and the network anyway, and the system prompt says so — but a 4 B model
 * will still sometimes answer "I'm sorry, but I cannot execute shell commands"
 * to a request it could have done in one tool call.
 *
 * Two defences, both cheap:
 *
 *   1. The system prompt states the capability in plain terms near the top,
 *      where a small model's attention is strongest.
 *   2. When a step ends in that kind of refusal anyway, the turn is not over:
 *      one corrective message names the tools it actually has and asks it to
 *      start. The pattern list is deliberately narrow — it fires on claims of
 *      *missing capability*, not on a model politely declining a request.
 *
 * This is a phrasing-level guard against a known failure mode, not a gate on
 * what the user may ask.
 */

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /i(?:'| a)m sorry,? but i (?:cannot|can'?t|am unable)/i,
  /i (?:cannot|can'?t) (?:execute|run|use|access|interact with|perform)\b/i,
  /i (?:do not|don'?t) (?:have|support) (?:the ability|tools|the capability|access)/i,
  /i am unable to\b/i,
  /i'?m (?:an ai|a text-based|just a language model)/i,
  /as an ai(?: language model)?,? i (?:cannot|can'?t|do not|don'?t|am unable)/i,
  /i (?:cannot|can'?t) (?:directly )?(?:access|open|read|modify|create|write) (?:files|your (?:files|system|computer|machine))/i,
  /i (?:do not|don'?t) have (?:access to |the ability to run )?(?:a |the |your |any )?(?:terminal|shell|command line|filesystem|file system)/i,
  /no (?:shell|terminal|filesystem|tool) (?:access|available) (?:to me|here)?/i,
]

/** True when the text claims IMURUN's tools do not exist. */
export function detectCapabilityRefusal(text: string): boolean {
  if (!text || text.length > 4_000) return false
  const normalized = text.replace(/\s+/g, " ")
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(normalized))
}

/**
 * The corrective message. It names the real tools rather than arguing: a small
 * model is more likely to act on a concrete list than on a debate.
 */
export function capabilityNudge(tools: readonly string[]): string {
  const list = tools.filter(Boolean).slice(0, 14).join(", ")
  return (
    "[system] Correction to your last message: it is wrong. You are IMURUN, a coding agent running on the " +
    "user's machine, not a chat assistant. These tools are real and already connected to you: " +
    `${list}. The shell tool executes real commands on this computer; read, write and edit change real ` +
    "files; web_search and web_fetch reach the network. Never claim you cannot run commands, read files, " +
    "or execute programs — you can, and it is your job. Do the task now with the tools, then report the " +
    "actual result (files changed, command output), not an apology."
  )
}
