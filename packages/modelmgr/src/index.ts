/**
 * @imurun/modelmgr — local model management.
 *
 *   hardware  — detect CPU/GPU/RAM/disk and score the machine
 *   registry  — bundled catalog + recommendation engine
 *   huggingface — resumable downloads, checksums, search
 *   install   — one-click install, engine binaries, installed-model store
 */
export * from "./hardware"
export * from "./registry"
export * from "./huggingface"
export * from "./install"
