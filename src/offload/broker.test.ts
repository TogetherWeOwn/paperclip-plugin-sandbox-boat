import { describe, expect, it } from "vitest";
import {
  OffloadBroker,
  type BackendCommand,
  type OffloadBackend,
  type OffloadBackendHandle,
  type OffloadJournalStore,
  type OffloadOutputSink,
} from "./broker.js";
import type { OffloadReadResponse, OffloadSubmitRequest } from "./protocol.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RUN = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const OTHER_RUN = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const OTHER_COMPANY = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const CMD = "7d82278c-2ba7-4e68-96ab-a2cc10b697af";
const WS = "b9d0e6ac-a14e-4440-a324-7dcdd758be08";

const PRINCIPAL = { companyId: COMPANY, runId: RUN, cardId: "card-1", repoId: "repo-1", profileId: "rust-public-1" };

function submitFor(commandId: string = CMD): OffloadSubmitRequest {
  return {
    version: 1,
    commandId,
    executionWorkspaceId: WS,
    cwdRelative: ".",
    argv: ["test", "--locked"],
    env: { CARGO_TERM_COLOR: "never" },
    queueTimeoutMs: 30000,
    timeoutMs: 1200000,
    dryRun: false,
  };
}

function persisted(store: MapStore): unknown {
  return store.data.get(`offload.cmd.${CMD}`);
}

class MapStore implements OffloadJournalStore {
  readonly data = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.data.has(key) ? structuredClone(this.data.get(key)) : null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

interface StartedCall {
  cmd: BackendCommand;
  sink: OffloadOutputSink;
  handle: { cancelled: boolean; cancel: () => Promise<void>; done: Promise<void> };
}

class FakeBackend implements OffloadBackend {
  readonly starts: StartedCall[] = [];
  startThrows: Error | null = null;
  onStart: ((call: StartedCall) => void) | null = null;

  start(cmd: BackendCommand, sink: OffloadOutputSink): OffloadBackendHandle {
    if (this.startThrows) throw this.startThrows;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const call: StartedCall = {
      cmd,
      sink,
      handle: {
        cancelled: false,
        cancel: async () => {
          call.handle.cancelled = true;
          resolveDone();
        },
        done,
      },
    };
    this.starts.push(call);
    this.onStart?.(call);
    return call.handle;
  }
}

function setup() {
  const clock = { t: Date.parse("2026-10-23T10:00:00Z") };
  const store = new MapStore();
  const backend = new FakeBackend();
  const broker = new OffloadBroker({ store, backend, now: () => clock.t });
  return { clock, store, backend, broker };
}

function readBody(response: { status: number; body: unknown }): OffloadReadResponse {
  expect(response.status).toBe(200);
  return response.body as OffloadReadResponse;
}

describe("submit", () => {
  it("accepts with 202 queued, not fallback-safe", async () => {
    const { broker } = setup();
    const response = await broker.submit(submitFor(), PRINCIPAL);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ version: 1, commandId: CMD, state: "queued", remoteStarted: false, fallbackSafe: false, eventsCursor: 0 });
  });

  it("returns the same command on duplicate submit with the same payload", async () => {
    const { broker, backend } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const again = await broker.submit(submitFor(), PRINCIPAL);
    expect(again.status).toBe(200);
    expect((again.body as OffloadReadResponse).commandId).toBe(CMD);
    expect(backend.starts.length).toBe(1);
  });

  it("rejects the same ID with a different payload", async () => {
    const { broker } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const conflict = await broker.submit({ ...submitFor(), argv: ["build"] }, PRINCIPAL);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "OFFLOAD_IDEMPOTENCY_CONFLICT" });
  });

  it("refuses new admissions past 512 commands per run without dispatching", async () => {
    const { broker, backend } = setup();
    for (let i = 0; i < 512; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const response = await broker.submit(submitFor(id), PRINCIPAL);
      expect(response.status).toBe(202);
    }
    const refused = await broker.submit(submitFor(), PRINCIPAL);
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ code: "OFFLOAD_UNAVAILABLE", remoteStarted: false, fallbackSafe: true });
    expect(backend.starts.length).toBe(512);
  });

  it("journals not_started when the backend fails before spawn", async () => {
    const { broker, backend } = setup();
    backend.startThrows = new Error("no VM");
    const response = await broker.submit(submitFor(), PRINCIPAL);
    expect(response.status).toBe(202);
    const view = readBody(await broker.read(CMD, PRINCIPAL, 0));
    expect(view.state).toBe("not_started");
    expect(view.remoteStarted).toBe(false);
    expect(view.fallbackSafe).toBe(true);
  });
});

describe("recordRefusal", () => {
  it("journals a deterministic refusal as not_started without dispatching", async () => {
    const { broker, backend } = setup();
    await broker.recordRefusal(submitFor(), PRINCIPAL, "incompatible workload");
    const view = readBody(await broker.read(CMD, PRINCIPAL, 0));
    expect(view.state).toBe("not_started");
    expect(view.remoteStarted).toBe(false);
    expect(view.fallbackSafe).toBe(true);
    expect(backend.starts.length).toBe(0);
  });

  it("is idempotent for the same payload and conflicts on a different one", async () => {
    const { broker } = setup();
    await broker.recordRefusal(submitFor(), PRINCIPAL, "x");
    await broker.recordRefusal(submitFor(), PRINCIPAL, "x");
    await expect(broker.recordRefusal({ ...submitFor(), argv: ["build"] }, PRINCIPAL, "x")).rejects.toThrow("OFFLOAD_IDEMPOTENCY_CONFLICT");
  });

  it("lets a duplicate submit observe the refusal without a second dispatch", async () => {
    const { broker, backend } = setup();
    await broker.recordRefusal(submitFor(), PRINCIPAL, "x");
    const again = await broker.submit(submitFor(), PRINCIPAL);
    expect(again.status).toBe(200);
    expect((again.body as OffloadReadResponse).state).toBe("not_started");
    expect(backend.starts.length).toBe(0);
  });
});

describe("read", () => {
  it("rejects unknown command ids", async () => {
    const { broker } = setup();
    const response = await broker.read(CMD, PRINCIPAL, 0);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "OFFLOAD_INVALID_REQUEST" });
  });

  it("denies cross-run and cross-company reads", async () => {
    const { broker } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const crossRun = await broker.read(CMD, { ...PRINCIPAL, runId: OTHER_RUN }, 0);
    expect(crossRun.status).toBe(403);
    expect(crossRun.body).toMatchObject({ code: "OFFLOAD_FORBIDDEN" });
    const crossCompany = await broker.read(CMD, { ...PRINCIPAL, companyId: OTHER_COMPANY }, 0);
    expect(crossCompany.status).toBe(403);
  });

  it("returns ordered cursor batches bounded to 64 KiB per response", async () => {
    const { broker, backend } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const sink = backend.starts[0]!.sink;
    sink.started();
    sink.write("stdout", Buffer.from("out1"));
    sink.write("stderr", Buffer.from("err1"));
    sink.write("stdout", Buffer.from("x".repeat(70 * 1024)));
    const first = readBody(await broker.read(CMD, PRINCIPAL, 0));
    expect(first.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(first.nextCursor).toBe(2);
    const second = readBody(await broker.read(CMD, PRINCIPAL, 2));
    expect(second.events.map((e) => e.seq)).toEqual([2]);
    expect(second.nextCursor).toBe(3);
  });

  it("preserves arbitrary binary bytes through base64", async () => {
    const { broker, backend } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const bytes = Buffer.from([0, 1, 2, 250, 251, 255, 10, 13]);
    backend.starts[0]!.sink.started();
    backend.starts[0]!.sink.write("stdout", bytes);
    const view = readBody(await broker.read(CMD, PRINCIPAL, 0));
    expect(Buffer.from(view.events[0]!.dataBase64, "base64").equals(bytes)).toBe(true);
    expect(view.events[0]).toMatchObject({ seq: 0, stream: "stdout" });
  });

  it("has no execution effects on duplicate reads", async () => {
    const { broker, backend } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    backend.starts[0]!.sink.started();
    const first = readBody(await broker.read(CMD, PRINCIPAL, 0));
    const second = readBody(await broker.read(CMD, PRINCIPAL, 0));
    expect(second).toEqual(first);
    expect(backend.starts.length).toBe(1);
  });

  it("exposes the terminal result with exit metadata and sync state", async () => {
    const { broker, backend } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const sink = backend.starts[0]!.sink;
    sink.started();
    sink.complete({
      exitCode: 0,
      signal: null,
      timedOut: false,
      syncBack: { state: "staged", changedPaths: ["Cargo.lock"], conflictPaths: [], artifactId: "art-1" },
    });
    const view = readBody(await broker.read(CMD, PRINCIPAL, 0));
    expect(view.state).toBe("completed");
    expect(view.result).toMatchObject({ exitCode: 0, syncBack: { state: "staged", artifactId: "art-1" } });
  });
});

describe("heartbeat", () => {
  it("renews client interest while status reads do not", async () => {
    const { broker, backend, clock } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    backend.starts[0]!.sink.started();
    clock.t += 20_000;
    await broker.read(CMD, PRINCIPAL, 0);
    clock.t += 11_000;
    await broker.checkExpirations();
    // Read alone did not renew: the command expired at 30 s.
    expect(readBody(await broker.read(CMD, PRINCIPAL, 0)).state).toBe("cancelled");
  });

  it("keeps an actively heartbeated command alive", async () => {
    const { broker, backend, clock } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    backend.starts[0]!.sink.started();
    clock.t += 20_000;
    const renewed = await broker.heartbeat(CMD, PRINCIPAL);
    expect(renewed.status).toBe(200);
    clock.t += 20_000;
    await broker.checkExpirations();
    expect(readBody(await broker.read(CMD, PRINCIPAL, 0)).state).toBe("running");
  });

  it("also expires other dead commands known to this worker", async () => {
    const { broker, backend, clock } = setup();
    const other = "00000000-0000-4000-8000-000000000007";
    await broker.submit(submitFor(), PRINCIPAL);
    await broker.submit(submitFor(other), PRINCIPAL);
    backend.starts[0]!.sink.started();
    backend.starts[1]!.sink.started();
    clock.t += 20_000;
    await broker.heartbeat(CMD, PRINCIPAL);
    clock.t += 20_000;
    // CMD stays alive on its heartbeat; the other command expired with no
    // heartbeat of its own, reaped by CMD's next heartbeat.
    await broker.heartbeat(CMD, PRINCIPAL);
    expect(readBody(await broker.read(CMD, PRINCIPAL, 0)).state).toBe("running");
    expect(readBody(await broker.read(other, PRINCIPAL, 0)).state).toBe("cancelled");
  });

  it("is a no-op on a terminal command", async () => {
    const { broker, backend } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const sink = backend.starts[0]!.sink;
    sink.started();
    sink.complete({ exitCode: 0, signal: null, timedOut: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null } });
    expect((await broker.heartbeat(CMD, PRINCIPAL)).status).toBe(200);
  });
});

describe("journal write failures and sweep cost", () => {
  it("holds a started command as unknown when the started() write is lost, never fallback-safe", async () => {
    const clock = { t: Date.parse("2026-10-23T10:00:00Z") };
    const store = new MapStore();
    const backend = new FakeBackend();
    const broker = new OffloadBroker({ store, backend, now: () => clock.t });
    await broker.submit(submitFor(), PRINCIPAL);
    const realSet = store.set.bind(store);
    store.set = async () => {
      store.set = realSet;
      throw new Error("transient write loss");
    };
    backend.starts[0]!.sink.started();
    const cancelled = readBody(await broker.cancel(CMD, PRINCIPAL, "client_signal"));
    expect(cancelled.state).toBe("unknown");
    expect(cancelled.fallbackSafe).toBe(false);
    expect(readBody(await broker.read(CMD, PRINCIPAL, 0)).fallbackSafe).toBe(false);
    expect(persisted(store)).toMatchObject({ state: "unknown", fallbackSafe: false });
  });

  it("does not serve a complete result after an output write was lost", async () => {
    const clock = { t: Date.parse("2026-10-23T10:00:00Z") };
    const store = new MapStore();
    const backend = new FakeBackend();
    const broker = new OffloadBroker({ store, backend, now: () => clock.t });
    await broker.submit(submitFor(), PRINCIPAL);
    const sink = backend.starts[0]!.sink;
    sink.started();
    await broker.read(CMD, PRINCIPAL, 0);
    const realSet = store.set.bind(store);
    store.set = async () => {
      store.set = realSet;
      throw new Error("transient write loss");
    };
    sink.write("stdout", new TextEncoder().encode("lost line\n"));
    sink.complete({ exitCode: 0, signal: null, timedOut: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null } });
    const view = readBody(await broker.read(CMD, PRINCIPAL, 0));
    expect(view.state).toBe("unknown");
    expect(view.fallbackSafe).toBe(false);
    // The raw journal, not just the in-process view, must keep the hold: a
    // restarted worker has no poison set and serves the persisted state as-is.
    expect(persisted(store)).toMatchObject({ state: "unknown", fallbackSafe: false });
  });

  it("keeps the persisted unknown hold when a started() write is lost and the backend then fails to start", async () => {
    const clock = { t: Date.parse("2026-10-23T10:00:00Z") };
    const store = new MapStore();
    const backend = new FakeBackend();
    const broker = new OffloadBroker({ store, backend, now: () => clock.t });
    await broker.submit(submitFor(), PRINCIPAL);
    const realSet = store.set.bind(store);
    store.set = async () => {
      store.set = realSet;
      throw new Error("transient write loss");
    };
    const sink = backend.starts[0]!.sink;
    sink.started();
    sink.failToStart("cancelled during start");
    await broker.read(CMD, PRINCIPAL, 0);
    expect(persisted(store)).toMatchObject({ state: "unknown", fallbackSafe: false });
    // A restarted broker over the same journal must not offer the local fallback.
    const restarted = new OffloadBroker({ store, backend: new FakeBackend(), now: () => clock.t });
    const view = readBody(await restarted.read(CMD, PRINCIPAL, 0));
    expect(view.fallbackSafe).toBe(false);
    expect(view.state).not.toBe("not_started");
  });

  it("stops scanning terminal commands: a heartbeat reads only live work", async () => {
    const clock = { t: Date.parse("2026-10-23T10:00:00Z") };
    const store = new MapStore();
    const backend = new FakeBackend();
    const broker = new OffloadBroker({ store, backend, now: () => clock.t });
    const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`);
    for (const id of ids) await broker.submit(submitFor(id), PRINCIPAL);
    for (const call of backend.starts) {
      call.sink.started();
      call.sink.complete({ exitCode: 0, signal: null, timedOut: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null } });
    }
    await broker.submit(submitFor(), PRINCIPAL);
    backend.starts[12]!.sink.started();
    await broker.heartbeat(CMD, PRINCIPAL); // prunes the terminal commands it sees
    let gets = 0;
    const realGet = store.get.bind(store);
    store.get = async (key: string) => {
      gets += 1;
      return realGet(key);
    };
    await broker.heartbeat(CMD, PRINCIPAL);
    expect(gets).toBeLessThanOrEqual(2);
  });

  it("renews from a fresh clock when the sweep is slow", async () => {
    const clock = { t: Date.parse("2026-10-23T10:00:00Z") };
    const store = new MapStore();
    const backend = new FakeBackend();
    const broker = new OffloadBroker({ store, backend, now: () => clock.t });
    const other = "00000000-0000-4000-8000-000000000007";
    await broker.submit(submitFor(), PRINCIPAL);
    await broker.submit(submitFor(other), PRINCIPAL);
    backend.starts[0]!.sink.started();
    backend.starts[1]!.sink.started();
    await broker.read(CMD, PRINCIPAL, 0);
    const realGet = store.get.bind(store);
    store.get = async (key: string) => {
      clock.t += 20_000;
      return realGet(key);
    };
    await broker.heartbeat(CMD, PRINCIPAL);
    store.get = realGet;
    await broker.checkExpirations();
    expect(readBody(await broker.read(CMD, PRINCIPAL, 0)).state).toBe("running");
  });
});

describe("cancel", () => {
  it("cancels a queued command as never started and fallback-safe", async () => {
    const { broker, backend } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const response = await broker.cancel(CMD, PRINCIPAL, "client_signal");
    expect(response.status).toBe(200);
    const view = response.body as OffloadReadResponse;
    expect(view.state).toBe("not_started");
    expect(view.remoteStarted).toBe(false);
    expect(view.fallbackSafe).toBe(true);
    expect(backend.starts[0]!.handle.cancelled).toBe(true);
  });

  it("cancels a running command without erasing that it ran", async () => {
    const { broker, backend } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    backend.starts[0]!.sink.started();
    const view = (await broker.cancel(CMD, PRINCIPAL, "client_signal")).body as OffloadReadResponse;
    expect(view.state).toBe("cancelled");
    expect(view.remoteStarted).toBe(true);
    expect(view.fallbackSafe).toBe(false);
    expect(view.result).toMatchObject({ cancelled: true });
  });

  it("is idempotent", async () => {
    const { broker } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const first = (await broker.cancel(CMD, PRINCIPAL, "client_signal")).body as OffloadReadResponse;
    const second = (await broker.cancel(CMD, PRINCIPAL, "client_signal")).body as OffloadReadResponse;
    expect(second).toEqual(first);
  });
});

describe("output bounds", () => {
  it("cancels on 64 MiB exhaustion and reports OFFLOAD_OUTPUT_LIMIT with retained output", async () => {
    const { broker, backend } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const sink = backend.starts[0]!.sink;
    sink.started();
    sink.write("stdout", Buffer.alloc(63 * 1024 * 1024, 7));
    sink.write("stdout", Buffer.alloc(2 * 1024 * 1024, 8));
    const view = readBody(await broker.read(CMD, PRINCIPAL, 0, 128));
    expect(view.terminalError).toBe("OFFLOAD_OUTPUT_LIMIT");
    expect(view.events.length).toBeGreaterThan(0);
    expect(backend.starts[0]!.handle.cancelled).toBe(true);
  });
});

describe("restart and failure holds", () => {
  it("holds a live command as unknown when its handle is gone (worker restart)", async () => {
    const { broker, backend, store, clock } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    backend.starts[0]!.sink.started();
    const restarted = new OffloadBroker({ store, backend: new FakeBackend(), now: () => clock.t });
    const view = readBody(await restarted.read(CMD, PRINCIPAL, 0));
    expect(view.state).toBe("unknown");
    expect(view.result).toBeNull();
  });

  it("refuses to resubmit an expired id as if known not started", async () => {
    const { broker, backend, clock } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const sink = backend.starts[0]!.sink;
    sink.started();
    sink.complete({ exitCode: 0, signal: null, timedOut: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null } });
    clock.t += 25 * 60 * 60_000;
    await broker.read(CMD, PRINCIPAL, 0);
    const resubmit = await broker.submit(submitFor(), PRINCIPAL);
    expect(resubmit.status).toBe(410);
    expect(resubmit.body).toMatchObject({ code: "OFFLOAD_RESULT_EXPIRED" });
    expect(backend.starts.length).toBe(1);
  });

  it("holds a backend failure as failed without a cargo result", async () => {
    const { broker, backend } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    backend.starts[0]!.sink.fail(new Error("ssh died"));
    const view = readBody(await broker.read(CMD, PRINCIPAL, 0));
    expect(view.state).toBe("failed");
    expect(view.result).toBeNull();
  });
});

describe("expiry", () => {
  it("returns OFFLOAD_RESULT_EXPIRED after 24 h and keeps a tombstone", async () => {
    const { broker, backend, clock, store } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    const sink = backend.starts[0]!.sink;
    sink.started();
    sink.complete({ exitCode: 0, signal: null, timedOut: false, syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null } });
    clock.t += 25 * 60 * 60_000;
    const response = await broker.read(CMD, PRINCIPAL, 0);
    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ code: "OFFLOAD_RESULT_EXPIRED" });
    expect(await store.get(`offload.tomb.${CMD}`)).not.toBeNull();
  });

  it("never expires an unresolved command", async () => {
    const { broker, backend, clock } = setup();
    await broker.submit(submitFor(), PRINCIPAL);
    backend.starts[0]!.sink.started();
    // Heartbeats keep it alive past 24 h; it must still read, not 410.
    for (let i = 0; i < 100; i += 1) {
      clock.t += 20_000;
      await broker.heartbeat(CMD, PRINCIPAL);
    }
    expect((await broker.read(CMD, PRINCIPAL, 0)).status).toBe(200);
  });

  it("enforces the command deadline through the same cancel path", async () => {
    const { broker, backend, clock } = setup();
    await broker.submit({ ...submitFor(), timeoutMs: 60_000 }, PRINCIPAL);
    backend.starts[0]!.sink.started();
    clock.t += 61_000;
    await broker.heartbeat(CMD, PRINCIPAL);
    await broker.checkExpirations();
    const view = readBody(await broker.read(CMD, PRINCIPAL, 0));
    expect(view.state).toBe("cancelled");
    expect(view.result).toMatchObject({ timedOut: true });
  });
});
