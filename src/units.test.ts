import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBudget, readBudget } from "./budget.js";
import { parseDriverConfig } from "./config.js";
import { DEFAULT_ENV_ALLOWLIST, filterRunEnv, isAcpProcessSessionCommand, parseEnvAllowlist } from "./env-policy.js";
import { describeBoatError } from "./errors.js";
import {
  REMOTE_ENV_STAGING_ROOT,
  SCRUB_BASHRC_ASCII_TOKEN,
  buildLoginShellScript,
  buildRemoteEnvFileContents,
  newRemoteEnvStage,
  stageRemoteEnvCommand,
} from "./shell.js";
import type { RemoteEnvStage } from "./shell.js";
import { endpointFromSshKeyResponse } from "./ssh.js";
import { resolveVmKey, sandboxNameFor, sanitizeSnapshotName } from "./vm-manager.js";
import { cliEngineCalls, largeEnvelopeAcpLaunch } from "./test-support/acp-process-session.js";
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
      size: "default",
      autoStopMinutes: 120,
      idleStopMinutes: 15,
      maxActive: 2,
      maxStartsPerDay: 70,
      minComputeHoursLeft: 1,
      noEnv: true,
      failFast: true,
      apiBase: "https://boat.dev/api/v1",
      templateSnapshot: null,
    });
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

  it("a NAME_* prefix never delivers a secret-looking name; an exact entry does", () => {
    expect(decide("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-x")).toBe("secret_name_needs_exact_entry");
    expect(decide("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "not-a-number")).toBe("secret_name_needs_exact_entry");
    for (const name of ["CARGO_REGISTRY_TOKEN", "CARGO_SECRET", "CARGO_PASSWORD", "CARGO_API_KEY", "CARGO_PRIVATE_KEY", "CARGO_CREDENTIALS"]) {
      expect([name, decide(name, "x", ["CARGO_*"])]).toEqual([name, "secret_name_needs_exact_entry"]);
      expect([name, decide(name, "x", [name])]).toEqual([name, "kept"]);
    }
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
    const local = "postgres://postgres:pw@agent-testdb:5432/two_bot_test_local";
    expect(decide("TWO_TEST_DATABASE_URL", local, ["TWO_*"])).toBe("secret_name_needs_exact_entry");
    expect(decide("TWO_TEST_DATABASE_URL", local, ["TWO_TEST_DATABASE_URL"])).toBe("kept");
    expect(decide("TEST_DATABASE_URL", "postgres://p:p@127.0.0.1:5432/t", ["TEST_DATABASE_URL"])).toBe("kept");
    expect(decide("TEST_DATABASE_URL", "postgres://p:p@[::1]:5432/t", ["TEST_DATABASE_URL"])).toBe("kept");
    expect(decide("TEST_DATABASE_URL", "postgres://p:p@192.168.1.4:5432/t", ["TEST_DATABASE_URL"])).toBe("remote_database_or_credential_url");
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
      "cd '/w' && if [ -f '/tmp/e/env.sh' ]; then . '/tmp/e/env.sh'; fi && { rm -f '/tmp/e/env.sh'; rmdir '/tmp/e' 2>/dev/null || true; } && unset ASCII_TOKEN BOAT_ID && 'node' 'x.js'; rc=$?; rm -f '/tmp/e/env.sh'; rmdir '/tmp/e' 2>/dev/null; exit $rc",
    );
    expect(script.indexOf("rm -f '/tmp/e/env.sh'")).toBeLessThan(script.indexOf("'node' 'x.js'"));
    expect(script).not.toContain("exec 'node'");
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
      execFileSync("sh", ["-c", stageRemoteEnvCommand(stage)], { input: buildRemoteEnvFileContents([["PAPERCLIP_RUN_ID", "r1"]]), env });
      for (const remoteEnv of [stage, null]) {
        const script = buildLoginShellScript({ command: "sh", args: ["-c", payload], cwd: root, remoteEnv });
        const run = spawnSync("sh", ["-c", script], { env, encoding: "utf8" });
        expect(run.stdout).toBe("ascii=unset boat=unset url=https://boat.dev\n");
        expect(run.status).toBe(0);
      }
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

    it("staging refuses a directory that already exists", () => {
      root = mkdtempSync(path.join(tmpdir(), "pcb-shell-"));
      const dir = path.join(root, "stage");
      execFileSync("mkdir", [dir]);
      const result = spawnSync("sh", ["-c", stageRemoteEnvCommand({ dir, path: path.join(dir, "env.sh") })], { input: "export A=1;\n" });
      expect(result.status).not.toBe(0);
      expect(existsSync(path.join(dir, "env.sh"))).toBe(false);
    });
  });
});
