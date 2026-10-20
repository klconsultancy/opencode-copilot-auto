// One package for both opencode lines: opencode 1 (>= 1.18.29) loads `server`,
// opencode 2 loads `setup`; each ignores the other entry.
import { PLUGIN_ID } from "./core"
import { server } from "./v1"
import { setup } from "./v2"

export default { id: PLUGIN_ID, server, setup }
