import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBudget, readBudget } from "./budget.js";
import { parseDriverConfig, validateDriverConfig } from "./config.js";
import {
  DEFAULT_ENV_ALLOWLIST,
  containsJwt,
  containsJwtInText,
  effectiveEnvAllowlist,
  filterRunEnv,
  isAcpProcessSessionCommand,
  parseEnvAllowlist,
} from "./env-policy.js";
import { describeBoatError } from "./errors.js";
import {
  BOATIGNORE_RUNTIME_RULE,
  REMOTE_ENV_STAGING_ROOT,
  RUNTIME_DIR_RESULT_RE,
  RUNTIME_SECRET_SCRUB_RESULT_RE,
  SCRUB_BASHRC_ASCII_TOKEN,
  TAR_SKIP_RUNTIME_DIR,
  buildLoginShellScript,
  buildRemoteCommand,
  buildRemoteEnvFileContents,
  newRemoteEnvStage,
  runtimeDirScript,
  scrubRuntimeSecretsScript,
  shellQuote,
  stageRemoteEnvCommand,
} from "./shell.js";
import type { RemoteEnvStage } from "./shell.js";
import { endpointFromSshKeyResponse } from "./ssh.js";
import { resolveVmKey, sandboxNameFor, sanitizeSnapshotName } from "./vm-manager.js";
import { cliEngineCalls, largeEnvelopeAcpLaunch } from "./test-support/acp-process-session.js";
import { PAPERCLIP_INSTRUCTION_GIT_EXCLUDE_PROGRAM } from "./test-support/paperclip-instruction-git-exclude.js";
import { responseError, trialLimits } from "./test-support/fake-boat.js";

describe("readBudget", () => {
  it("reads the flat GET /limits shape that boat returns on the trial", () => {
    const snapshot = readBudget(trialLimits({ creditUsedSeconds: 3600 }));
    expect(snapshot).toMatchObject({
      accessTier: "trial",
      canStart: true,
      activeSandboxes: 0,
      maxActiveSandboxes: 2,
      startsDayUsed: 0,
      startsDayLimit: 75,
      startsMinuteRemaining: 5,
      trialComputeCapHours: 25,
    });
    expect(snapshot.computeHoursLeft).toBe(24);
  });

  it("also reads fields nested under upgradeEffects (older SDK typings)", () => {
    const snapshot = readBudget({ ok: true, upgradeEffects: { canStart: true, activeSandboxes: 1, maxActiveSandboxes: 100, creditBalanceSeconds: 7200 } });
    expect(snapshot).toMatchObject({ activeSandboxes: 1, maxActiveSandboxes: 100, computeHoursLeft: 2 });
  });

  it("uses the smaller of the trial cap and the balance", () => {
    expect(readBudget(trialLimits({ creditBalanceSeconds: 1800 })).computeHoursLeft).toBe(0.5);
  });

  it("passes when everything is within limits and never counts past boat's own plan limits", () => {
    const config = parseDriverConfig({ maxActive: 50, maxStartsPerDay: 500 });
    expect(checkBudget(readBudget(trialLimits()), config, "default")).toBeNull();
    const refusal = checkBudget(readBudget(trialLimits({ activeSandboxes: 2 })), config, "default");
    expect(refusal?.limit).toBe("maxActive");
  });
});

describe("config", () => {
  it("defaults match the boat trial and the owner's cost rules", () => {
    expect(parseDriverConfig({})).toMatchObject({
      size: "small",
      autoStopMinutes: 120,
      idleStopMinutes: 5,
      staleLeaseMinutes: 20,
      maxActive: 2,
      maxStartsPerDay: 70,
      minComputeHoursLeft: 1,
      noEnv: true,
      failFast: true,
      apiBase: "https://boat.dev/api/v1",
      templateSnapshot: null,
    });
  });

  // The workspace root must be where the home ~/.boatignore applies, or every start fails at the runtime directory (and spends a start).
  it("accepts remoteWorkspaceDir only as a plain absolute path below /home/user, and blank", () => {
    const errorsFor = (remoteWorkspaceDir: unknown) =>
      validateDriverConfig(parseDriverConfig({ apiKey: "k", remoteWorkspaceDir }), { apiKey: "k", remoteWorkspaceDir }).errors.filter((error) =>
        error.startsWith("remoteWorkspaceDir"),
      );
    for (const ok of [undefined, "", "/home/user/custom-ws", "/home/user/a/b/", "/home/user/w o'rk"]) {
      expect([ok, errorsFor(ok)]).toEqual([ok, []]);
    }
    for (const bad of ["/srv/ws", "/tmp/ws", "/home/user", "/home/user/", "/home/username/ws", "relative/ws", "~/ws", "$HOME/ws", "/home/user/../x", "/home/user/a/./b", "/home/user/a\nb"]) {
      expect([bad, errorsFor(bad).length]).toEqual([bad, 1]);
    }
  });
});

describe("env policy", () => {
  const decide = (name: string, value: string, allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST) => {
    const result = filterRunEnv({ [name]: value }, allowlist);
    return result.kept.length === 1 ? "kept" : result.dropped[0].reason;
  };

  it("drops every name the allowlist does not list (default deny)", () => {
    expect(decide("PLANETSCALE_PROD_URL", "mysql://u:p@aws.connect.psdb.cloud/db")).toBe("not_allowlisted");
    expect(decide("SERVICE_TOKEN", "x")).toBe("not_allowlisted");
    expect(decide("BETTER_AUTH_SECRET", "x")).toBe("not_allowlisted");
    expect(decide("ANTHROPIC_API_KEY", "sk-x")).toBe("not_allowlisted");
    expect(decide("OPENAI_API_KEY", "sk-x")).toBe("not_allowlisted");
    expect(decide("PAPERCLIP_PROCESS_SESSION_COMMAND_B64", "eyJ9")).toBe("not_allowlisted");
    expect(decide("PAPERCLIP_RUNTIME_SERVICES_JSON", "[]")).toBe("not_allowlisted");
    expect(decide("SSH_AUTH_SOCK", "/tmp/agent")).toBe("not_allowlisted");
  });

  it("keeps what a Claude run needs through the model-proxy tunnel and the Paperclip bridge", () => {
    for (const [name, value] of [
      ["ANTHROPIC_BASE_URL", "http://127.0.0.1:8317"],
      ["ANTHROPIC_AUTH_TOKEN", "sk-pilot-proxy-key"],
      ["ANTHROPIC_DEFAULT_SONNET_MODEL", "muse-spark"],
      ["CLAUDE_CODE_SUBAGENT_MODEL", "muse-spark"],
      ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", "32000"],
      ["MAX_THINKING_TOKENS", "8000"],
      ["PAPERCLIP_API_KEY", "Zm9vYmFyYmF6cXV4"],
      ["PAPERCLIP_BRIDGE_TOKEN", "Zm9vYmFyYmF6cXV4"],
      ["PAPERCLIP_BRIDGE_PORT", "41234"],
      ["PAPERCLIP_WORKSPACES_JSON", '[{"repoUrl":"https://github.com/o/r"}]'],
      ["LC_ALL", "C.UTF-8"],
      ["PATH", "/usr/local/bin:/usr/bin:/bin"],
    ] as const) {
      expect([name, decide(name, value)]).toEqual([name, "kept"]);
    }
  });

  // TOG-43128: Paperclip's managed `git`/`gh` launchers read the run-scoped
  // GitHub capability from PAPERCLIP_GITHUB_BROKER_TOKEN. It is an HS256 JWT
  // minted per run, so the blanket JWT rule dropped it and every push from a
  // whole-run VM failed with `capability_missing`.
  describe("managed GitHub capability (PAPERCLIP_GITHUB_BROKER_TOKEN)", () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const capability = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }) => {
      const now = Math.floor(Date.now() / 1000);
      return `${b64(header)}.${b64({
        sub: "agent-1",
        company_id: "company-1",
        run_id: "run-1",
        responsible_user_id: "user-1",
        scope: "github_credentials",
        iat: now,
        exp: now + 3600,
        ...claims,
      })}.c2lnbmF0dXJl`;
    };
    const deliver = (token: string, allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST, extra: Record<string, string> = { PAPERCLIP_RUN_ID: "run-1" }) => {
      const result = filterRunEnv({ PAPERCLIP_GITHUB_BROKER_TOKEN: token, ...extra }, allowlist);
      return result.kept.some(([name]) => name === "PAPERCLIP_GITHUB_BROKER_TOKEN")
        ? "kept"
        : result.dropped.find((entry) => entry.name === "PAPERCLIP_GITHUB_BROKER_TOKEN")?.reason;
    };

    it("delivers the run's github_credentials capability by default", () => {
      expect(deliver(capability())).toBe("kept");
    });

    it("still drops it from a custom list that does not name it exactly, prefix entries included", () => {
      expect(deliver(capability(), ["PAPERCLIP_RUN_ID", "PAPERCLIP_GITHUB_*"])).toBe("github_capability_rejected");
      expect(deliver(capability(), ["PAPERCLIP_RUN_ID"])).toBe("not_allowlisted");
      expect(deliver(capability(), ["PAPERCLIP_RUN_ID", "PAPERCLIP_GITHUB_BROKER_TOKEN"])).toBe("kept");
      expect(deliver(capability(), [])).toBe("not_allowlisted");
    });

    it("drops any other JWT under that name: another scope, another run, expired, wrong algorithm, malformed", () => {
      expect(deliver(capability({ scope: "connection_intents" }))).toBe("github_capability_rejected");
      expect(deliver(capability({ scope: undefined }))).toBe("github_capability_rejected");
      expect(deliver(capability({ run_id: "run-2" }))).toBe("github_capability_rejected");
      expect(deliver(capability({ run_id: undefined }))).toBe("github_capability_rejected");
      expect(deliver(capability({ exp: Math.floor(Date.now() / 1000) - 5 }))).toBe("github_capability_rejected");
      expect(deliver(capability({ exp: "never" }))).toBe("github_capability_rejected");
      expect(deliver(capability({}, { alg: "none", typ: "JWT" }))).toBe("github_capability_rejected");
      expect(deliver(capability(), DEFAULT_ENV_ALLOWLIST, {})).toBe("github_capability_rejected");
      expect(deliver(capability(), DEFAULT_ENV_ALLOWLIST, { PAPERCLIP_RUN_ID: "" })).toBe("github_capability_rejected");
      expect(deliver(`${capability()}.extra`)).toBe("github_capability_rejected");
      expect(deliver(`${capability().split(".").slice(0, 2).join(".")}.`)).toBe("github_capability_rejected");
      expect(deliver(`Bearer ${capability()}`)).toBe("github_capability_rejected");
      expect(deliver(`${capability()} ${capability()}`)).toBe("github_capability_rejected");
      expect(deliver(`eyJ${"a".repeat(8192)}.eyJ${"b".repeat(8192)}.sig`)).toBe("github_capability_rejected");
    });

    // Review of PR #30: the name is an exclusive branch. Anything that is not the
    // run's capability is dropped, also when it is no JWT at all, so a raw GitHub
    // token under that name never reaches the VM, even from a list naming it exactly.
    it("drops a raw GitHub token or any other non-capability value under that name, even from a list that names it exactly", () => {
      const exactList = ["PAPERCLIP_RUN_ID", "PAPERCLIP_GITHUB_BROKER_TOKEN"];
      const values = [
        `ghp_${"A".repeat(36)}`,
        `github_pat_11ABCDEFG0${"x".repeat(70)}`,
        `gho_${"B".repeat(36)}`,
        "not-a-token",
        "a.b.c",
        "",
        " ",
        `${capability()}\n`,
        `x-access-token:ghp_${"C".repeat(36)}`,
      ];
      for (const value of values) {
        for (const list of [DEFAULT_ENV_ALLOWLIST, exactList]) {
          expect([value, deliver(value, list)]).toEqual([value, "github_capability_rejected"]);
        }
      }
    });

    it("keeps every other JWT dropped, and never sends the controller's broker URL (the launcher then uses the in-VM bridge)", () => {
      const result = filterRunEnv(
        {
          PAPERCLIP_RUN_ID: "run-1",
          PAPERCLIP_API_KEY: capability(),
          PAPERCLIP_GITHUB_BRIDGE_TOKEN: capability(),
          PAPERCLIP_GITHUB_BROKER_URL: "https://paperclip.example.com/api",
          GITHUB_TOKEN: capability(),
        },
        DEFAULT_ENV_ALLOWLIST,
      );
      expect(result.kept).toEqual([["PAPERCLIP_RUN_ID", "run-1"]]);
      expect(result.dropped).toEqual(
        expect.arrayContaining([
          { name: "PAPERCLIP_API_KEY", reason: "jwt" },
          { name: "PAPERCLIP_GITHUB_BRIDGE_TOKEN", reason: "not_allowlisted" },
          { name: "PAPERCLIP_GITHUB_BROKER_URL", reason: "not_allowlisted" },
          { name: "GITHUB_TOKEN", reason: "not_allowlisted" },
        ]),
      );
    });
  });

  // Review of PR #30: Paperclip's prepareGitHubOperationLaunchers (adapter-utils
  // execution-target.ts) returns PATH=<launcher dir>:<VM PATH>, ZDOTDIR=<launcher
  // dir> and BASH_ENV=<launcher dir>/.bashrc. Those profiles put the launcher dir
  // back first on PATH in nested and login shells, where /etc/profile or
  // ~/.profile can rebuild PATH. For a sandbox target the dir is a VM path:
  // <remoteCwd>/.paperclip-runtime/paperclip-runner/github/<run id>.
  describe("managed GitHub launcher shells (ZDOTDIR, BASH_ENV)", () => {
    const dir = "/home/user/paperclip-workspace/.paperclip-runtime/paperclip-runner/github/run-1";
    const launcherEnv = (overrides: Record<string, string> = {}) => ({
      PATH: `${dir}:/usr/local/bin:/usr/bin:/bin`,
      ZDOTDIR: dir,
      BASH_ENV: `${dir}/.bashrc`,
      ...overrides,
    });
    const outcome = (env: Record<string, string>, allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST) => {
      const result = filterRunEnv(env, allowlist);
      return Object.fromEntries(
        ["ZDOTDIR", "BASH_ENV"].map((name) => [
          name,
          result.kept.some(([key]) => key === name) ? "kept" : result.dropped.find((entry) => entry.name === name)?.reason,
        ]),
      );
    };

    it("delivers them when they are the launcher dir that leads PATH", () => {
      const result = filterRunEnv(launcherEnv(), DEFAULT_ENV_ALLOWLIST);
      expect(result.kept).toEqual([
        ["PATH", `${dir}:/usr/local/bin:/usr/bin:/bin`],
        ["ZDOTDIR", dir],
        ["BASH_ENV", `${dir}/.bashrc`],
      ]);
      // The anonymous (unconfigured) launcher dir is named differently but sits in the same place.
      const anonymous = "/home/user/w/.paperclip-runtime/paperclip-runner/github/anonymous-agent-1-0123456789abcdef";
      expect(outcome({ PATH: `${anonymous}:/usr/bin`, ZDOTDIR: anonymous, BASH_ENV: `${anonymous}/.bashrc` })).toEqual({ ZDOTDIR: "kept", BASH_ENV: "kept" });
      const dotted = "/home/user/.cache/ws/.paperclip-runtime/paperclip-runner/github/run-1";
      expect(outcome({ PATH: dotted, ZDOTDIR: dotted, BASH_ENV: `${dotted}/.bashrc` })).toEqual({ ZDOTDIR: "kept", BASH_ENV: "kept" });
    });

    it("drops any other value: host paths, other files, a dir PATH does not lead with, path tricks", () => {
      const mismatch = { ZDOTDIR: "github_launcher_mismatch", BASH_ENV: "github_launcher_mismatch" };
      expect(outcome(launcherEnv({ ZDOTDIR: "/home/ubuntu", BASH_ENV: "/tmp/evil.sh" }))).toEqual(mismatch);
      expect(outcome(launcherEnv({ BASH_ENV: `${dir}/.zshrc` }))).toEqual({ ZDOTDIR: "kept", BASH_ENV: "github_launcher_mismatch" });
      expect(outcome(launcherEnv({ ZDOTDIR: `${dir}/` }))).toEqual({ ZDOTDIR: "github_launcher_mismatch", BASH_ENV: "kept" });
      expect(outcome(launcherEnv({ PATH: `/usr/bin:${dir}` }))).toEqual(mismatch);
      expect(outcome({ ZDOTDIR: dir, BASH_ENV: `${dir}/.bashrc` })).toEqual(mismatch);
      for (const other of [
        "/home/user/w/../../../etc/.paperclip-runtime/paperclip-runner/github/run-1",
        "/home/user/w/./.paperclip-runtime/paperclip-runner/github/run-1",
        "/home/user/w/.paperclip-runtime/claude/github/run-1",
        "/home/user/w/.paperclip-runtime/paperclip-runner/github/run-1/x",
        "/home/user/w/.paperclip-runtime/paperclip-runner/github/run 1",
        "home/user/w/.paperclip-runtime/paperclip-runner/github/run-1",
        "/tmp/paperclip-github-runtime/run-1",
      ]) {
        expect([other, outcome({ PATH: `${other}:/usr/bin`, ZDOTDIR: other, BASH_ENV: `${other}/.bashrc` })]).toEqual([other, mismatch]);
      }
    });

    it("keeps the rest of the launcher env out, and needs the names on the list", () => {
      const result = filterRunEnv(
        launcherEnv({ GH_CONFIG_DIR: `${dir}/gh-config`, GIT_CONFIG_GLOBAL: "/dev/null", SSH_AUTH_SOCK: "", PAPERCLIP_GITHUB_LAUNCHER_DIR: dir }),
        DEFAULT_ENV_ALLOWLIST,
      );
      expect(result.kept.map(([name]) => name)).toEqual(["PATH", "ZDOTDIR", "BASH_ENV"]);
      expect(outcome(launcherEnv(), ["PATH"])).toEqual({ ZDOTDIR: "not_allowlisted", BASH_ENV: "not_allowlisted" });
    });

    describe("in a real shell", () => {
      let root: string;
      afterEach(() => rmSync(root, { recursive: true, force: true }));

      // The VM side, played by local sh/bash: a system `git` and a login
      // profile that rebuilds PATH without the launcher dir (as Debian's
      // /etc/profile does), Paperclip's launcher dir with its `git` and the
      // profile prepareGitHubOperationLaunchers writes, then the plugin's
      // staged env file and login-shell script.
      function vmRun(dropFromStaged: readonly string[] = []) {
        root = mkdtempSync(path.join(tmpdir(), "pcb-launcher-"));
        const sysbin = path.join(root, "sysbin");
        const home = path.join(root, "home");
        const workspace = path.join(root, "paperclip-workspace");
        const launcher = path.join(workspace, ".paperclip-runtime", "paperclip-runner", "github", "run-1");
        for (const created of [sysbin, home, launcher]) mkdirSync(created, { recursive: true });
        const vmPath = `${sysbin}:/usr/bin:/bin`;
        writeFileSync(path.join(sysbin, "git"), "#!/bin/sh\necho system-git\n", { mode: 0o755 });
        writeFileSync(path.join(home, ".profile"), `export PATH=${shellQuote(vmPath)}\n`);
        // The launcher stand-in reports where Paperclip's real launcher would post
        // (github-launcher.ts: PAPERCLIP_GITHUB_BROKER_URL || PAPERCLIP_API_URL) and
        // whether it holds the capability.
        writeFileSync(
          path.join(launcher, "git"),
          '#!/bin/sh\necho "launcher-git ${PAPERCLIP_GITHUB_BROKER_URL:-$PAPERCLIP_API_URL}/runtime-tools/github/credentials ${PAPERCLIP_GITHUB_BROKER_TOKEN:+capability}"\n',
          { mode: 0o700 },
        );
        writeFileSync(path.join(launcher, ".bashrc"), `export PATH=${shellQuote(`${launcher}:${vmPath}`)}\n`);
        const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const capability = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ run_id: "run-1", scope: "github_credentials", exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
        // What Paperclip hands the provider's Execute for the agent command.
        const hostEnv = {
          PATH: `${launcher}:${vmPath}`,
          HOME: home,
          ZDOTDIR: launcher,
          BASH_ENV: `${launcher}/.bashrc`,
          GH_CONFIG_DIR: `${launcher}/gh-config`,
          PAPERCLIP_RUN_ID: "run-1",
          PAPERCLIP_API_URL: "http://127.0.0.1:41234",
          PAPERCLIP_GITHUB_BROKER_URL: "http://paperclip.internal:3100",
          PAPERCLIP_GITHUB_BROKER_TOKEN: capability,
        };
        const kept = filterRunEnv(hostEnv, DEFAULT_ENV_ALLOWLIST).kept.filter(([name]) => !dropFromStaged.includes(name));
        const stageDir = path.join(root, "stage");
        const stage = { dir: stageDir, path: path.join(stageDir, "env.sh") };
        const vmEnv = { PATH: vmPath, HOME: home };
        execFileSync("sh", ["-c", stageRemoteEnvCommand(stage)], { input: buildRemoteEnvFileContents(kept), env: vmEnv });
        const payload = 'command -v git; git push; sh -c "git push"; bash -c "git push"; bash -lc "git push"';
        const script = buildLoginShellScript({ command: "sh", args: ["-c", payload], cwd: workspace, remoteEnv: stage });
        const run = spawnSync("sh", ["-c", buildRemoteCommand(script)], { env: vmEnv, encoding: "utf8" });
        return { launcher, run, kept };
      }

      it("resolves git to the launcher first in the agent's shell, nested shells and login shells, and the launcher posts to the bridge", () => {
        const { launcher, run, kept } = vmRun();
        expect(kept.find(([name]) => name === "PATH")?.[1].split(":")[0]).toBe(launcher);
        expect(run.status).toBe(0);
        const via = "launcher-git http://127.0.0.1:41234/runtime-tools/github/credentials capability";
        expect(run.stdout.trim().split("\n")).toEqual([path.join(launcher, "git"), via, via, via, via]);
      });

      it("without BASH_ENV a login shell's profile hides the launcher (why it is delivered)", () => {
        const { run } = vmRun(["BASH_ENV"]);
        expect(run.stdout.trim().split("\n").at(-1)).toBe("system-git");
      });
    });
  });

  it("a NAME_* prefix never delivers a secret-looking name; an exact entry does", () => {
    expect(decide("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-x")).toBe("secret_name_needs_exact_entry");
    expect(decide("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "not-a-number")).toBe("secret_name_needs_exact_entry");
    for (const name of ["CARGO_REGISTRY_TOKEN", "CARGO_SECRET", "CARGO_PASSWORD", "CARGO_API_KEY", "CARGO_PRIVATE_KEY", "CARGO_CREDENTIALS"]) {
      expect([name, decide(name, "x", ["CARGO_*"])]).toEqual([name, "secret_name_needs_exact_entry"]);
      expect([name, decide(name, "x", [name])]).toEqual([name, "kept"]);
    }
  });

  it("treats ..._KEY, SIGNING, HMAC, SALT, _AUTH and _PAT names as secrets: a prefix never delivers them, an exact entry does", () => {
    // Both match a built-in prefix (PAPERCLIP_BRIDGE_*, LC_*), and must still be dropped.
    expect(decide("PAPERCLIP_BRIDGE_SIGNING_KEY", "k3y")).toBe("secret_name_needs_exact_entry");
    expect(decide("LC_SESSION_KEY", "k3y")).toBe("secret_name_needs_exact_entry");
    expect(decide("PAPERCLIP_BRIDGE_SIGNING_KEY", "k3y", ["PAPERCLIP_BRIDGE_SIGNING_KEY"])).toBe("kept");
    expect(decide("LC_SESSION_KEY", "k3y", ["LC_SESSION_KEY"])).toBe("kept");
    for (const name of ["CARGO_KEY", "CARGO_SIGNING_CERT", "CARGO_WEBHOOK_HMAC", "CARGO_SALT", "CARGO_HASH_SALT_V2", "CARGO_AUTH", "CARGO_PAT", "cargo_key"]) {
      expect([name, decide(name, "x", ["CARGO_*", "cargo_*"])]).toEqual([name, "secret_name_needs_exact_entry"]);
      expect([name, decide(name, "x", [name])]).toEqual([name, "kept"]);
    }
    expect(decide("KEY", "x", ["KEY"])).toBe("kept");
    expect(decide("KEY", "x", ["K_*"])).toBe("not_allowlisted");
    // Look-alikes that are not secret names still pass through a prefix.
    for (const name of ["CARGO_MONKEY", "CARGO_KEYBOARD", "CARGO_AUTHOR", "CARGO_PATH", "CARGO_AUTH_SOCK"]) {
      expect([name, decide(name, "x", ["CARGO_*"])]).toEqual([name, "kept"]);
    }
    // The built-in list still delivers everything a Claude run needs.
    expect(decide("PAPERCLIP_BRIDGE_PORT", "41234")).toBe("kept");
    expect(decide("LC_ALL", "C.UTF-8")).toBe("kept");
  });

  it("an empty envAllowlist delivers nothing; unset means the built-in list", () => {
    expect(parseEnvAllowlist([])).toEqual([]);
    expect(parseEnvAllowlist(["", "  "])).toEqual([]);
    expect(parseEnvAllowlist("")).toBeNull();
    expect(parseEnvAllowlist(" , ")).toBeNull();
    expect(effectiveEnvAllowlist([])).toEqual([]);
    expect(effectiveEnvAllowlist(null)).toBe(DEFAULT_ENV_ALLOWLIST);
    const config = parseDriverConfig({ apiKey: "k", envAllowlist: [] });
    expect(config.envAllowlist).toEqual([]);
    const result = filterRunEnv({ PATH: "/usr/bin", ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", PAPERCLIP_RUN_ID: "r1" }, effectiveEnvAllowlist(config.envAllowlist));
    expect(result.kept).toEqual([]);
    expect(result.dropped.map((entry) => entry.reason)).toEqual(["not_allowlisted", "not_allowlisted", "not_allowlisted"]);
    const { errors, warnings } = validateDriverConfig(config, { apiKey: "k", envAllowlist: [] });
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/envAllowlist is empty: no run env reaches the VM \(deny-all\)/);
    expect(warnings.join("\n")).not.toMatch(/does not deliver/);
  });

  it("drops a value with a JWT anywhere in it: behind Bearer, inside JSON or a header, with spaces around", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";
    for (const value of [
      jwt,
      `Bearer ${jwt}`,
      `bearer ${jwt}`,
      `  ${jwt}\n`,
      `Authorization: Bearer ${jwt}`,
      JSON.stringify([{ repoUrl: "https://github.com/o/r", token: jwt }]),
      JSON.stringify({ headers: { Authorization: `Bearer ${jwt}` } }),
      `${jwt}.extra-part`,
      // A JWE (5 parts) also starts with a JSON header and a dot.
      "eyJhbGciOiJSU0EtT0FFUCJ9.eyJ6aXAiOiJERUYifQ.a.b.c",
    ]) {
      expect([value, decide("PAPERCLIP_WORKSPACES_JSON", value)]).toEqual([value, "jwt"]);
      expect(containsJwt(value)).toBe(true);
    }
    // A whole-value JWT whose payload is not `{"...` (anchored form), with or without Bearer.
    expect(decide("PAPERCLIP_API_KEY", "eyJhbGciOiJIUzI1NiJ9.e30.c2ln")).toBe("jwt");
    expect(decide("PAPERCLIP_API_KEY", "Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2ln")).toBe("jwt");
    // base64 JSON without the dotted JWT shape is not a JWT.
    for (const value of ["eyJvayI6dHJ1ZX0=", "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo", "eyJhIjoxfQ.notjson", "v1.eyJhIjoxfQ"]) {
      expect([value, containsJwt(value)]).toEqual([value, false]);
    }
  });

  // The host passes values of any size. Before, an unanchored `eyJ[...]+\.`
  // tried from every offset of `eyJeyJeyJ...` took 12 s on 256 KB, and the URL
  // pattern took 28 s on 256 KB of letters (measured on rbx1, Node 24).
  it("decides a 256 KB adversarial value in under 50 ms, and still finds a JWT or a remote URL at its very end", () => {
    const size = 256 * 1024;
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const shapes: Array<[string, string, string]> = [
      ["eyJ repeated (JWT header runs, no dot)", fill("eyJ"), "kept"],
      ["eyJ. repeated (header then dot, no payload)", fill("eyJ."), "kept"],
      ["one header, then a payload run with no closing dot", `eyJa.eyJ${fill("a")}`, "kept"],
      ["letters with no ://", fill("a"), "kept"],
      ["scheme characters, no letter", fill("1+.-"), "kept"],
      // URL-like but not one parseable URL: dropped (fail closed), and decided fast.
      ["one URL whose authority is all colons", `a://${fill(":")}`, "remote_database_or_credential_url"],
      ["user:password@ shapes with no scheme", fill("a:a@"), "remote_database_or_credential_url"],
      ["colon runs with no @", `x${fill(":a")}`, "kept"],
      ["a JWT after 256 KB of eyJ", `${fill("eyJ")} ${jwt}`, "jwt"],
      ["a Bearer JWT after 256 KB of letters", `${fill("a")} Bearer ${jwt}`, "jwt"],
      ["a remote database URL after 256 KB of letters", `${fill("a")} postgres://u:p@db.example.com/x`, "remote_database_or_credential_url"],
    ];
    filterRunEnv({ PAPERCLIP_WORKSPACES_JSON: `warm-up ${jwt} https://example.com` }, DEFAULT_ENV_ALLOWLIST);
    for (const [label, value, expected] of shapes) {
      let best = Number.POSITIVE_INFINITY;
      let decision = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = performance.now();
        decision = decide("PAPERCLIP_WORKSPACES_JSON", value);
        best = Math.min(best, performance.now() - started);
      }
      expect({ label, decision, under50ms: best < 50 }).toEqual({ label, decision: expected, under50ms: true });
    }
  });

  it("finds JWTs exactly where the old backtracking pattern did, and never keeps a credential shape outside a VM-local URL authority (fuzzed)", () => {
    const oldJwt = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./;
    let seed = 20261022;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const text = (parts: string[]) => Array.from({ length: 1 + Math.floor(next() * 16) }, () => parts[Math.floor(next() * parts.length)]).join("");
    // Any `user:password@` a parser could see: a `:` and then an `@` in the same run of non-separator characters.
    const credentialShape = /:[^\s/@]*@/;
    const localAuthority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#@]*@(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#][^@]*)?$/i;
    let keptWithAt = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const a = text(["e", "y", "J", "eyJ", "eyJ", "a", "Z", "9", ".", ".", "-", "_", " ", '"', "="]);
      expect([a, containsJwtInText(a)]).toEqual([a, oldJwt.test(a)]);
      const b = text(["a", "Z", "1", "+", ".", "-", ":", "/", "//", "://", "://", " ", '"', "'", "\\/", "<", "@", "p", "localhost", "127.0.0.1", "?", "#", "%3A%2F%2F"]);
      if (decide("TEST_DATABASE_URL", b, ["TEST_DATABASE_URL"]) !== "kept" && decide("PAPERCLIP_WORKSPACE_REPO_URL", b) !== "kept") continue;
      if (b.includes("@")) keptWithAt += 1;
      if (credentialShape.test(b)) expect([b, localAuthority.test(b.trim())]).toEqual([b, true]);
    }
    expect(keptWithAt).toBeGreaterThan(0);
  });

  it("never delivers provider credential families, JWTs, or database URLs that leave the VM, even when listed exactly", () => {
    for (const name of ["PLANETSCALE_PROD_URL", "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "DISCORD_BOT_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "BOAT_API_KEY", "ASCII_TOKEN", "planetscale_org"]) {
      expect([name, decide(name, "x", [name])]).toEqual([name, "denied_family"]);
    }
    expect(decide("PAPERCLIP_API_KEY", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln")).toBe("jwt");
    expect(decide("ANTHROPIC_AUTH_TOKEN", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln")).toBe("jwt");
    expect(decide("DATABASE_URL", "postgres://u:p@prod.example.net/db", ["DATABASE_URL"])).toBe("remote_database_or_credential_url");
    expect(decide("DATABASE_URL", "https://aws.connect.psdb.cloud", ["DATABASE_URL"])).toBe("remote_database_or_credential_url");
    expect(decide("DATABASE_URL", "host=prod password=x", ["DATABASE_URL"])).toBe("remote_database_or_credential_url");
    expect(decide("REDIS_CONN", "rediss://default:pw@10.0.0.5:6379", ["REDIS_CONN"])).toBe("remote_database_or_credential_url");
    expect(decide("SERVICE_JSON", '{"url":"mysql://u:p@db.example.com/x"}', ["SERVICE_JSON"])).toBe("remote_database_or_credential_url");
    // A URL with a password that leaves the VM, under an innocent name.
    expect(decide("PAPERCLIP_WORKSPACE_REPO_URL", "https://x-access-token:ghs_x@github.com/o/r")).toBe("remote_database_or_credential_url");
  });

  it("a database URL that stays on the VM needs an exact entry", () => {
    const local = "postgres://postgres:pw@127.0.0.1:5432/two_bot_test_local";
    expect(decide("TWO_TEST_DATABASE_URL", local, ["TWO_*"])).toBe("secret_name_needs_exact_entry");
    expect(decide("TWO_TEST_DATABASE_URL", local, ["TWO_TEST_DATABASE_URL"])).toBe("kept");
    expect(decide("TEST_DATABASE_URL", "postgres://p:p@127.0.0.1:5432/t", ["TEST_DATABASE_URL"])).toBe("kept");
    expect(decide("TEST_DATABASE_URL", "postgres://p:p@[::1]:5432/t", ["TEST_DATABASE_URL"])).toBe("kept");
    expect(decide("TEST_DATABASE_URL", "postgres://p:p@192.168.1.4:5432/t", ["TEST_DATABASE_URL"])).toBe("remote_database_or_credential_url");
  });

  // Review round 4: a URL tokenizer that stops at a quote parsed only a
  // harmless prefix, and a JSON-escaped URL was not seen at all.
  it("never takes a parsed URL prefix as proof: a value with anything URL-like is kept only when it is, as a whole, one URL that is safe", () => {
    const remote = "remote_database_or_credential_url";
    for (const [name, value] of [
      // The username holds an apostrophe; the old tokenizer stopped there and parsed only https://o/.
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://o/'reilly:synthetic-password@github.com/o/r"],
      ["PAPERCLIP_WORKSPACE_REPO_URL", 'https://o/"reilly:synthetic-password@github.com/o/r'],
      // A remote database URL with JSON-escaped slashes, inside JSON and as a bare value.
      ["PAPERCLIP_WORKSPACES_JSON", '[{"repoUrl":"postgres:\\/\\/u:synthetic-password@db.example.com\\/x"}]'],
      ["PAPERCLIP_WORKSPACES_JSON", '{"u":"postgres:\\u002f\\u002fu:synthetic-password@db.example.com/x"}'],
      // An `@` behind a JSON escape: the raw text shows no URL at all.
      ["PAPERCLIP_WORKSPACES_JSON", '{"u":"u:synthetic-password\\u0040db.example.com"}'],
      ["PAPERCLIP_WORKSPACES_JSON", 'prefix "postgres:\\/\\/u:synthetic-password@db.example.com\\/x"'],
      ["PAPERCLIP_WORKSPACES_JSON", "postgres%3A%2F%2Fu%3Asynthetic-password%40db.example.com%2Fx"],
      // user:password@host with no scheme at all.
      ["PAPERCLIP_WORKSPACE_REPO_URL", "u:synthetic-password@db.example.com/x"],
      // A safe URL followed by a second one, or a credential hidden in its path or query.
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://github.com/o/r https://u:synthetic-password@evil.example/x"],
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://github.com/o/r#https://u:synthetic-password@evil.example/x"],
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://github.com/o/r/u:synthetic-password@evil.example"],
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://github.com/o/r?next=https%3A%2F%2Fu%3Ap%40evil.example"],
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://api.example.com/x?access_token=synthetic-token"],
      // A token in the username alone is a credential too.
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://ghp_synthetic@github.com/o/r"],
      // Whitespace, a backslash or a control character inside a URL reads differently to different parsers.
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://github.com/o/r\nhttps://u:synthetic-password@evil.example/x"],
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://evil.example\\@github.com/o/r"],
      // JSON whose string leaf is not one whole URL.
      ["PAPERCLIP_WORKSPACES_JSON", '[{"note":"clone https://github.com/o/r then u:synthetic-password@db.example.com"}]'],
      ["PAPERCLIP_WORKSPACES_JSON", '[{"https://u:synthetic-password@evil.example/x":1}]'],
      // A URL-like value that does not parse at all.
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://[not-an-ip/x"],
    ] as const) {
      expect([name, value, decide(name, value)]).toEqual([name, value, remote]);
    }
    // A JWT behind JSON escapes is found once the JSON is decoded.
    expect(decide("PAPERCLIP_WORKSPACES_JSON", '{"t":"\\u0065yJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"}')).toBe("jwt");
    // What a run needs still passes: one whole URL with no credentials, or JSON whose URL leaves are each one whole safe URL.
    for (const [name, value] of [
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://github.com/TogetherWeOwn/two-bot-next"],
      ["PAPERCLIP_WORKSPACE_REPO_URL", "https://registry.npmjs.org/@types%2fnode"],
      ["PAPERCLIP_WORKSPACES_JSON", '[{"repoUrl":"https://github.com/o/r","cwd":"/home/user/w","ref":"main"}]'],
      ["PAPERCLIP_WORKSPACES_JSON", '[{"repoUrl":"https:\\/\\/github.com\\/o\\/r"}]'],
      ["ANTHROPIC_BASE_URL", "http://127.0.0.1:8317"],
      ["PAPERCLIP_API_URL", "https://paperclip.example/api"],
      ["PATH", "/usr/local/bin:/usr/bin:/bin"],
      ["PAPERCLIP_WAKE_REASON", "issue_assigned"],
    ] as const) {
      expect([name, value, decide(name, value)]).toEqual([name, value, "kept"]);
    }
  });

  // Review round 4: libpq takes `host=` from the query over the authority, and
  // the resolver reads 0xc0000214 as 192.0.2.20.
  it("validates a database URL's effective destination: only literal loopback or a unix socket, and no host override", () => {
    const allow = ["TEST_DATABASE_URL", "REDIS_CONN"];
    const remote = "remote_database_or_credential_url";
    for (const value of [
      "postgres://u:synthetic-password@localhost/db?host=prod.example.net",
      "postgres://u:synthetic-password@localhost/db?sslmode=require&HOST=prod.example.net",
      "postgres://u:synthetic-password@localhost/db?%68ost=prod.example.net",
      "postgres://u:synthetic-password@localhost/db?hostaddr=192.0.2.20",
      "postgres://u:synthetic-password@localhost/db?service=prod",
      "postgres://u:synthetic-password@localhost/db?host=/tmp,prod.example.net",
      "postgres://u:synthetic-password@localhost:5432,prod.example.net:5432/db",
      "mysql://u:synthetic-password@localhost/db?socket=/tmp/s&host=prod.example.net",
      // Numeric IP spellings: hex, decimal integer, octal, short dotted.
      "postgres://u:synthetic-password@0xc0000214:5432/db",
      "postgres://u:synthetic-password@3221226004:5432/db",
      "postgres://u:synthetic-password@0300.0.2.20:5432/db",
      "postgres://u:synthetic-password@192.2.20:5432/db",
      // Loopback spellings other than the literal ones, and one-label names (DNS search domains can make them remote).
      "postgres://u:synthetic-password@0x7f000001:5432/db",
      "postgres://u:synthetic-password@127.1:5432/db",
      "postgres://u:synthetic-password@127.0.0.2:5432/db",
      "postgres://u:synthetic-password@agent-testdb:5432/db",
      "postgres://u:synthetic-password@%6c%6fcalhost/db",
      "rediss://default:synthetic-password@0x7f000001:6379",
    ]) {
      const name = value.startsWith("redis") ? "REDIS_CONN" : "TEST_DATABASE_URL";
      expect([value, decide(name, value, allow)]).toEqual([value, remote]);
    }
    // The same rule for any URL with credentials: an IP spelling that only canonicalizes to loopback is not proof.
    expect(decide("LOCAL_SERVICE_URL", "http://u:synthetic-password@0x7f000001:8080/", ["LOCAL_SERVICE_URL"])).toBe(remote);
    for (const value of [
      "postgres://u:synthetic-password@127.0.0.1:5432/t",
      "postgres://u:synthetic-password@[::1]:5432/t",
      "postgres://u:synthetic-password@LOCALHOST/t?sslmode=disable",
      "postgresql:///t?host=/var/run/postgresql",
      "postgres://u:synthetic-password@%2Fvar%2Frun%2Fpostgresql/t",
      "mysql://u:synthetic-password@localhost/t?socket=/tmp/mysql.sock",
    ]) {
      expect([value, decide("TEST_DATABASE_URL", value, allow)]).toEqual([value, "kept"]);
    }
  });

  it("reports dropped names only, and an invalid name without echoing it", () => {
    const result = filterRunEnv({ "BAD NAME": "v", GOOD: 1 as unknown as string, PLANETSCALE_X: "s3cr3t" }, DEFAULT_ENV_ALLOWLIST);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([
      { name: "(invalid name)", reason: "invalid_name" },
      { name: "PLANETSCALE_X", reason: "not_allowlisted" },
    ]);
    expect(JSON.stringify(result.dropped)).not.toContain("s3cr3t");
  });

  it("reads envAllowlist from a list or a comma or newline separated string", () => {
    expect(parseEnvAllowlist(["A", " B ", "", "A"])).toEqual(["A", "B"]);
    expect(parseEnvAllowlist("A, B\nC_*")).toEqual(["A", "B", "C_*"]);
    expect(parseEnvAllowlist("")).toBeNull();
    expect(parseEnvAllowlist(undefined)).toBeNull();
  });

  it("spots Paperclip's inline ACP env envelope, in the launch command or the launch env", () => {
    expect(isAcpProcessSessionCommand("sh", ["-c", "PAPERCLIP_PROCESS_SESSION_COMMAND_B64='x' nohup node w.js"])).toBe(true);
    expect(isAcpProcessSessionCommand("sh", ["-c", "node w.js"], { PAPERCLIP_PROCESS_SESSION_COMMAND_B64: "eyJ9" })).toBe(true);
    expect(isAcpProcessSessionCommand("claude", ["-p", "hello"])).toBe(false);
  });

  it("spots every step of an ACP launch whose envelope is uploaded as command.b64 (above 64 KiB)", () => {
    const calls = largeEnvelopeAcpLaunch();
    const chunkAppend = calls.find((call) => call.label === "writeTextFile chunk append")!;
    // The exact shape Paperclip's writeTextFile sends: the old check missed it.
    expect(chunkAppend.args[1]).toMatch(
      /^printf '%s' '[A-Za-z0-9+\/=]+' >> '\/home\/user\/paperclip-workspace\/\.paperclip-runtime\/claude\/process-sessions\/[0-9a-f-]+\/command\.b64\.[0-9a-f-]+\.paperclip-upload\.b64'$/,
    );
    expect(chunkAppend.args[1]).not.toContain("PAPERCLIP_PROCESS_SESSION_COMMAND_B64=");
    const mkdir = calls.find((call) => call.label === "session dir mkdir")!;
    expect(mkdir.args[1]).toMatch(/^umask 077 && mkdir -m 700 '\/home\/user\/paperclip-workspace\/\.paperclip-runtime\/claude\/process-sessions\/[0-9a-f-]+'$/);
    for (const call of calls) {
      expect({ label: call.label, refused: isAcpProcessSessionCommand(call.command, call.args, call.env) }).toEqual({
        label: call.label,
        refused: true,
      });
    }
    // The first step already fails, before any envelope byte is uploaded.
    expect(calls[0].label).toBe("wrapper script sync");
  });

  it("spots the ACP steps under a custom runtime root, including the bare process-sessions directory", () => {
    const calls = largeEnvelopeAcpLaunch({ runtimeRootDir: "/home/user/.paperclip-managed/claude" });
    for (const call of calls) expect(isAcpProcessSessionCommand(call.command, call.args, call.env)).toBe(true);
    expect(isAcpProcessSessionCommand("sh", ["-c", "mkdir -p '/home/user/.paperclip-managed/claude/process-sessions'"])).toBe(true);
    expect(isAcpProcessSessionCommand("sh", ["-c", "mkdir -p /srv/process-sessions && true"])).toBe(true);
    expect(isAcpProcessSessionCommand("sh", ["-c", "cat command.b64"])).toBe(true);
  });

  it("spots a relative process-sessions directory too (after a cd into the runtime root)", () => {
    for (const script of [
      "process-sessions",
      "mkdir -p process-sessions/0b0f6c2e",
      "cd '/home/user/paperclip-workspace/.paperclip-runtime/claude' && mkdir -p process-sessions",
      "cd x && ls 'process-sessions'",
      'test -d "process-sessions/abc"',
      "remote_dir=process-sessions",
      "cd x;process-sessions/run.sh",
      "true&&process-sessions/run.sh",
      "echo x >process-sessions/a",
      "(cd process-sessions/a)",
    ]) {
      expect([script, isAcpProcessSessionCommand("sh", ["-c", script])]).toEqual([script, true]);
    }
    expect(isAcpProcessSessionCommand("process-sessions/launch", [])).toBe(true);
    expect(isAcpProcessSessionCommand("ls", ["process-sessions"])).toBe(true);
    for (const script of ["ls process-sessions-archive", "ls myprocess-sessions", "echo process-sessionsX", "grep process-sessions.bak x"]) {
      expect([script, isAcpProcessSessionCommand("sh", ["-c", script])]).toEqual([script, false]);
    }
  });

  it("leaves a cli-engine run alone", () => {
    for (const call of cliEngineCalls()) {
      expect({ label: call.label, refused: isAcpProcessSessionCommand(call.command, call.args, call.env) }).toEqual({
        label: call.label,
        refused: false,
      });
    }
    // Names that merely share a prefix or suffix are not the ACP paths.
    expect(isAcpProcessSessionCommand("ls", ["/home/user/process-sessions-archive", "notcommand.b64x"])).toBe(false);
  });
});

describe("errors", () => {
  it("reads boat's error envelope from a ResponseError", async () => {
    const info = await describeBoatError(responseError(429, { code: "rate_limited", window: "day", limit: 75, requestId: "req_1" }));
    expect(info).toMatchObject({ status: 429, code: "rate_limited", window: "day", limit: 75, requestId: "req_1" });
    const nested = await describeBoatError(
      responseError(502, { code: "sandbox_direct_failed", error: { code: "sandbox_direct_failed", details: { retryable: true } } }),
    );
    expect(nested.retryable).toBe(true);
  });
});

describe("ssh endpoint", () => {
  it("uses sshEndpoint when boat sets it, else machineIp:22", () => {
    expect(endpointFromSshKeyResponse({ sshEndpoint: "ssh.boat.dev:40022", hostKey: "ssh-ed25519 A", sshUser: "user" })).toEqual({
      host: "ssh.boat.dev",
      port: 40022,
      user: "user",
      hostKey: "ssh-ed25519 A",
    });
    expect(endpointFromSshKeyResponse({ sshEndpoint: "[2001:db8::1]:2222", hostKey: "k" })).toMatchObject({ host: "2001:db8::1", port: 2222 });
    expect(endpointFromSshKeyResponse({ machineIp: "203.0.113.5", hostKey: "k" })).toEqual({ host: "203.0.113.5", port: 22, user: "user", hostKey: "k" });
    expect(() => endpointFromSshKeyResponse({ machineIp: "203.0.113.5" })).toThrow(/host key/);
  });
});

describe("keys and names", () => {
  it("keys a VM to the execution workspace, then the issue, then the run", () => {
    expect(resolveVmKey({ executionWorkspaceId: "ew1", issueId: "i1", runId: "r1" })).toEqual({ key: "ew:ew1", kind: "executionWorkspace" });
    expect(resolveVmKey({ issueId: "i1", runId: "r1" })).toEqual({ key: "issue:i1", kind: "issue" });
    expect(resolveVmKey({ runId: "r1" })).toEqual({ key: "run:r1", kind: "run" });
  });

  it("names are deterministic, prefixed and opaque", () => {
    const a = sandboxNameFor("paperclip", "c", "e", "ew:1");
    expect(a).toMatch(/^paperclip-[0-9a-f]{16}$/);
    expect(sandboxNameFor("paperclip", "c", "e", "ew:1")).toBe(a);
    expect(sandboxNameFor("paperclip", "c", "e", "ew:2")).not.toBe(a);
  });

  it("sanitizes template names", () => {
    expect(sanitizeSnapshotName("Two Bot Next / warm!", "fallback")).toBe("two-bot-next-warm");
    expect(sanitizeSnapshotName("", "fallback")).toBe("fallback");
  });
});

describe("shell", () => {
  it("quotes env values for the staged file", () => {
    expect(buildRemoteEnvFileContents([["A", "it's"]])).toBe("export A='it'\"'\"'s';\n");
  });

  it("stages each command's env in a fresh directory under /tmp, never in the workspace", () => {
    const a = newRemoteEnvStage();
    const b = newRemoteEnvStage();
    expect(REMOTE_ENV_STAGING_ROOT).toBe("/tmp");
    expect(a.dir).toMatch(/^\/tmp\/paperclip-boat-env-[0-9a-f]{32}$/);
    expect(a.path).toBe(`${a.dir}/env.sh`);
    expect(b.dir).not.toBe(a.dir);
  });

  it("sources the env file, removes it, then runs the payload, with a trailing remove as a fallback", () => {
    const stage: RemoteEnvStage = { dir: "/tmp/e", path: "/tmp/e/env.sh" };
    const script = buildLoginShellScript({ command: "node", args: ["x.js"], cwd: "/w", remoteEnv: stage });
    expect(script).toContain(
      "cd '/w' && if [ -f '/tmp/e/env.sh' ]; then . '/tmp/e/env.sh'; fi && { rm -f '/tmp/e/env.sh'; rmdir '/tmp/e' 2>/dev/null || true; } && unset ASCII_TOKEN BOAT_ID && export TAR_OPTIONS=\"--exclude=.paperclip-runtime${TAR_OPTIONS:+ $TAR_OPTIONS}\" && 'node' 'x.js'; rc=$?; rm -f '/tmp/e/env.sh'; rmdir '/tmp/e' 2>/dev/null; exit $rc",
    );
    expect(script.indexOf("rm -f '/tmp/e/env.sh'")).toBeLessThan(script.indexOf("'node' 'x.js'"));
    // The payload runs as a child of the script's shell, never as its last command, so no shell execs it.
    expect(script).not.toContain("exec 'node'");
    expect(buildLoginShellScript({ command: "node", args: ["x.js"], remoteEnv: null }).endsWith(
      ` && unset ASCII_TOKEN BOAT_ID && ${TAR_SKIP_RUNTIME_DIR} && 'node' 'x.js'; rc=$?; exit $rc`,
    )).toBe(true);
    // That shell is started by env without boat's credentials.
    expect(buildRemoteCommand("true")).toBe("exec env -u ASCII_TOKEN -u BOAT_ID sh -c 'true'");
  });

  describe("in a real shell", () => {
    let root: string;
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    // The same two steps the plugin runs over ssh, against a local sh.
    function stageAndRun(stage: RemoteEnvStage, cwd: string, payload: string) {
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root };
      execFileSync("sh", ["-c", stageRemoteEnvCommand(stage)], { input: buildRemoteEnvFileContents([["PCB_SECRET", "s3cr3t 'x'"]]), env });
      const mode = statSync(stage.dir).mode & 0o777;
      const fileMode = statSync(stage.path).mode & 0o777;
      const script = buildLoginShellScript({ command: "sh", args: ["-c", payload, "payload", stage.path], cwd, remoteEnv: stage });
      return { mode, fileMode, run: spawnSync("sh", ["-c", script], { env, encoding: "utf8" }) };
    }

    it("the payload gets the env but the file is already gone when it starts", () => {
      root = mkdtempSync(path.join(tmpdir(), "pcb-shell-"));
      const cwd = path.join(root, "workspace");
      execFileSync("mkdir", [cwd]);
      const dir = path.join(root, "stage");
      const stage = { dir, path: path.join(dir, "env.sh") };
      const { mode, fileMode, run } = stageAndRun(
        stage,
        cwd,
        'printf "secret=%s\\n" "$PCB_SECRET"; if [ -e "$1" ]; then echo file=present; else echo file=gone; fi; printf "cwd=%s\\n" "$PWD"; exit 7',
      );
      expect(mode).toBe(0o700);
      expect(fileMode).toBe(0o600);
      expect(run.stdout).toBe(`secret=s3cr3t 'x'\nfile=gone\ncwd=${cwd}\n`);
      expect(run.status).toBe(7);
      expect(existsSync(dir)).toBe(false);
    });

    it("the fallback removes the file when the script stops before the payload", () => {
      root = mkdtempSync(path.join(tmpdir(), "pcb-shell-"));
      const dir = path.join(root, "stage");
      const stage = { dir, path: path.join(dir, "env.sh") };
      const { run } = stageAndRun(stage, path.join(root, "no-such-dir"), "echo ran");
      expect(run.stdout).not.toContain("ran");
      expect(run.status).not.toBe(0);
      expect(existsSync(dir)).toBe(false);
    });

    it("the payload runs without ASCII_TOKEN and BOAT_ID, even though ~/.bashrc exports the token", () => {
      root = mkdtempSync(path.join(tmpdir(), "pcb-shell-"));
      // boat's own ~/.bashrc block, above the interactive guard.
      writeFileSync(
        path.join(root, ".bashrc"),
        '# ASCII TOKEN START\nexport ASCII_TOKEN="bashrc-token-value"\nexport ASCII_API_URL="https://boat.dev"\n# ASCII TOKEN END\ncase $- in *i*) ;; *) return;; esac\n',
      );
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, ASCII_TOKEN: "exec-env-token", BOAT_ID: "bx_test" };
      const payload = 'printf "ascii=%s boat=%s url=%s\\n" "${ASCII_TOKEN-unset}" "${BOAT_ID-unset}" "${ASCII_API_URL-unset}"';
      const dir = path.join(root, "stage");
      const stage = { dir, path: path.join(dir, "env.sh") };
      for (const remoteEnv of [stage, null]) {
        // The script alone (in a shell that has the tokens), and as Execute sends it (through env -u).
        for (const command of ["script", "remote"] as const) {
          if (remoteEnv) execFileSync("sh", ["-c", stageRemoteEnvCommand(stage)], { input: buildRemoteEnvFileContents([["PAPERCLIP_RUN_ID", "r1"]]), env });
          const script = buildLoginShellScript({ command: "sh", args: ["-c", payload], cwd: root, remoteEnv });
          const run = spawnSync("sh", ["-c", command === "script" ? script : buildRemoteCommand(script)], { env, encoding: "utf8" });
          expect([command, run.stdout]).toEqual([command, "ascii=unset boat=unset url=https://boat.dev\n"]);
          expect(run.status).toBe(0);
        }
      }
    });

    it("the payload's tar skips .paperclip-runtime, and a TAR_OPTIONS from the run env or a profile stays after the exclude", () => {
      root = mkdtempSync(path.join(tmpdir(), "pcb-shell-"));
      writeFileSync(path.join(root, ".profile"), "export TAR_OPTIONS=--profile-option\n");
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root };
      const payload = 'printf "tar_options=%s\\n" "$TAR_OPTIONS"';
      const dir = path.join(root, "stage");
      const stage = { dir, path: path.join(dir, "env.sh") };
      execFileSync("sh", ["-c", stageRemoteEnvCommand(stage)], { input: buildRemoteEnvFileContents([["TAR_OPTIONS", "--warning=no-timestamp"]]), env });
      const staged = spawnSync("sh", ["-c", buildRemoteCommand(buildLoginShellScript({ command: "sh", args: ["-c", payload], cwd: root, remoteEnv: stage }))], { env, encoding: "utf8" });
      expect(staged.stdout).toBe("tar_options=--exclude=.paperclip-runtime --warning=no-timestamp\n");
      const bare = spawnSync("sh", ["-c", buildRemoteCommand(buildLoginShellScript({ command: "sh", args: ["-c", payload], cwd: root, remoteEnv: null }))], { env, encoding: "utf8" });
      expect(bare.stdout).toBe("tar_options=--exclude=.paperclip-runtime --profile-option\n");
      rmSync(path.join(root, ".profile"));
      const none = spawnSync("sh", ["-c", buildRemoteCommand(buildLoginShellScript({ command: "sh", args: ["-c", payload], remoteEnv: null }))], { env, encoding: "utf8" });
      expect(none.stdout).toBe("tar_options=--exclude=.paperclip-runtime\n");
    });

    // sshd runs the remote command as `$SHELL -c '<command>'`. Over ssh, a
    // remote process that dies of a signal is reported as a signal, and the
    // OpenSSH client then exits 255, which the plugin reads as a lost VM.
    it.each(["sh", "bash"])("a payload killed by a signal exits 128+n through the remote command (login shell %s), with or without staged env", (login) => {
      root = mkdtempSync(path.join(tmpdir(), "pcb-shell-"));
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, ASCII_TOKEN: "exec-env-token", BOAT_ID: "bx_test" };
      const dir = path.join(root, "stage");
      const stage = { dir, path: path.join(dir, "env.sh") };
      for (const [signal, status] of [["TERM", 143], ["KILL", 137], ["HUP", 129]] as const) {
        for (const remoteEnv of [stage, null]) {
          if (remoteEnv) execFileSync("sh", ["-c", stageRemoteEnvCommand(stage)], { input: buildRemoteEnvFileContents([["PCB_SECRET", "s"]]), env });
          const script = buildLoginShellScript({ command: "sh", args: ["-c", `kill -${signal} $$`], cwd: root, remoteEnv });
          const run = spawnSync(login, ["-c", buildRemoteCommand(script)], { env, encoding: "utf8" });
          expect({ signal, staged: remoteEnv != null, status: run.status, killedBy: run.signal }).toEqual({ signal, staged: remoteEnv != null, status, killedBy: null });
          expect(existsSync(dir)).toBe(false);
        }
      }
      // An ordinary exit status still comes through as it is.
      const seven = spawnSync(login, ["-c", buildRemoteCommand(buildLoginShellScript({ command: "sh", args: ["-c", "exit 7"], remoteEnv: null }))], { env });
      expect(seven.status).toBe(7);
      // Control, the chain before: the payload replaced every shell, so the remote process itself died of the signal.
      const before = spawnSync(login, ["-c", `exec sh -c ${shellQuote(`unset ASCII_TOKEN BOAT_ID && exec sh -c 'kill -TERM $$'`)}`], { env });
      expect([before.status, before.signal]).toEqual([null, "SIGTERM"]);
    });

    it("the setup step deletes boat's export ASCII_TOKEN line from ~/.bashrc and nothing else", () => {
      root = mkdtempSync(path.join(tmpdir(), "pcb-shell-"));
      const bashrc = path.join(root, ".bashrc");
      const rest = '# ASCII TOKEN START\nexport ASCII_API_URL="https://boat.dev"\n# ASCII TOKEN END\nalias ll="ls -l"\n';
      writeFileSync(bashrc, '# ASCII TOKEN START\n  export ASCII_TOKEN="value"\nexport ASCII_API_URL="https://boat.dev"\n# ASCII TOKEN END\nalias ll="ls -l"\n');
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root };
      for (let i = 0; i < 2; i += 1) {
        const run = spawnSync("sh", ["-c", SCRUB_BASHRC_ASCII_TOKEN], { env, encoding: "utf8" });
        expect(run.status).toBe(0);
        expect(readFileSync(bashrc, "utf8")).toBe(rest);
      }
      rmSync(bashrc);
      expect(spawnSync("sh", ["-c", SCRUB_BASHRC_ASCII_TOKEN], { env }).status).toBe(0);
    });

    it.skipIf(!existsSync("/proc/self/environ"))(
      "no parent shell of the payload keeps ASCII_TOKEN or BOAT_ID in /proc/<pid>/environ, and the payload's own env has neither",
      () => {
        root = mkdtempSync(path.join(tmpdir(), "pcb-shell-"));
        expect(process.env.ASCII_TOKEN).toBeUndefined();
        const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, ASCII_TOKEN: "exec-env-token", BOAT_ID: "bx_test" };
        const environHits = (pid: string) => `tr '\\000' '\\n' < /proc/${pid}/environ | grep -c -E '^(ASCII_TOKEN|BOAT_ID)='`;
        const payload = `printf 'parent=%s self=%s secret=%s\\n' "$(${environHits("$PPID")})" "$(${environHits("$$")})" "$PCB_SECRET"`;
        const dir = path.join(root, "stage");
        const stage = { dir, path: path.join(dir, "env.sh") };
        const script = buildLoginShellScript({ command: "sh", args: ["-c", payload], cwd: root, remoteEnv: stage });
        // sshd runs the remote command as `$SHELL -c '<command>'`; the plugin's
        // command is `exec env -u ASCII_TOKEN -u BOAT_ID sh -c '<script>'`, so the
        // login shell becomes a sh that never had the tokens, and stays the payload's parent.
        for (const login of ["sh", "bash"]) {
          execFileSync("sh", ["-c", stageRemoteEnvCommand(stage)], { input: buildRemoteEnvFileContents([["PCB_SECRET", "s3cr3t"]]), env });
          const viaLogin = spawnSync(login, ["-c", buildRemoteCommand(script)], { env, encoding: "utf8" });
          expect([login, viaLogin.stdout]).toEqual([login, "parent=0 self=0 secret=s3cr3t\n"]);
          expect(viaLogin.status).toBe(0);
          expect(existsSync(dir)).toBe(false);
        }
        // Control: the same script in a shell started with the tokens: that shell is the payload's
        // parent, and `unset` hid the tokens from the payload but not from its own environ.
        execFileSync("sh", ["-c", stageRemoteEnvCommand(stage)], { input: buildRemoteEnvFileContents([["PCB_SECRET", "s3cr3t"]]), env });
        const direct = spawnSync("sh", ["-c", script], { env, encoding: "utf8" });
        expect(direct.stdout).toBe("parent=2 self=0 secret=s3cr3t\n");
      },
    );

    // Paperclip's runtime asset layout on the VM (adapter-utils sandbox-managed-runtime.ts, tog.22).
    function runtimeTree() {
      root = mkdtempSync(path.join(tmpdir(), "pcb-scrub-"));
      const home = path.join(root, "home");
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJydW4iOiJyMSJ9.c2ln";
      const files: Record<string, string> = {
        "home/paperclip-workspace/.paperclip-runtime/claude/mcp-config/mcp-config.json": JSON.stringify({
          mcpServers: { "Paperclip projects": { type: "http", url: "https://pc.example/api/mcp/project-tools", headers: { Authorization: `Bearer ${jwt}` } } },
        }),
        "home/paperclip-workspace/.paperclip-runtime/claude/mcp-config-upload.tar": jwt,
        "home/paperclip-workspace/.paperclip-runtime/claude/mcp-config-upload.tar.5d7c1e0a.paperclip-upload.b64": jwt,
        "home/other/proj/.paperclip-runtime/claude/mcp-config/mcp-config.json": jwt,
        "srv/w o'rk/.paperclip-runtime/codex/mcp-config/mcp-config.json": jwt,
        // Kept: everything else under the runtime root, and look-alikes outside it.
        "home/paperclip-workspace/.paperclip-runtime/claude/skills/paperclip/SKILL.md": "skill",
        // A skill's own mcp-config below the adapter directory is not the run's asset (review round 4).
        "home/paperclip-workspace/.paperclip-runtime/claude/skills/mcp-config/important.txt": "skill data",
        "home/paperclip-workspace/.paperclip-runtime/claude/skills/mcp-config-upload.tar": "skill data",
        "srv/w o'rk/.paperclip-runtime/codex/skills/mcp-config/important.txt": "skill data",
        "home/paperclip-workspace/.paperclip-runtime/claude/config/settings.json": "{}",
        "home/paperclip-workspace/.paperclip-runtime/claude/paperclip-bridge/queue/requests/r1.json": "{}",
        "home/paperclip-workspace/src/mcp-config/keep.json": "{}",
        "home/paperclip-workspace/README.md": "readme",
      };
      for (const [file, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), body);
      }
      return { home, jwt, at: (file: string) => path.join(root, file) };
    }

    it("the scrub removes every run MCP config and its upload under the roots and $HOME, and nothing else", () => {
      const tree = runtimeTree();
      const script = scrubRuntimeSecretsScript([tree.at("srv/w o'rk") + "/", "relative/ignored"]);
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tree.home };
      const first = spawnSync("sh", ["-c", script], { env, encoding: "utf8" });
      expect(first.stdout.trim()).toBe("paperclip-boat-scrub found=5 left=0 walk=complete");
      expect(first.status).toBe(0);
      expect(RUNTIME_SECRET_SCRUB_RESULT_RE.exec(first.stdout)?.slice(1)).toEqual(["5", "0", "complete"]);
      for (const gone of [
        "home/paperclip-workspace/.paperclip-runtime/claude/mcp-config",
        "home/paperclip-workspace/.paperclip-runtime/claude/mcp-config-upload.tar",
        "home/paperclip-workspace/.paperclip-runtime/claude/mcp-config-upload.tar.5d7c1e0a.paperclip-upload.b64",
        "home/other/proj/.paperclip-runtime/claude/mcp-config",
        "srv/w o'rk/.paperclip-runtime/codex/mcp-config",
      ]) {
        expect([gone, existsSync(tree.at(gone))]).toEqual([gone, false]);
      }
      for (const kept of [
        "home/paperclip-workspace/.paperclip-runtime/claude/skills/paperclip/SKILL.md",
        "home/paperclip-workspace/.paperclip-runtime/claude/skills/mcp-config/important.txt",
        "home/paperclip-workspace/.paperclip-runtime/claude/skills/mcp-config-upload.tar",
        "srv/w o'rk/.paperclip-runtime/codex/skills/mcp-config/important.txt",
        "home/paperclip-workspace/.paperclip-runtime/claude/config/settings.json",
        "home/paperclip-workspace/.paperclip-runtime/claude/paperclip-bridge/queue/requests/r1.json",
        "home/paperclip-workspace/src/mcp-config/keep.json",
        "home/paperclip-workspace/README.md",
      ]) {
        expect([kept, existsSync(tree.at(kept))]).toEqual([kept, true]);
      }
      const grep = spawnSync("grep", ["-rlF", tree.jwt, root], { encoding: "utf8" });
      expect(grep.stdout).toBe("");
      // Idempotent: a second run finds nothing and succeeds.
      const second = spawnSync("sh", ["-c", script], { env, encoding: "utf8" });
      expect(second.stdout.trim()).toBe("paperclip-boat-scrub found=0 left=0 walk=complete");
      expect(second.status).toBe(0);
    });

    // A name may hold a newline (repo content, or an agent steered by a
    // prompt). Split at its newlines, each name below spells a real path next
    // to it: an absolute sibling, or a relative one that resolves against the
    // ssh cwd ($HOME under sshd). The scrub must delete only the matched
    // mcp-config itself.
    it.each(["sh", "bash"])("the scrub (%s) deletes only the matched paths when names hold newlines, never what those names spell line by line", (shell) => {
      const tree = runtimeTree();
      const victims: Record<string, string> = {
        "home/paperclip-workspace/src/main.rs": "fn main() {}",
        "home/.cargo/bin/cargo": "cargo",
        "home/.rustup/settings.toml": "toolchain",
        "srv/w o'rk/.paperclip-runtime/skills/paperclip/SKILL.md": "skill",
      };
      const decoys = [
        // Found by the $HOME search; the lines are "<home>/paperclip-workspace/src" and "/.paperclip-runtime/a/mcp-config".
        "home/paperclip-workspace/src\n/.paperclip-runtime/a/mcp-config",
        // Found by the $HOME search; the line ".cargo" is $HOME/.cargo from the ssh cwd.
        "home/paperclip-workspace/x\n.cargo\n/.paperclip-runtime/a/mcp-config",
        // Found by the workspace-root glob; the lines are "<root>/.paperclip-runtime/skills" and ".rustup".
        "srv/w o'rk/.paperclip-runtime/skills\n.rustup\n/mcp-config",
      ];
      for (const [file, body] of Object.entries(victims)) {
        mkdirSync(path.dirname(tree.at(file)), { recursive: true });
        writeFileSync(tree.at(file), body);
      }
      for (const dir of decoys) {
        mkdirSync(tree.at(dir), { recursive: true });
        writeFileSync(path.join(tree.at(dir), "mcp-config.json"), tree.jwt);
      }
      const script = scrubRuntimeSecretsScript([tree.at("srv/w o'rk")]);
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tree.home };
      const run = spawnSync(shell, ["-c", script], { cwd: tree.home, env, encoding: "utf8" });
      for (const [file, body] of Object.entries(victims)) {
        expect([file, existsSync(tree.at(file)) && readFileSync(tree.at(file), "utf8")]).toEqual([file, body]);
      }
      for (const dir of decoys) {
        expect([dir, existsSync(tree.at(dir)), existsSync(path.dirname(tree.at(dir)))]).toEqual([dir, false, true]);
      }
      // Five from the base tree, three decoys; each counted once.
      expect(run.stdout.trim()).toBe("paperclip-boat-scrub found=8 left=0 walk=complete");
      expect(run.status).toBe(0);
      expect(spawnSync("grep", ["-rlF", tree.jwt, root], { encoding: "utf8" }).stdout).toBe("");
    });

    it.skipIf(process.getuid?.() === 0)("the scrub fails (non-zero, left>0) when a run MCP config cannot be removed", () => {
      const tree = runtimeTree();
      const locked = tree.at("home/paperclip-workspace/.paperclip-runtime/claude/mcp-config");
      chmodSync(locked, 0o555);
      try {
        const run = spawnSync("sh", ["-c", scrubRuntimeSecretsScript([])], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tree.home }, encoding: "utf8" });
        expect(run.stdout.trim()).toBe("paperclip-boat-scrub found=4 left=1 walk=complete");
        expect(run.status).not.toBe(0);
        expect(existsSync(path.join(locked, "mcp-config.json"))).toBe(true);
      } finally {
        chmodSync(locked, 0o755);
      }
    });

    // Review round 4: find's errors went to /dev/null and its status was lost
    // in the counting pipeline, so a subtree the SSH user cannot search read
    // as clean (found=0 left=0) while it kept a run MCP config.
    const asUser = process.getuid?.() !== 0;
    it.skipIf(!asUser)("the scrub fails verification (walk=incomplete, exit 3) when it cannot search a directory under $HOME, a root, or a runtime directory", () => {
      const tree = runtimeTree();
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tree.home };
      const hidden = {
        // Under $HOME: an intermediate directory the user cannot search.
        home: "home/locked/.paperclip-runtime/claude/mcp-config/mcp-config.json",
        // A workspace root whose ancestor cannot be searched.
        root: "srv/locked/ws/.paperclip-runtime/claude/mcp-config/mcp-config.json",
        // An adapter directory that can be searched but not listed (its upload tarball glob would match nothing).
        adapter: "srv/open/ws/.paperclip-runtime/codex/mcp-config-upload.tar",
      };
      for (const file of Object.values(hidden)) {
        mkdirSync(path.dirname(tree.at(file)), { recursive: true });
        writeFileSync(tree.at(file), tree.jwt);
      }
      const roots = [tree.at("srv/locked/ws"), tree.at("srv/open/ws")];
      const locks: Array<[string, number]> = [
        ["home/locked", 0o000],
        ["srv/locked", 0o000],
        ["srv/open/ws/.paperclip-runtime/codex", 0o311],
      ];
      const scrub = () => {
        const run = spawnSync("sh", ["-c", scrubRuntimeSecretsScript(roots)], { env, encoding: "utf8" });
        return { run, result: RUNTIME_SECRET_SCRUB_RESULT_RE.exec(run.stdout)?.slice(1) ?? null };
      };
      const unlockAll = () => {
        for (const [dir] of locks) chmodSync(tree.at(dir), 0o755);
      };
      try {
        for (const [dir, mode] of locks) chmodSync(tree.at(dir), mode);
        const { run, result } = scrub();
        // The four reachable ones are removed; the three behind the locks are not found, so nothing is verified.
        expect(result).toEqual(["4", "0", "incomplete"]);
        expect(run.status).toBe(3);
        expect(run.stderr).toMatch(/Permission denied|cannot/);
      } finally {
        unlockAll();
      }
      for (const file of Object.values(hidden)) expect([file, existsSync(tree.at(file))]).toEqual([file, true]);
      // Readable again: the walk completes and the three hidden ones are removed.
      const clean = scrub();
      expect(clean.result).toEqual(["3", "0", "complete"]);
      expect(clean.run.status).toBe(0);
      for (const file of Object.values(hidden)) expect([file, existsSync(tree.at(file))]).toEqual([file, false]);
      // Each lock alone makes the walk incomplete, with nothing left to find.
      for (const [dir, mode] of locks) {
        try {
          chmodSync(tree.at(dir), mode);
          const one = scrub();
          expect([dir, one.result, one.run.status]).toEqual([dir, ["0", "0", "incomplete"], 3]);
        } finally {
          unlockAll();
        }
      }
    });

    it("the scrub fails verification when HOME is unset or is not a directory", () => {
      const tree = runtimeTree();
      for (const env of [{ PATH: process.env.PATH ?? "/usr/bin:/bin" }, { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tree.at("no-such-home") }]) {
        const run = spawnSync("sh", ["-c", scrubRuntimeSecretsScript([])], { env, encoding: "utf8" });
        expect(RUNTIME_SECRET_SCRUB_RESULT_RE.exec(run.stdout)?.[3]).toBe("incomplete");
        expect(run.status).toBe(3);
      }
    });

    it("the scrub treats a runtime link whose target is gone as empty, but one whose target it cannot reach as incomplete", () => {
      const tree = runtimeTree();
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tree.home };
      const ws = tree.at("srv/linked");
      mkdirSync(ws, { recursive: true });
      symlinkSync(tree.at("tmp-gone/paperclip-boat-runtime-x"), path.join(ws, ".paperclip-runtime"));
      mkdirSync(tree.at("tmp-gone"));
      const gone = spawnSync("sh", ["-c", scrubRuntimeSecretsScript([ws])], { env, encoding: "utf8" });
      expect(RUNTIME_SECRET_SCRUB_RESULT_RE.exec(gone.stdout)?.slice(1)).toEqual(["4", "0", "complete"]);
      if (!asUser) return;
      chmodSync(tree.at("tmp-gone"), 0o000);
      try {
        const unreachable = spawnSync("sh", ["-c", scrubRuntimeSecretsScript([ws])], { env, encoding: "utf8" });
        expect(RUNTIME_SECRET_SCRUB_RESULT_RE.exec(unreachable.stdout)?.slice(1)).toEqual(["0", "0", "incomplete"]);
        expect(unreachable.status).toBe(3);
      } finally {
        chmodSync(tree.at("tmp-gone"), 0o755);
      }
    });

    it("the scrub still deletes but reports no result (exit 2) when the VM's sort cannot count NUL-terminated paths", () => {
      const tree = runtimeTree();
      // A sort without -z: the count pipeline would read 0 and pass as clean.
      const shims = tree.at("shims");
      mkdirSync(shims);
      writeFileSync(path.join(shims, "sort"), "#!/bin/sh\necho \"sort: invalid option -- 'z'\" >&2\nexit 2\n", { mode: 0o755 });
      const env = { PATH: `${shims}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: tree.home };
      const run = spawnSync("sh", ["-c", scrubRuntimeSecretsScript([])], { env, encoding: "utf8" });
      expect(run.status).toBe(2);
      expect(RUNTIME_SECRET_SCRUB_RESULT_RE.exec(run.stdout)).toBeNull();
      expect(run.stderr).toContain("cannot count NUL-terminated paths");
      expect(existsSync(tree.at("home/paperclip-workspace/.paperclip-runtime/claude/mcp-config"))).toBe(false);
      expect(existsSync(tree.at("home/paperclip-workspace/.paperclip-runtime/claude/skills/paperclip/SKILL.md"))).toBe(true);
    });

    it("staging refuses a directory that already exists", () => {
      root = mkdtempSync(path.join(tmpdir(), "pcb-shell-"));
      const dir = path.join(root, "stage");
      execFileSync("mkdir", [dir]);
      const result = spawnSync("sh", ["-c", stageRemoteEnvCommand({ dir, path: path.join(dir, "env.sh") })], { input: "export A=1;\n" });
      expect(result.status).not.toBe(0);
      expect(existsSync(path.join(dir, "env.sh"))).toBe(false);
    });

    // <root>/.paperclip-runtime is a real directory, and ~/.boatignore leaves it out of every boat snapshot.
    describe("the runtime directory", () => {
      const prepare = (ws: string, shell = "sh", home = root) =>
        spawnSync(shell, ["-c", runtimeDirScript(ws)], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
      const result = (run: ReturnType<typeof prepare>) => RUNTIME_DIR_RESULT_RE.exec(run.stdout)?.slice(1) ?? null;
      const boatignore = () => readFileSync(path.join(root, ".boatignore"), "utf8");
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJydW4iOiJyMSJ9.c2ln";

      it.each(["sh", "bash"])("makes <root> and a real 0700 .paperclip-runtime, puts the rule into ~/.boatignore, then keeps both (%s)", (shell) => {
        root = mkdtempSync(path.join(tmpdir(), "pcb-rt-"));
        const ws = path.join(root, "w o'rk");
        const runtime = path.join(ws, ".paperclip-runtime");
        const run = prepare(ws, shell);
        expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
        expect(result(run)).toEqual(["made", runtime]);
        expect(lstatSync(runtime).isDirectory()).toBe(true);
        expect(statSync(runtime).mode & 0o777).toBe(0o700);
        expect(boatignore()).toBe(`${BOATIGNORE_RUNTIME_RULE}\n`);
        // A second run on the running VM keeps the directory and the first run's files, and adds no second rule.
        writeFileSync(path.join(runtime, "bridge-queue"), "x");
        const again = prepare(ws, shell);
        expect(result(again)).toEqual(["kept", runtime]);
        expect(readFileSync(path.join(runtime, "bridge-queue"), "utf8")).toBe("x");
        expect(boatignore()).toBe(`${BOATIGNORE_RUNTIME_RULE}\n`);
      });

      it("makes a kept .paperclip-runtime 0700 again, with its files (one made by Paperclip's mkdir -p is 0755)", () => {
        root = mkdtempSync(path.join(tmpdir(), "pcb-rt-"));
        const ws = path.join(root, "ws");
        const runtime = path.join(ws, ".paperclip-runtime");
        mkdirSync(path.join(runtime, "claude"), { recursive: true });
        chmodSync(runtime, 0o755);
        writeFileSync(path.join(runtime, "claude", "keep"), "k");
        const run = prepare(ws);
        expect({ status: run.status, result: result(run) }).toEqual({ status: 0, result: ["kept", runtime] });
        expect(statSync(runtime).mode & 0o777).toBe(0o700);
        expect(readFileSync(path.join(runtime, "claude", "keep"), "utf8")).toBe("k");
      });

      it("keeps the other ~/.boatignore lines, and ends a last line that has no newline first", () => {
        root = mkdtempSync(path.join(tmpdir(), "pcb-rt-"));
        writeFileSync(path.join(root, ".boatignore"), "node_modules/\n.next/");
        expect(prepare(path.join(root, "ws")).status).toBe(0);
        expect(boatignore()).toBe(`node_modules/\n.next/\n${BOATIGNORE_RUNTIME_RULE}\n`);
        // A rule already in place is not added again.
        writeFileSync(path.join(root, ".boatignore"), `a/\n${BOATIGNORE_RUNTIME_RULE}\nb/`);
        expect(prepare(path.join(root, "ws2")).status).toBe(0);
        expect(boatignore()).toBe(`a/\n${BOATIGNORE_RUNTIME_RULE}\nb/`);
      });

      it("replaces a symlink (0.2.0 linked the directory into /tmp; Paperclip refuses that) or a file with a real directory, and leaves a link's target alone", () => {
        root = mkdtempSync(path.join(tmpdir(), "pcb-rt-"));
        const ws = path.join(root, "ws");
        const runtime = path.join(ws, ".paperclip-runtime");
        mkdirSync(ws);
        const elsewhere = path.join(root, "elsewhere");
        mkdirSync(elsewhere);
        writeFileSync(path.join(elsewhere, "keep"), "k");
        for (const target of [elsewhere, path.join(root, "gone"), "file"]) {
          rmSync(runtime, { recursive: true, force: true });
          if (target === "file") writeFileSync(runtime, "not a directory");
          else symlinkSync(target, runtime);
          const run = prepare(ws);
          expect({ target, result: result(run), link: lstatSync(runtime).isSymbolicLink(), dir: lstatSync(runtime).isDirectory() }).toEqual({
            target,
            result: ["made", runtime],
            link: false,
            dir: true,
          });
        }
        expect(readFileSync(path.join(elsewhere, "keep"), "utf8")).toBe("k");
      });

      it("passes Paperclip's own check before a run (tog.22 instructionGitExcludeProgram), which fails on the 0.2.0 symlink", () => {
        root = mkdtempSync(path.join(tmpdir(), "pcb-rt-"));
        const ws = path.join(root, "ws");
        const exclude = () => spawnSync(process.execPath, ["-e", PAPERCLIP_INSTRUCTION_GIT_EXCLUDE_PROGRAM, ws], { encoding: "utf8" });
        expect(prepare(ws).status).toBe(0);
        const run = exclude();
        expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
        expect(readFileSync(path.join(ws, ".paperclip-runtime", ".gitignore"), "utf8")).toBe("*\n");
        // Control: what 0.2.0 left there. Paperclip failed every pilot run on it.
        const tmpTarget = mkdtempSync(path.join(root, "tmp-runtime-"));
        rmSync(path.join(ws, ".paperclip-runtime"), { recursive: true });
        symlinkSync(tmpTarget, path.join(ws, ".paperclip-runtime"));
        const refused = exclude();
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain("Unsafe runtime exclusion directory");
      });

      it("Paperclip's asset extract and workspace wipe keep the directory, and the scrub still removes the MCP config there", () => {
        root = mkdtempSync(path.join(tmpdir(), "pcb-rt-"));
        const ws = path.join(root, "paperclip-workspace");
        expect(prepare(ws).status).toBe(0);
        // The asset, packed on the host.
        const source = path.join(root, "asset-src");
        mkdirSync(source);
        writeFileSync(path.join(source, "mcp-config.json"), JSON.stringify({ mcpServers: { p: { headers: { Authorization: `Bearer ${jwt}` } } } }));
        const assetDir = `${ws}/.paperclip-runtime/claude/mcp-config`;
        const assetTar = `${ws}/.paperclip-runtime/claude/mcp-config-upload.tar`;
        execFileSync("sh", ["-c", `mkdir -p ${shellQuote(path.dirname(assetTar))} && tar -cf ${shellQuote(assetTar)} -C ${shellQuote(source)} .`]);
        // buildDefaultExtractRuntimeAssetCommand and the workspace wipe (adapter-utils sandbox-managed-runtime.ts, tog.22).
        const q = shellQuote;
        execFileSync("sh", ["-c", `rm -rf ${q(assetDir)} && mkdir -p ${q(assetDir)} && tar -xf ${q(assetTar)} -C ${q(assetDir)} && rm -f ${q(assetTar)}`]);
        writeFileSync(path.join(ws, "old.txt"), "old");
        execFileSync("sh", ["-c", `find ${q(ws)} -mindepth 1 -maxdepth 1 ! -name '.paperclip-runtime' ! -name '.paperclip-upload-*' -exec rm -rf -- {} +`]);
        expect(existsSync(path.join(ws, "old.txt"))).toBe(false);
        expect(lstatSync(path.join(ws, ".paperclip-runtime")).isDirectory()).toBe(true);
        expect(readFileSync(path.join(assetDir, "mcp-config.json"), "utf8")).toContain(jwt);
        // The scrub before a stop is kept as defense in depth.
        const scrub = spawnSync("sh", ["-c", scrubRuntimeSecretsScript([ws])], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root }, encoding: "utf8" });
        expect(scrub.stdout.trim()).toBe("paperclip-boat-scrub found=1 left=0 walk=complete");
        expect(existsSync(assetDir)).toBe(false);
      });

      // Paperclip's inbound workspace tar carries the host workspace's own
      // .paperclip-runtime/ (tog.22: workspaceArchiveExclude and the git overlay
      // copy do not leave it out). The commands below are tog.22's, run the way
      // Execute runs them.
      const gnuTar = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout?.includes("GNU tar") ?? false;
      it.skipIf(!gnuTar).each([
        { workspace: "plain (wipe, then extract)", wipe: true, order: "asset first" },
        { workspace: "plain (wipe, then extract)", wipe: true, order: "workspace first" },
        { workspace: "git overlay (extract over the tree)", wipe: false, order: "asset first" },
        { workspace: "git overlay (extract over the tree)", wipe: false, order: "workspace first" },
      ])("Paperclip's workspace extract of a host tar with .paperclip-runtime/ leaves the VM's runtime directory alone: $workspace, $order", ({ wipe, order }) => {
        root = mkdtempSync(path.join(tmpdir(), "pcb-rt-"));
        const q = shellQuote;
        const plainEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root };
        const ws = path.join(root, "paperclip-workspace");
        expect(prepare(ws).status).toBe(0);
        writeFileSync(path.join(ws, "old.txt"), "old");
        // The host workspace, as on rbx1: a .paperclip-runtime with repository clones next to the code.
        const host = path.join(root, "host");
        for (const [file, body] of Object.entries({
          ".paperclip-runtime/detached-repositories/r1/f": "host runtime file",
          ".paperclip-runtime/claude/mcp-config/mcp-config.json": "stale host config",
          "main.rs": "fn main() {}",
          ".paperclip-runtime-like/keep": "not the runtime directory",
        })) {
          mkdirSync(path.dirname(path.join(host, file)), { recursive: true });
          writeFileSync(path.join(host, file), body);
        }
        // createTarballFromDirectory: the top-level names, not ".".
        const list = path.join(root, "entries.nul");
        writeFileSync(list, [".paperclip-runtime", "main.rs", ".paperclip-runtime-like"].map((name) => `${name}\0`).join(""));
        const hostTar = path.join(root, "workspace.tar");
        execFileSync("tar", ["-c", "--no-xattrs", "-f", hostTar, "-C", host, "--exclude", "._*", "--null", "-T", list], { env: plainEnv });
        expect(execFileSync("tar", ["-tf", hostTar], { env: plainEnv, encoding: "utf8" }).split("\n")).toContain(".paperclip-runtime/");
        // The asset, packed on the host.
        const assetSource = path.join(root, "asset-src");
        mkdirSync(assetSource);
        writeFileSync(path.join(assetSource, "mcp-config.json"), JSON.stringify({ mcpServers: { p: { headers: { Authorization: `Bearer ${jwt}` } } } }));
        const assetTar = path.join(root, "mcp-config.tar");
        execFileSync("tar", ["-cf", assetTar, "-C", assetSource, "mcp-config.json"], { env: plainEnv });
        // Both tars are uploaded under <root>/.paperclip-runtime/claude.
        const runtimeRoot = `${ws}/.paperclip-runtime/claude`;
        const remoteWorkspaceTar = `${runtimeRoot}/workspace-upload.tar`;
        const remoteAssetTar = `${runtimeRoot}/mcp-config-upload.tar`;
        const assetDir = `${runtimeRoot}/mcp-config`;
        // buildWorkspaceTarExtractCommand (wipeExceptNames: preservedNames, or null for the git overlay) and buildDefaultExtractRuntimeAssetCommand.
        const wipeStep = wipe ? ` && find ${q(ws)} -mindepth 1 -maxdepth 1 ! -name '.paperclip-runtime' ! -name '.paperclip-upload-*' -exec rm -rf -- {} +` : "";
        const workspaceExtract = `mkdir -p ${q(ws)}${wipeStep} && tar -xf ${q(remoteWorkspaceTar)} -C ${q(ws)} && rm -f ${q(remoteWorkspaceTar)}`;
        const assetExtract = `rm -rf ${q(assetDir)} && mkdir -p ${q(assetDir)} && tar -xf ${q(remoteAssetTar)} -C ${q(assetDir)} && rm -f ${q(remoteAssetTar)}`;
        // Execute: `$SHELL -c 'exec env -u ... sh -c <script>'`, the payload `sh -c <command>` with cwd = the workspace.
        const execute = (command: string) =>
          spawnSync("bash", ["-c", buildRemoteCommand(buildLoginShellScript({ command: "sh", args: ["-c", command], cwd: ws, remoteEnv: null }))], { env: plainEnv, encoding: "utf8" });
        const upload = (from: string, to: string) => execute(`mkdir -p ${q(path.posix.dirname(to))} && cat ${q(from)} > ${q(to)}`);
        const steps =
          order === "asset first"
            ? [() => upload(assetTar, remoteAssetTar), () => execute(assetExtract), () => upload(hostTar, remoteWorkspaceTar), () => execute(workspaceExtract)]
            : [() => upload(hostTar, remoteWorkspaceTar), () => execute(workspaceExtract), () => upload(assetTar, remoteAssetTar), () => execute(assetExtract)];
        for (const [index, step] of steps.entries()) {
          const run = step();
          expect({ index, status: run.status, stderr: run.stderr }).toEqual({ index, status: 0, stderr: "" });
        }
        const runtime = path.join(ws, ".paperclip-runtime");
        expect(lstatSync(runtime).isDirectory()).toBe(true);
        // The run's MCP config is where the agent finds it; the host's runtime files were not unpacked, and the upload tars are gone.
        expect(readFileSync(path.join(runtime, "claude", "mcp-config", "mcp-config.json"), "utf8")).toContain(jwt);
        expect(readFileSync(path.join(ws, "main.rs"), "utf8")).toBe("fn main() {}");
        expect(readFileSync(path.join(ws, ".paperclip-runtime-like", "keep"), "utf8")).toBe("not the runtime directory");
        expect(existsSync(path.join(ws, "old.txt"))).toBe(!wipe);
        expect(existsSync(path.join(runtime, "detached-repositories"))).toBe(false);
        expect(spawnSync("grep", ["-rlF", "stale host config", runtime], { encoding: "utf8" }).stdout).toBe("");
        expect([existsSync(path.join(runtime, "claude", "workspace-upload.tar")), existsSync(path.join(runtime, "claude", "mcp-config-upload.tar"))]).toEqual([false, false]);

        // Control: the same workspace extract without the plugin's script unpacks the host's runtime files over the run's.
        expect(upload(hostTar, remoteWorkspaceTar).status).toBe(0);
        const bare = spawnSync("sh", ["-c", workspaceExtract], { cwd: ws, env: plainEnv, encoding: "utf8" });
        expect(bare.status).toBe(0);
        expect(readFileSync(path.join(runtime, "detached-repositories", "r1", "f"), "utf8")).toBe("host runtime file");
        expect(readFileSync(path.join(runtime, "claude", "mcp-config", "mcp-config.json"), "utf8")).toBe("stale host config");
      });

      it.skipIf(!gnuTar)("an agent's own tar through Execute never packs the run's MCP config", () => {
        root = mkdtempSync(path.join(tmpdir(), "pcb-rt-"));
        const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root };
        const ws = path.join(root, "ws");
        expect(prepare(ws).status).toBe(0);
        mkdirSync(path.join(ws, ".paperclip-runtime", "claude", "mcp-config"), { recursive: true });
        writeFileSync(path.join(ws, ".paperclip-runtime", "claude", "mcp-config", "mcp-config.json"), jwt);
        writeFileSync(path.join(ws, "main.rs"), "fn main() {}");
        const out = path.join(root, "out.tar");
        const script = buildLoginShellScript({ command: "tar", args: ["-chf", out, "."], cwd: ws, remoteEnv: null });
        expect(spawnSync("sh", ["-c", buildRemoteCommand(script)], { env, encoding: "utf8" }).status).toBe(0);
        const listed = execFileSync("tar", ["-tf", out], { env, encoding: "utf8" });
        expect(listed).toContain("./main.rs");
        expect(listed).not.toContain(".paperclip-runtime");
        // Control: the same tar outside Execute packs the file.
        expect(execFileSync("sh", ["-c", `tar -chf - . | tar -tf -`], { cwd: ws, env, encoding: "utf8" })).toContain("./.paperclip-runtime/claude/mcp-config/mcp-config.json");
      });

      it("fails closed, with no result line and no directory, when <root> is not a plain path under $HOME or ~/.boatignore cannot take the rule", () => {
        root = mkdtempSync(path.join(tmpdir(), "pcb-rt-"));
        const outside = mkdtempSync(path.join(tmpdir(), "pcb-rt-out-"));
        try {
          for (const ws of [path.join(outside, "ws"), `${root}/a/../../${path.basename(outside)}/ws`, root]) {
            const run = prepare(ws);
            expect({ ws, status: run.status === 0, result: result(run) }).toEqual({ ws, status: false, result: null });
          }
          expect(existsSync(path.join(outside, "ws"))).toBe(false);
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
        // ~/.boatignore is a directory: the rule cannot go in, so nothing is made.
        mkdirSync(path.join(root, ".boatignore"));
        const run = prepare(path.join(root, "ws"));
        expect(run.status).not.toBe(0);
        expect(result(run)).toBeNull();
        expect(existsSync(path.join(root, "ws"))).toBe(false);
      });

      it("refuses to build a script for a relative root", () => {
        expect(() => runtimeDirScript("relative/ws")).toThrow(/absolute/);
        expect(() => runtimeDirScript("/")).toThrow(/absolute/);
      });
    });
  });
});
