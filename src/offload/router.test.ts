import { describe, expect, it } from "vitest";
import { classifyCargo, type CargoProfile } from "./router.js";

const PROFILE: CargoProfile = { id: "rust-public-1", toolchains: ["stable", "1.88.0"] };

describe("classifyCargo", () => {
  it.each([
    ["build"],
    ["test"],
    ["check"],
    ["clippy"],
    ["nextest", "run"],
    ["llvm-cov"],
    ["llvm-cov", "test"],
    ["llvm-cov", "nextest"],
    ["llvm-cov", "run"],
  ])("routes %s to a remote candidate", (...argv) => {
    const result = classifyCargo(argv, PROFILE);
    expect(result.mode).toBe("remote_candidate");
    expect(result.profileId).toBe("rust-public-1");
  });

  it("parses +toolchain and global options before the subcommand", () => {
    const result = classifyCargo(["+stable", "--locked", "--verbose", "test", "--lib"], PROFILE);
    expect(result.mode).toBe("remote_candidate");
    expect(result.subcommand).toBe("test");
  });

  it.each([
    ["fmt"],
    ["add", "serde"],
    ["update"],
    ["remove", "serde"],
    ["metadata"],
    ["--version"],
    ["--help"],
    ["help", "build"],
    ["install", "ripgrep"],
    ["publish"],
    ["login"],
    ["run"],
    ["fetch"],
    ["tree"],
    ["unknown-alias-xyz"],
  ])("keeps %s local", (...argv) => {
    expect(classifyCargo(argv, PROFILE).mode).toBe("local");
  });

  it("keeps unrecognized --config overrides local", () => {
    const result = classifyCargo(["--config", "net.offline=true", "build"], PROFILE);
    expect(result.mode).toBe("local");
    expect(result.reason).toMatch(/config/i);
  });

  it("keeps -Z unstable flags local", () => {
    expect(classifyCargo(["-Z", "next-lockfile-bump", "build"], PROFILE).mode).toBe("local");
  });

  it("keeps an uninstalled toolchain local", () => {
    const result = classifyCargo(["+nightly-2026-01-01", "build"], PROFILE);
    expect(result.mode).toBe("local");
    expect(result.reason).toMatch(/toolchain/i);
  });

  it("keeps compound shell text local", () => {
    expect(classifyCargo(["build", "&&", "test"], PROFILE).mode).toBe("local");
    expect(classifyCargo(["test", "|", "head"], PROFILE).mode).toBe("local");
    expect(classifyCargo(["build;test"], PROFILE).mode).toBe("local");
  });

  it("keeps llvm-cov report/show local (not a compilation/test mode)", () => {
    expect(classifyCargo(["llvm-cov", "report"], PROFILE).mode).toBe("local");
    expect(classifyCargo(["llvm-cov", "show"], PROFILE).mode).toBe("local");
  });

  it("keeps bare nextest without run local", () => {
    expect(classifyCargo(["nextest"], PROFILE).mode).toBe("local");
    expect(classifyCargo(["nextest", "list"], PROFILE).mode).toBe("local");
  });

  it("keeps empty argv local", () => {
    expect(classifyCargo([], PROFILE).mode).toBe("local");
  });
});
