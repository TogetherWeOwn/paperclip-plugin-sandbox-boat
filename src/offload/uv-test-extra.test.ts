import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UV_EXTRA_LOCK_BYTES, MAX_UV_EXTRA_MANIFEST_BYTES, supportsLockedUvTestExtra } from "./uv-test-extra.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const stdin = { on: vi.fn(), end: vi.fn() };
beforeEach(() => {
  vi.mocked(execFile).mockReset();
  stdin.on.mockReset();
  stdin.end.mockReset();
});

function result(error: Error | null, stdout: string): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string) => void;
    queueMicrotask(() => callback(error, stdout));
    return { stdin };
  }) as unknown as typeof execFile);
}

describe("isolated uv TOML validation", () => {
  it("uses only a fixed isolated interpreter with bounded resources and stdin data", async () => {
    result(null, "ok\n");
    expect(await supportsLockedUvTestExtra(Buffer.from("manifest"), Buffer.from("lock"))).toBe(true);
    expect(execFile).toHaveBeenCalledWith("/usr/bin/python3", ["-I", "-S", "-c", expect.any(String)], {
      cwd: "/", env: {}, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024,
    }, expect.any(Function));
    expect(stdin.end).toHaveBeenCalledWith(JSON.stringify(["manifest", "lock"]));
  });

  it.each([
    [new Error("ENOENT"), ""], [new Error("missing tomllib"), ""],
    [new Error("timeout"), "ok\n"], [null, ""], [null, "ok\nextra\n"],
  ])("fails closed for unavailable parser, failure or invalid output %#", async (error, stdout) => {
    result(error, stdout);
    expect(await supportsLockedUvTestExtra(Buffer.from("x"), Buffer.from("y"))).toBe(false);
  });

  it("rejects invalid UTF-8 and oversized inputs before starting a parser", async () => {
    expect(await supportsLockedUvTestExtra(Buffer.from([0xff]), Buffer.from("x"))).toBe(false);
    expect(await supportsLockedUvTestExtra(Buffer.alloc(MAX_UV_EXTRA_MANIFEST_BYTES + 1), Buffer.from("x"))).toBe(false);
    expect(await supportsLockedUvTestExtra(Buffer.from("x"), Buffer.alloc(MAX_UV_EXTRA_LOCK_BYTES + 1))).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("handles a closed parser stdin as a refusal", async () => {
    vi.mocked(execFile).mockReturnValue({ stdin } as never);
    stdin.on.mockImplementation((_event: string, callback: () => void) => queueMicrotask(callback));
    expect(await supportsLockedUvTestExtra(Buffer.from("x"), Buffer.from("y"))).toBe(false);
  });
});
