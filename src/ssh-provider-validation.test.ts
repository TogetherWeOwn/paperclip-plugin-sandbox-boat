// Provider endpoint data is validated before it can reach a host ssh/rsync
// process, and host ssh never reads the operator's ssh config:
// - a sandbox id / endpoint carrying an ssh option payload (-oProxyCommand…)
//   throws in endpointFromSshKeyResponse, openSession and buildRsyncPushArgs;
// - a hostKey with a newline cannot smuggle a second known_hosts line;
// - with HOME pointing at a config whose LocalCommand touches a marker,
//   SshManager (master + slave) and the rsync push argv — direct
//   connections, no reusable control master — create none, while a plain
//   ssh handed that same config file does. (Stock OpenSSH locates the user
//   config via the passwd entry, not $HOME, so the control passes the
//   planted file with -F to prove the payload itself is live; the plugin
//   paths additionally run under the planted HOME for builds that read it.)
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRsyncPushArgs, renderFilesFromList } from "./offload-sync.js";
import {
  SshManager,
  endpointFromSshKeyResponse,
  runProcess,
  runStreamProcess,
  type SshSession,
} from "./ssh.js";
import { LoopbackSsh } from "./test-support/loopback-sshd.js";

const GOOD_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest";

describe("endpointFromSshKeyResponse validation", () => {
  it("accepts well-formed provider answers", () => {
    expect(endpointFromSshKeyResponse({ sshEndpoint: "ssh.boat.dev:40022", hostKey: GOOD_KEY, sshUser: "user" }))
      .toEqual({ host: "ssh.boat.dev", port: 40022, user: "user", hostKey: GOOD_KEY });
    expect(endpointFromSshKeyResponse({ sshEndpoint: "[2001:db8::1]:2222", hostKey: "ecdsa-sha2-nistp256 AAAAE2VjZHNh" }))
      .toMatchObject({ host: "2001:db8::1", port: 2222, user: "user" });
    expect(endpointFromSshKeyResponse({ machineIp: "203.0.113.5", hostKey: "rsa-sha2-512 AAAAB3NzaC1yc2E=" }))
      .toMatchObject({ host: "203.0.113.5", port: 22 });
  });

  it("throws on a hostKey carrying a newline (known_hosts injection)", () => {
    expect(() => endpointFromSshKeyResponse({
      machineIp: "203.0.113.5",
      hostKey: `${GOOD_KEY}\nattacker.example ssh-ed25519 AAAAEVIL`,
    })).toThrow(/host key/);
    expect(() => endpointFromSshKeyResponse({ machineIp: "203.0.113.5", hostKey: "ssh-ed25519" })).toThrow(/host key/);
    expect(() => endpointFromSshKeyResponse({ machineIp: "203.0.113.5", hostKey: "sk-ssh-ed25519@openssh.com AAAA" })).toThrow(/host key/);
  });

  it("throws on an sshUser that is an ssh option or not a login name", () => {
    expect(() => endpointFromSshKeyResponse({ machineIp: "203.0.113.5", hostKey: GOOD_KEY, sshUser: "-oProxyCommand=x" })).toThrow(/sshUser/);
    expect(() => endpointFromSshKeyResponse({ machineIp: "203.0.113.5", hostKey: GOOD_KEY, sshUser: "user@evil" })).toThrow(/sshUser/);
    expect(() => endpointFromSshKeyResponse({ machineIp: "203.0.113.5", hostKey: GOOD_KEY, sshUser: "User Name" })).toThrow(/sshUser/);
  });

  it("throws on an endpoint or machineIp that is an option or carries spaces", () => {
    expect(() => endpointFromSshKeyResponse({ sshEndpoint: "-oFoo=bar:22", hostKey: GOOD_KEY })).toThrow(/host/);
    expect(() => endpointFromSshKeyResponse({ sshEndpoint: "-oProxyCommand=touch /tmp/p:22", hostKey: GOOD_KEY })).toThrow();
    expect(() => endpointFromSshKeyResponse({ machineIp: "-oProxyCommand=x", hostKey: GOOD_KEY })).toThrow(/host/);
    expect(() => endpointFromSshKeyResponse({ machineIp: "203.0.113.5 extra", hostKey: GOOD_KEY })).toThrow(/host/);
    expect(() => endpointFromSshKeyResponse({ sshEndpoint: "ssh.boat.dev:70000", hostKey: GOOD_KEY })).toThrow(/port/);
  });
});

describe("openSession validation", () => {
  it("throws on a sandboxId carrying a ProxyCommand payload, before any session exists", async () => {
    const manager = new SshManager({ info() {}, warn() {} });
    const endpoint = { host: "203.0.113.5", port: 22, user: "user", hostKey: GOOD_KEY };
    const payload = "x '-oProxyCommand=touch /tmp/p'";
    await expect(manager.openSession({ sandboxId: payload, endpoint, tunnel: null, connectTimeoutSec: 1 }))
      .rejects.toThrow(/sandbox id/);
    expect(manager.getSession(payload)).toBeNull();
    await expect(manager.openSession({
      sandboxId: "bx_ok1",
      endpoint: { ...endpoint, hostKey: `${GOOD_KEY}\nextra ssh-ed25519 AAAA` },
      tunnel: null,
      connectTimeoutSec: 1,
    })).rejects.toThrow(/host key/);
    expect(manager.getSession("bx_ok1")).toBeNull();
    await manager.closeAll();
  });
});

describe("buildRsyncPushArgs validation", () => {
  const spec = {
    controlPath: "/tmp/pcboat/abc.ctl",
    user: "user",
    host: "10.0.0.9",
    port: 2222,
    privateKeyPath: "/tmp/pcboat/id_ed25519",
    knownHostsPath: "/tmp/pcboat/known_hosts_abc",
    hostKeyAlias: "bx_abc1",
    connectTimeoutSec: 10,
  };

  it("pins -F /dev/null in the rsync ssh transport", () => {
    const args = buildRsyncPushArgs(spec, "/tmp/snap", "/home/user/card-1", ["a.rs"]);
    const transport = args[args.indexOf("-e") + 1];
    expect(transport.startsWith("ssh -F /dev/null ")).toBe(true);
  });

  it("throws before spawning on option payloads in any -e component", () => {
    expect(() => buildRsyncPushArgs({ ...spec, hostKeyAlias: "x '-oProxyCommand=touch /tmp/p'" }, "/tmp/snap", "/g", [])).toThrow(/hostKeyAlias/);
    expect(() => buildRsyncPushArgs({ ...spec, hostKeyAlias: "x\\ -oProxyCommand=touch${IFS}/tmp/p" }, "/tmp/snap", "/g", [])).toThrow(/hostKeyAlias/);
    expect(() => buildRsyncPushArgs({ ...spec, user: "-oProxyCommand=x" }, "/tmp/snap", "/g", [])).toThrow(/sshUser/);
    expect(() => buildRsyncPushArgs({ ...spec, host: "-oFoo=bar" }, "/tmp/snap", "/g", [])).toThrow(/host/);
    expect(() => buildRsyncPushArgs({ ...spec, controlPath: "/tmp/a b.ctl" }, "/tmp/snap", "/g", [])).toThrow(/controlPath/);
    expect(() => buildRsyncPushArgs({ ...spec, privateKeyPath: "/tmp/k';touch${IFS}/tmp/p;'" }, "/tmp/snap", "/g", [])).toThrow(/privateKeyPath/);
    expect(() => buildRsyncPushArgs(spec, "/tmp/snap", "/g;touch /tmp/p", [])).toThrow(/guestDir/);
    expect(() => buildRsyncPushArgs({ ...spec, port: 0 }, "/tmp/snap", "/g", [])).toThrow(/port/);
  });
});

describe("operator ssh config is never applied (loopback sshd)", () => {
  let fixture: LoopbackSsh;
  let evilHome: string;
  let marker: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    fixture = new LoopbackSsh();
    await fixture.start();
    evilHome = await mkdtemp(path.join(tmpdir(), "pcboat-evil-home-"));
    marker = path.join(evilHome, "localcommand-ran");
    await mkdir(path.join(evilHome, ".ssh"), { mode: 0o700 });
    await writeFile(
      path.join(evilHome, ".ssh", "config"),
      `Host *\n  PermitLocalCommand yes\n  LocalCommand touch ${marker}\n`,
      { mode: 0o600 },
    );
    savedHome = process.env.HOME;
    process.env.HOME = evilHome;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await fixture.cleanup();
    await rm(evilHome, { recursive: true, force: true });
  });

  // A session whose control socket does not exist: ssh must open a fresh
  // connection, which is exactly when a config LocalCommand would fire.
  function directSession(): SshSession {
    return {
      ...fixture.session,
      controlPath: path.join(fixture.root, "no-master.ctl"),
      master: null,
    };
  }

  it("the planted config fires for a plain ssh that reads it, but SshManager ignores it", async () => {
    const { endpoint } = fixture.session;
    const control = await runProcess("ssh", [
      "-F", path.join(evilHome, ".ssh", "config"),
      "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${fixture.session.knownHostsPath}`, "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "HostKeyAlias=loopback-only", "-i", path.join(fixture.root, "client"),
      "-p", String(endpoint.port), `${endpoint.user}@${endpoint.host}`, "true",
    ], { timeoutMs: 10_000 });
    expect(control.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const result = await fixture.manager.run(directSession(), "printf ok", { timeoutMs: 10_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("openSession's control master also connects without applying it", async () => {
    const { endpoint } = fixture.session;
    const keyPath = path.join(fixture.root, "client");
    class LocalKeyManager extends SshManager {
      override async ensureKey() {
        return { privateKeyPath: keyPath, publicKey: (await readFile(`${keyPath}.pub`, "utf8")).trim() };
      }
    }
    const manager = new LocalKeyManager({ info() {}, warn() {} });
    try {
      const session = await manager.openSession({
        sandboxId: "loopback-only",
        // The fixture's .pub line carries a comment; the provider contract
        // validated by openSession is the bare `<type> <base64>` pair.
        endpoint: { host: endpoint.host, port: endpoint.port, user: endpoint.user, hostKey: endpoint.hostKey.split(" ").slice(0, 2).join(" ") },
        tunnel: null,
        connectTimeoutSec: 2,
      });
      expect(manager.masterAlive(session)).toBe(true);
      const result = await manager.run(session, "printf ok", { timeoutMs: 10_000 });
      expect(result).toMatchObject({ exitCode: 0, stdout: "ok" });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await manager.closeAll();
    }
  }, 30_000);

  it("the rsync push argv ignores it on a direct connection too", async () => {
    const { session } = fixture;
    const snapshot = path.join(fixture.root, "snapshot-evil-home");
    const guestDir = path.join(fixture.root, "guest-evil-home");
    await mkdir(snapshot, { recursive: true });
    await mkdir(guestDir, { recursive: true });
    await writeFile(path.join(snapshot, "file.txt"), "payload");
    const argv = buildRsyncPushArgs(
      {
        controlPath: path.join(fixture.root, "no-master.ctl"),
        user: session.endpoint.user,
        host: session.endpoint.host,
        port: session.endpoint.port,
        privateKeyPath: path.join(fixture.root, "client"),
        knownHostsPath: session.knownHostsPath,
        hostKeyAlias: session.sandboxId,
        connectTimeoutSec: session.connectTimeoutSec,
      },
      snapshot,
      guestDir,
      ["file.txt"],
    );
    const result = await runStreamProcess("rsync", argv.slice(1), {
      stdin: Readable.from([renderFilesFromList([{ path: "file.txt" }])]),
      timeoutMs: 15_000,
      killProcessGroup: true,
    });
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(guestDir, "file.txt"), "utf8")).toBe("payload");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});
