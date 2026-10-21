/**
 * The response engine: how this person wants to be answered, learned from the
 * conversation and kept in the system prompt.
 *
 *   profile  the dimensions, the directive, the redaction, the merge
 *   learn    the cheap per-turn counters (always on, deterministic)
 *   refine   the background model reading (invisible, advisory)
 *   store    ~/.imurun/models/response.json
 */
export * from "./profile"
export * from "./learn"
export * from "./store"
export * from "./refine"
