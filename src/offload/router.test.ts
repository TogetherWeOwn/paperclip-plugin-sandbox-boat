import { describe, expect, it } from "vitest";
import { cargoSideArgv, cargoToolchain, classifyCargo, isCargoOffline, type CargoProfile } from "./router.js";

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

  it("keeps the --config=value spelling local too, before and after the subcommand", () => {
    for (const argv of [
      ["build", "--config=build.rustflags=[\"-C\",\"link-arg=-foo\"]"],
      ["--config=net.offline=true", "build"],
    ]) {
      const result = classifyCargo(argv, PROFILE);
      expect(result.mode).toBe("local");
      expect(result.reason).toMatch(/config/i);
    }
  });

  it("keeps unrecognized --config overrides local", () => {
    const result = classifyCargo(["--config", "net.offline=true", "build"], PROFILE);
    expect(result.mode).toBe("local");
    expect(result.reason).toMatch(/config/i);
  });

  it("keeps -Z unstable flags local", () => {
    expect(classifyCargo(["-Z", "next-lockfile-bump", "build"], PROFILE).mode).toBe("local");
  });

  it("keeps path-bearing overrides local, matching the executor's refusal", () => {
    for (const argv of [
      ["check", "--manifest-path", "/home/ubuntu/build/two-bot-next/Cargo.toml", "-p", "two-bot"],
      ["test", "--manifest-path=crates/bot/Cargo.toml"],
      ["build", "--target-dir", "/tmp/t"],
      ["-C", "crates/bot", "check"],
    ]) {
      expect(classifyCargo(argv, PROFILE)).toMatchObject({ mode: "local", reason: expect.stringMatching(/^path-bearing option /) });
    }
    // Test-binary args after `--` are not Cargo options.
    expect(classifyCargo(["test", "--", "--target-dir"], PROFILE).mode).toBe("remote_candidate");
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

describe("cargo-side argv helpers", () => {
  it("treats args after a bare -- as test-binary args", () => {
    expect(cargoSideArgv(["test", "--", "--offline"])).toEqual(["test"]);
    expect(cargoSideArgv(["test", "--offline"])).toEqual(["test", "--offline"]);
    expect(cargoSideArgv([])).toEqual([]);
  });

  it("detects cargo --offline but not a test binary's --offline", () => {
    expect(isCargoOffline(["test", "--offline"])).toBe(true);
    expect(isCargoOffline(["test", "--", "--offline"])).toBe(false);
    expect(isCargoOffline(["test"])).toBe(false);
  });

  it("validates a leading rustup toolchain selector against the profile", () => {
    expect(cargoToolchain(["+stable", "test", "--offline"], PROFILE.toolchains)).toBe("+stable");
    // A toolchain-looking arg after `--` belongs to the test binary.
    expect(cargoToolchain(["test", "--", "+stable"], PROFILE.toolchains)).toBe(null);
    expect(cargoToolchain(["+nightly-2026-01-01", "build"], PROFILE.toolchains)).toBe(null);
    expect(cargoToolchain(["test"], PROFILE.toolchains)).toBe(null);
    expect(cargoToolchain([], PROFILE.toolchains)).toBe(null);
  });
});
