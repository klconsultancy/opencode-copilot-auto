// Packaging guards: one package serves both opencode lines. opencode 1 (>= 1.18.29)
// requires a default export of `{ id, server }`, opencode 2 one of `{ id, setup }`;
// each loader ignores the other entry.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import pkg from "../package.json"
import plugin from "../src/index"

describe("packaging", () => {
  const root = path.join(import.meta.dir, "..")
  const entry = (pkg as { exports?: { ["."]?: { import?: string } }; main?: string }).exports?.["."]?.import ?? pkg.main
  const rel = (entry ?? "").replace(/^\.\//, "")

  test("declares a package entry", () => {
    expect(rel.length).toBeGreaterThan(0)
  })

  test("entry file exists on disk", () => {
    expect(existsSync(path.join(root, rel))).toBe(true)
  })

  test("default export carries both entries under one id", () => {
    expect(typeof plugin.id).toBe("string")
    expect(plugin.id.length).toBeGreaterThan(0)
    expect(typeof plugin.server).toBe("function")
    expect(typeof plugin.setup).toBe("function")
  })

  test("declares no runtime dependencies", () => {
    expect((pkg as { dependencies?: object }).dependencies).toBeUndefined()
  })

  test("the bundle imports no opencode package (types only)", () => {
    const bundle = readFileSync(path.join(root, rel), "utf8")
    expect(bundle).not.toMatch(/from\s+["']@opencode/)
  })
})
