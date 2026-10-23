import { describe, expect, it } from "vitest";
import { OFFLOAD_BOUNDS } from "./protocol.js";
import { bodyTooLarge, validateSubmit } from "./validate.js";

const BASE = {
  version: 1,
  commandId: "7d82278c-2ba7-4e68-96ab-a2cc10b697af",
  executionWorkspaceId: "b9d0e6ac-a14e-4440-a324-7dcdd758be08",
  cwdRelative: ".",
  argv: ["test", "--locked", "--lib"],
  env: { CARGO_TERM_COLOR: "never", RUST_BACKTRACE: "1" },
  queueTimeoutMs: 30000,
  timeoutMs: 1200000,
  dryRun: false,
};

describe("validateSubmit", () => {
  it("accepts the documented request", () => {
    const result = validateSubmit(BASE);
    expect(result.ok).toBe(true);
  });

  it("rejects unknown keys instead of ignoring them", () => {
    const result = validateSubmit({ ...BASE, shell: "/bin/bash" });
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong version", () => {
    expect(validateSubmit({ ...BASE, version: 2 }).ok).toBe(false);
  });

  it("rejects non-UUID ids", () => {
    expect(validateSubmit({ ...BASE, commandId: "not-a-uuid" }).ok).toBe(false);
    expect(validateSubmit({ ...BASE, executionWorkspaceId: "x" }).ok).toBe(false);
  });

  it.each([["../.."], [["/abs/path"]], [["a/../../b"]], [[""]]])("rejects escaping cwd %s", (cwdRelative) => {
    expect(validateSubmit({ ...BASE, cwdRelative }).ok).toBe(false);
  });

  it("accepts nested cwd inside the workspace", () => {
    expect(validateSubmit({ ...BASE, cwdRelative: "crates/core" }).ok).toBe(true);
  });

  it("rejects more than 256 args", () => {
    expect(validateSubmit({ ...BASE, argv: Array.from({ length: 257 }, (_, i) => `a${i}`) }).ok).toBe(false);
  });

  it("rejects argv over 32 KiB encoded", () => {
    expect(validateSubmit({ ...BASE, argv: ["test", "x".repeat(33 * 1024)] }).ok).toBe(false);
  });

  it("rejects env over 4 KiB encoded", () => {
    const big = "x".repeat(5 * 1024);
    expect(validateSubmit({ ...BASE, env: { CARGO_TERM_COLOR: "never", PAD: big } }).ok).toBe(false);
  });

  it("rejects unlisted env keys instead of silently stripping them", () => {
    const result = validateSubmit({ ...BASE, env: { CARGO_TERM_COLOR: "never", DATABASE_URL: "postgres://x" } });
    expect(result.ok).toBe(false);
  });

  it("rejects secret canary keys", () => {
    expect(validateSubmit({ ...BASE, env: { GITHUB_TOKEN: "canary" } }).ok).toBe(false);
    expect(validateSubmit({ ...BASE, env: { PAPERCLIP_API_KEY: "canary" } }).ok).toBe(false);
  });

  it("rejects enum env values outside the allowlist", () => {
    expect(validateSubmit({ ...BASE, env: { CARGO_TERM_COLOR: "sometimes" } }).ok).toBe(false);
    expect(validateSubmit({ ...BASE, env: { RUST_BACKTRACE: "2" } }).ok).toBe(false);
  });

  it("rejects RUSTFLAGS without profile validation", () => {
    expect(validateSubmit({ ...BASE, env: { RUSTFLAGS: "-C debuginfo=1" } }).ok).toBe(false);
  });

  it("accepts bounded RUSTFLAGS after profile validation", () => {
    const result = validateSubmit({ ...BASE, env: { RUSTFLAGS: "-C debuginfo=1" } }, { allowRustflags: true });
    expect(result.ok).toBe(true);
  });

  it("rejects an env value carrying a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = validateSubmit({ ...BASE, env: { RUSTFLAGS: `--cfg x="${jwt}"` } }, { allowRustflags: true });
    expect(result.ok).toBe(false);
  });

  it("rejects out-of-range timeouts", () => {
    expect(validateSubmit({ ...BASE, queueTimeoutMs: 30001 }).ok).toBe(false);
    expect(validateSubmit({ ...BASE, queueTimeoutMs: -1 }).ok).toBe(false);
    expect(validateSubmit({ ...BASE, timeoutMs: 999 }).ok).toBe(false);
    expect(validateSubmit({ ...BASE, timeoutMs: 30 * 60_000 + 1 }).ok).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(validateSubmit(null).ok).toBe(false);
    expect(validateSubmit("nope").ok).toBe(false);
  });
});

describe("bodyTooLarge", () => {
  it("flags bodies over 64 KiB", () => {
    expect(bodyTooLarge("x".repeat(OFFLOAD_BOUNDS.maxBodyBytes + 1))).toBe(true);
    expect(bodyTooLarge("{}")).toBe(false);
  });
});
