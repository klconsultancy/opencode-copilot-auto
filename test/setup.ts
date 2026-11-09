// Keep test runs out of the real plugin state (~/.local/state/opencode-copilot-auto):
// the log and the persisted routes.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Points the plugin at an empty state directory, so no test sees routes another one
// persisted. Returns it, for tests that reload the plugin on the same state.
export function freshStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-copilot-auto-test-"))
  process.env.XDG_STATE_HOME = dir
  return dir
}

freshStateDir()
