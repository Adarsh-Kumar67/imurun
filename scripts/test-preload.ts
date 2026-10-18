/**
 * Test preload — runs before any test file imports its modules.
 *
 * Chalk decides whether the terminal supports colour when it is first loaded
 * and caches the answer inside every style function, so colour can only be
 * switched on *before* the first import that touches chalk. A test process is
 * not a TTY, so without this every styled line would come out plain and the
 * tests that assert on colour would pass vacuously.
 *
 * See bunfig.toml.
 */
process.env.FORCE_COLOR = "1"
delete process.env.NO_COLOR

export {}
