import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHandoverSources } from "../test-support/handover-sources.js";

const aliases = { cargo: "cargo", npm: "node", pnpm: "node", yarn: "node", npx: "node", pytest: "python", python: "python", python3: "python" } as const;
let root: string, sources: Awaited<ReturnType<typeof openHandoverSources>>;
beforeEach(async () => { root = mkdtempSync(join(tmpdir(), "handover-aliases-")); sources = await openHandoverSources(); });
afterEach(async () => {
  await sources.close();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ["old", "candidate"].includes(entry.name)) packageMode(join(root, entry.name), 0o755);
  }
  rmSync(root, { recursive: true, force: true });
});
function packageMode(dir: string, mode: number) {
  chmodSync(dir, mode);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) packageMode(file, mode);
    else chmodSync(file, mode);
  }
}

function packageFixture(version: "old" | "candidate") {
  const pkg = join(root, version);
  mkdirSync(join(pkg, "bin"), { recursive: true }); mkdirSync(join(pkg, "dist/offload"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), '{"type":"module"}');
  for (const tool of ["cargo", "node", "python"]) {
    copyFileSync(join(sources[version].root, `bin/boat-offload-${tool}`), join(pkg, `bin/boat-offload-${tool}`));
    chmodSync(join(pkg, `bin/boat-offload-${tool}`), 0o755);
  }
  // Source-only fixture: prove real bin import/alias resolution without a build.
  // The sentinel is explicitly NOT the production compiled implementation.
  writeFileSync(join(pkg, "dist/offload/shim-node.js"), 'export const createShimDeps = () => ({});');
  writeFileSync(join(pkg, "dist/offload/shim-main.js"), `export const NODE_SHIM = "node", PYTHON_SHIM = "python";
export async function shimMain(script, args, deps, tool = "cargo") {
  process.stdout.write(JSON.stringify({ version: "${version}", invoked: script.split("/").pop(), tool })); return 0;
}`);
  packageMode(pkg, 0o555); // Match staged packages' read-only immutable targets.
  return pkg;
}
function install(pkg: string, shimDir: string, env: Record<string, string> = {}) {
  // Pin the characterized EXIT/TERM behavior, not the host's /bin/sh choice.
  return spawnSync("dash", [join(sources.candidate.root, "scripts/install-offload-shims.sh"), pkg, shimDir], {
    encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin", ...env },
  });
}
function resolution(shims: string) {
  return Object.fromEntries(Object.keys(aliases).map((name) => [name, realpathSync(join(shims, name))]));
}
function invoke(file: string) {
  const result = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
function failingMv(after: number, signal = false) {
  const bin = join(root, "fault-bin"), counter = join(root, "rename-count");
  mkdirSync(bin, { recursive: true }); writeFileSync(counter, "0");
  writeFileSync(join(bin, "mv"), `#!/bin/sh
n=$(cat "$COUNTER")
if [ "$n" -ge "${after}" ]; then ${signal ? 'kill -TERM "$PPID";' : ""} exit 71; fi
/usr/bin/mv "$@" || exit $?
printf '%s' "$((n+1))" > "$COUNTER"
`, { mode: 0o755 });
  return { PATH: `${bin}:/usr/bin:/bin`, COUNTER: counter };
}

describe("eight aliases with actual pinned bins and publisher", () => {
  it("resolves/imports all aliases and retains old immutable targets after publication and restart", async () => {
    const old = packageFixture("old"), candidate = packageFixture("candidate"), shims = join(root, "shims");
    expect(install(old, shims).status).toBe(0);
    const retained = resolution(shims);
    expect(install(candidate, shims).status).toBe(0);
    for (const [name, tool] of Object.entries(aliases)) {
      expect(invoke(join(shims, name))).toEqual({ version: "candidate", invoked: name, tool });
      expect(invoke(retained[name]!)).toMatchObject({ version: "old", tool });
      expect(readFileSync(retained[name]!, "utf8")).toBe(readFileSync(join(sources.old.root, `bin/boat-offload-${tool}`), "utf8"));
    }
    await sources.close(); sources = await openHandoverSources();
    for (const name of Object.keys(aliases)) expect(resolution(shims)[name]).toBe(join(candidate, `bin/boat-offload-${aliases[name as keyof typeof aliases]}`));
    expect(readdirSync(shims).sort()).toEqual(Object.keys(aliases).sort());
    const main = await sources.candidate.load("src/offload/shim-main.ts");
    const node = await sources.candidate.load("src/offload/shim-node.ts");
    expect(main.shimMain).toBeTypeOf("function"); expect(node.createShimDeps).toBeTypeOf("function");
  });

  it.each([false, true])("a publication interruption leaves a resolvable mixed set, not an atomic transaction (signal=%s)", (signal) => {
    const old = packageFixture("old"), candidate = packageFixture("candidate"), shims = join(root, "shims");
    expect(install(old, shims).status).toBe(0);
    const failed = install(candidate, shims, failingMv(3, signal));
    expect(failed.status).not.toBe(0);
    const targets = resolution(shims), names = Object.keys(aliases);
    for (const [index, name] of names.entries()) {
      expect(targets[name]).toBe(join(index < 3 ? candidate : old, `bin/boat-offload-${aliases[name as keyof typeof aliases]}`));
      expect(invoke(join(shims, name)).version).toBe(index < 3 ? "candidate" : "old");
    }
    // Restore is another publication, not rollback of process/journal state.
    expect(install(old, shims).status).toBe(0);
    expect(Object.values(resolution(shims)).every((target) => target.startsWith(`${old}/`))).toBe(true);
    const entries = readdirSync(shims);
    expect(entries.filter((name) => !name.startsWith(".install.")).sort()).toEqual(names.sort());
    // The pinned script has only an EXIT trap. Dash's default TERM termination
    // can retain its staging directory; restoring aliases does not remove it.
    expect(entries.filter((name) => name.startsWith(".install."))).toHaveLength(signal ? 1 : 0);
  });

  it("a failed restore retains the exact mixed targets until an exclusive retry completes", () => {
    const old = packageFixture("old"), candidate = packageFixture("candidate"), shims = join(root, "shims");
    expect(install(old, shims).status).toBe(0);
    expect(install(candidate, shims, failingMv(3)).status).not.toBe(0);
    const mixed = resolution(shims);
    expect(install(old, shims, failingMv(0)).status).not.toBe(0);
    expect(resolution(shims)).toEqual(mixed);
    expect(install(candidate, shims).status).toBe(0);
    expect(Object.values(resolution(shims)).every((target) => target.startsWith(`${candidate}/`))).toBe(true);
  });

  it("characterizes the missing publisher lock: a second publisher can interleave", () => {
    const old = packageFixture("old"), candidate = packageFixture("candidate"), shims = join(root, "shims");
    expect(install(old, shims).status).toBe(0);
    const bin = join(root, "interleave-bin"), marker = join(root, "interleaved"); mkdirSync(bin);
    writeFileSync(join(bin, "mv"), `#!/bin/sh
/usr/bin/mv "$@" || exit $?
if [ ! -e "$MARKER" ]; then
  : > "$MARKER"
  PATH=/usr/bin:/bin dash "$PUBLISHER" "$OTHER_PACKAGE" "$SHIMS" >/dev/null || exit $?
fi
`, { mode: 0o755 });
    expect(install(candidate, shims, { PATH: `${bin}:/usr/bin:/bin`, MARKER: marker,
      PUBLISHER: join(sources.candidate.root, "scripts/install-offload-shims.sh"), OTHER_PACKAGE: old, SHIMS: shims }).status).toBe(0);
    expect(realpathSync(join(shims, "cargo"))).toBe(join(old, "bin/boat-offload-cargo"));
    expect(realpathSync(join(shims, "npm"))).toBe(join(candidate, "bin/boat-offload-node"));
    // This is proof an external exclusive publisher is a prerequisite, not an
    // assertion that the shipped script installs or enforces one.
    expect(dirname(readlinkSync(join(shims, "python3")))).toBe(join(candidate, "bin"));
  });
});
