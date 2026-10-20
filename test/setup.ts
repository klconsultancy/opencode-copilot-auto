// Keep test runs out of the real plugin log (~/.local/state/opencode-copilot-auto).
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), "opencode-copilot-auto-test-"))
