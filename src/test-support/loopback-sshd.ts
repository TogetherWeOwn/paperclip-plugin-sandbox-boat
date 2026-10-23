// Real unprivileged OpenSSH, loopback only, no host config/service changes.
// Set PAPERCLIP_TEST_SSHD to an isolated executable when sshd is not installed.
// OpenSSH 10 extracted packages may also need PAPERCLIP_TEST_SSHD_LIBEXEC.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { SshManager } from "../ssh.js";
import type { SshSession } from "../ssh.js";
import { waitFor } from "./local-sync-ssh.js";

async function checked(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${output}`)));
  });
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 500);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

export class LoopbackSsh {
  root = "";
  manager!: SshManager;
  session!: SshSession;
  private daemon?: ChildProcess;
  private master?: ChildProcess;

  async start() {
    const executable = process.env.PAPERCLIP_TEST_SSHD ?? ["/usr/sbin/sshd", "/usr/bin/sshd"].find(existsSync);
    if (!executable) throw new Error("Real loopback SSH prerequisite unavailable: set PAPERCLIP_TEST_SSHD to an isolated OpenSSH server; the signal-forwarding relay is not equivalent.");
    this.root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "sshd-"));
    try {
      for (const key of ["host", "client"]) await checked("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "loopback-test-only", "-f", path.join(this.root, key)]);
      const key = path.join(this.root, "client");
      const publicKey = (await readFile(`${key}.pub`, "utf8")).trim();
      await writeFile(path.join(this.root, "authorized_keys"), `${publicKey}\n`, { mode: 0o600 });
      const server = createServer();
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const port = (server.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const libexec = process.env.PAPERCLIP_TEST_SSHD_LIBEXEC;
      const config = path.join(this.root, "sshd_config");
      await writeFile(config, [
        `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${this.root}/host`, `PidFile ${this.root}/sshd.pid`,
        `AuthorizedKeysFile ${this.root}/authorized_keys`, `AllowUsers ${userInfo().username}`,
        "PubkeyAuthentication yes", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no",
        "PermitRootLogin no", "AllowAgentForwarding no", "AllowTcpForwarding no", "X11Forwarding no", "PermitTunnel no",
        // Scratch may have world-writable ancestors; only this throwaway key is
        // authorized. Nothing is installed in a user's actual ~/.ssh directory.
        "StrictModes no", "LogLevel VERBOSE",
        ...(libexec ? [`SshdSessionPath ${libexec}/sshd-session`, `SshdAuthPath ${libexec}/sshd-auth`] : []), "",
      ].join("\n"), { mode: 0o600 });
      let diagnostic = "";
      this.daemon = spawn(executable, ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
      this.daemon.stderr!.on("data", (bytes) => { diagnostic += String(bytes); });
      this.daemon.on("error", (error) => { diagnostic += error.message; });
      await waitFor(() => {
        if (this.daemon!.exitCode !== null || this.daemon!.signalCode !== null) throw new Error(`Isolated sshd failed: ${diagnostic}`);
        return diagnostic.includes("Server listening on 127.0.0.1");
      }, "isolated sshd never listened");
      const knownHostsPath = path.join(this.root, "known_hosts");
      const hostKey = (await readFile(path.join(this.root, "host.pub"), "utf8")).trim();
      await writeFile(knownHostsPath, `loopback-only ${hostKey}\n`, { mode: 0o600 });
      class LocalKeyManager extends SshManager {
        override async ensureKey() { return { privateKeyPath: key, publicKey }; }
      }
      this.manager = new LocalKeyManager({ info() {}, warn() {} });
      this.session = {
        sandboxId: "loopback-only", endpoint: { host: "127.0.0.1", port, user: userInfo().username, hostKey },
        knownHostsPath, controlPath: path.join(this.root, "ctl"), master: null,
        tunnel: "disabled", tunnelSpec: null, tunnelError: null, connectTimeoutSec: 2, lastMasterStartAt: 0,
      };
      let masterDiagnostic = "";
      this.master = spawn("ssh", ["-F", "/dev/null", "-N", "-o", "ControlMaster=yes", "-o", "ControlPersist=no",
        "-o", `ControlPath=${this.session.controlPath}`, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsPath}`,
        "-o", "GlobalKnownHostsFile=/dev/null", "-o", "HostKeyAlias=loopback-only",
        "-i", key, "-p", String(port), `${userInfo().username}@127.0.0.1`,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      this.master.stderr!.on("data", (bytes) => { masterDiagnostic += String(bytes); });
      await waitFor(() => {
        if (this.master!.exitCode !== null || this.master!.signalCode !== null) throw new Error(`Control master failed: ${masterDiagnostic}; sshd: ${diagnostic}`);
        return existsSync(this.session.controlPath);
      }, "loopback control socket never appeared");
      this.session.master = this.master;
      const result = await this.manager.runStream(this.session, "printf connected", { timeoutMs: 2000 });
      if (result.stdout !== "connected" || result.exitCode !== 0) throw new Error(`Loopback command failed: ${JSON.stringify(result)}; sshd: ${diagnostic}`);
    } catch (error) { await this.cleanup(); throw error; }
  }

  async cleanup() {
    await stop(this.master);
    await stop(this.daemon);
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}
