// docs/configuration.md must document every config key the manifest declares,
// so a new key cannot ship without an operator-facing row.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import manifest from "./manifest.js";

const doc = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8");
const documented = (key: string) => doc.includes(`| \`${key}\``) || doc.includes(` / \`${key}\``);

it("documents every driver config key", () => {
  const keys = Object.keys(manifest.environmentDrivers![0]!.configSchema!.properties as object);
  expect(keys.length).toBeGreaterThan(20);
  expect(keys.filter((key) => !documented(key))).toEqual([]);
});

it("documents every company plugin setting", () => {
  const keys = Object.keys(manifest.instanceConfigSchema!.properties as object);
  expect(keys.length).toBeGreaterThan(5);
  expect(keys.filter((key) => !documented(key))).toEqual([]);
});
