// Test doubles: a scripted `ssh`/`ssh-keygen` (via a mocked spawn) and a
// minimal Paperclip plugin context (state, logger, issues, jobs).
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";

export class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  stdinText = "";
  private stdinEnded: (() => void) | null = null;
  stdin = {
    on: () => this.stdin,
    write: (chunk: string) => {
      this.stdinText += chunk;
      return true;
    },
    end: () => {
      this.stdinEnded?.();
    },
  };

  onStdinEnd(fn: () => void): void {
    this.stdinEnded = fn;
  }

  finish(code: number, stdout = "", stderr = ""): void {
    queueMicrotask(() => {
      if (stdout) this.stdout.emit("data", stdout);
      if (stderr) this.stderr.emit("data", stderr);
      this.exitCode = code;
      this.emit("exit", code, null);
      this.emit("close", code, null);
    });
  }

  kill(signal = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
    });
    return true;
  }
}

export interface SpawnRecord {
  command: string;
  args: string[];
  stdin: string;
  child: MockChild;
}

export interface ExecReply {
  code: number;
  stdout?: string;
  stderr?: string;
}

function optionValue(args: string[], name: string): string | null {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "-o" && args[i + 1].startsWith(`${name}=`)) return args[i + 1].slice(name.length + 1);
  }
  return null;
}

export class FakeSsh {
  readonly spawned: SpawnRecord[] = [];
  masterFailures = 0;
  /** Return a reply for a remote command, or undefined for the default. */
  handler: ((remoteCommand: string, stdin: string) => ExecReply | undefined) | null = null;

  readonly spawn = (command: string, args: string[], options?: { stdio?: unknown[] }) => {
    const child = new MockChild();
    const record: SpawnRecord = { command, args: [...args], stdin: "", child };
    this.spawned.push(record);
    if (command === "ssh-keygen") {
      const file = args[args.indexOf("-f") + 1];
      writeFileSync(file, "-----BEGIN OPENSSH PRIVATE KEY-----\nTEST\n-----END OPENSSH PRIVATE KEY-----\n", { mode: 0o600 });
      writeFileSync(`${file}.pub`, "ssh-ed25519 AAAATESTPUBLICKEY paperclip-boat\n");
      child.finish(0);
      return child;
    }
    if (command === "ssh" && args.includes("-V")) {
      child.finish(0, "", "OpenSSH_10.0p2");
      return child;
    }
    if (command === "ssh" && args.includes("-N")) {
      if (this.masterFailures > 0) {
        this.masterFailures -= 1;
        child.finish(255, "", "Error: remote port forwarding failed for listen port 8317");
        return child;
      }
      const controlPath = optionValue(args, "ControlPath");
      if (controlPath) writeFileSync(controlPath, "");
      return child; // stays alive until killed
    }
    const remoteCommand = args[args.length - 1];
    const respond = () => {
      record.stdin = child.stdinText;
      const reply = this.handler?.(remoteCommand, child.stdinText) ?? this.defaultReply(remoteCommand);
      child.finish(reply.code, reply.stdout ?? "", reply.stderr ?? "");
    };
    const stdio = options?.stdio ?? [];
    if (stdio[0] === "pipe") child.onStdinEnd(respond);
    else queueMicrotask(respond);
    return child;
  };

  private defaultReply(remoteCommand: string): ExecReply {
    if (remoteCommand.includes('"$d" "$s"')) {
      return { code: 0, stdout: "/home/user/paperclip-workspace\nbash\n" };
    }
    return { code: 0, stdout: "ok\n" };
  }

  sshCalls(): SpawnRecord[] {
    return this.spawned.filter((entry) => entry.command === "ssh" && !entry.args.includes("-V"));
  }

  masters(): SpawnRecord[] {
    return this.spawned.filter((entry) => entry.command === "ssh" && entry.args.includes("-N"));
  }

  execs(): SpawnRecord[] {
    return this.spawned.filter((entry) => entry.command === "ssh" && !entry.args.includes("-N") && !entry.args.includes("-V"));
  }
}

export interface FakeLogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  meta?: Record<string, unknown>;
}

// Emulation of the Paperclip host's invocation scopes (plugin-worker-manager +
// host-client-factory): calls made inside a host request carry its invocation;
// a finished invocation is refused; an invocation with no company refuses
// company state; calls outside any invocation are "proactive" and allowed only
// for configured companies. Instance-scoped state needs a company invocation.
export interface FakeInvocation {
  id: string;
  companyId: string | null;
  ended: boolean;
}

export const fakeInvocations = new AsyncLocalStorage<FakeInvocation>();

/** Run fn the way the host runs a plugin RPC: inside an invocation that ends when fn settles. */
export async function inHostInvocation<T>(companyId: string | null, fn: () => Promise<T>): Promise<T> {
  const invocation: FakeInvocation = { id: randomUUID(), companyId, ended: false };
  try {
    return await fakeInvocations.run(invocation, fn);
  } finally {
    invocation.ended = true;
  }
}

function hostScopeCheck(
  method: string,
  input: { scopeKind: string; scopeId?: string },
  proactiveCompanies: Set<string>,
): void {
  const invocation = fakeInvocations.getStore();
  const company = input.scopeKind === "company" ? (input.scopeId ?? null) : null;
  const deny = (why: string) => new Error(`Plugin is not allowed to perform "${method}": ${why}`);
  if (invocation) {
    if (invocation.ended) throw deny("the worker referenced a missing, expired, or unknown invocation scope");
    if (!invocation.companyId) throw deny("company context is required");
    if (company && company !== invocation.companyId) throw deny(`requested company "${company}" but the current invocation is scoped to company "${invocation.companyId}"`);
    return;
  }
  if (company && proactiveCompanies.has(company)) return;
  throw deny("company context is required");
}

export function createFakeContext(
  options: { issues?: Map<string, { status: string }>; hostScopes?: { proactiveCompanies: string[] } } = {},
) {
  const state = new Map<string, unknown>();
  const logs: FakeLogEntry[] = [];
  const jobs = new Map<string, (job: unknown) => Promise<void>>();
  const issues = options.issues ?? new Map<string, { status: string }>();
  const keyOf = (input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) =>
    `${input.scopeKind}|${input.scopeId ?? ""}|${input.namespace ?? "default"}|${input.stateKey}`;
  const log = (level: FakeLogEntry["level"]) => (message: string, meta?: Record<string, unknown>) => {
    logs.push({ level, message, meta });
  };
  const proactive = new Set(options.hostScopes?.proactiveCompanies ?? []);
  const check = (method: string, input: { scopeKind: string; scopeId?: string }) => {
    if (options.hostScopes) hostScopeCheck(method, input, proactive);
  };
  const ctx = {
    state: {
      get: async (input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
        check("state.get", input);
        return state.has(keyOf(input)) ? structuredClone(state.get(keyOf(input))) : null;
      },
      set: async (input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }, value: unknown) => {
        check("state.set", input);
        state.set(keyOf(input), structuredClone(value));
      },
      delete: async (input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
        state.delete(keyOf(input));
      },
    },
    logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
    issues: {
      get: async (issueId: string) => issues.get(issueId) ?? null,
    },
    jobs: {
      register: (key: string, fn: (job: unknown) => Promise<void>) => {
        jobs.set(key, fn);
      },
    },
  };
  return { ctx, state, logs, jobs, issues };
}
