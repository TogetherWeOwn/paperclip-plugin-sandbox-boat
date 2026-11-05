// A crash between the journal store's index and record writes leaves an index
// entry with no record, and a store blip under finish() leaves a non-terminal
// record whose guest already ran. Both used to wedge the pool after restart:
// recover() threw OFFLOAD_EXECUTION_UNKNOWN on the dangling entry, and the
// lost terminal result had no path back to durable state.
import { describe, expect, it } from "vitest";
import type { OffloadCommand, OffloadResult } from "./offload.js";
import { OffloadJournal, commandKey, type OffloadDurableDeps } from "./offload-journal.js";
import { journalStore } from "./offload-ssh-runtime.js";
import type { StateClientLike } from "./state.js";

type Scope = { scopeKind: "company" | "instance"; scopeId?: string; namespace?: string; stateKey: string };

function memState() {
  const data = new Map<string, unknown>();
  let failSet: ((input: Scope) => boolean) | null = null;
  let failDelete: ((input: Scope) => boolean) | null = null;
  const id = (input: Scope) => JSON.stringify([input.scopeKind, input.scopeId, input.namespace, input.stateKey]);
  const state: StateClientLike = {
    get: async (input) => (data.has(id(input)) ? data.get(id(input)) : null),
    set: async (input, value) => {
      if (failSet?.(input)) { failSet = null; throw new Error("injected store failure"); }
      data.set(id(input), structuredClone(value));
    },
    delete: async (input) => {
      if (failDelete?.(input)) { failDelete = null; throw new Error("injected store failure"); }
      data.delete(id(input));
    },
  };
  return {
    state,
    failNextSet: (predicate: (input: Scope) => boolean) => { failSet = predicate; },
    failNextDelete: (predicate: (input: Scope) => boolean) => { failDelete = predicate; },
  };
}

const companyId = "company-journal-recovery";
const runId = "run-journal-recovery";
const command = (commandId: string): OffloadCommand => ({
  commandId, companyId, runId, cardId: "card-1", repoId: "repo-1", profileId: "v1", argv: ["true"],
});
const completed = (commandId: string): OffloadResult => ({
  status: "completed", commandId, sandboxId: "sandbox-1", warm: "cold",
  queueWaitMs: 0, exitCode: 0, seconds: 1, dollars: 0, remoteStarted: true, fallbackSafe: false,
});

function journalFor(store: ReturnType<typeof journalStore>, now: () => number): OffloadJournal {
  const deps: OffloadDurableDeps = {
    journalStore: store,
    guestReceipts: { read: async () => null },
    resolveRunState: async () => ({ permanentlyTerminal: false, terminatedAt: null, tokenExpiresAt: Number.MAX_SAFE_INTEGER }),
    sync: {
      push: async () => {},
      collect: async () => null,
      stage: async () => {},
      discard: async () => {},
      markSuspect: async () => {},
    },
  };
  return new OffloadJournal(deps, now, { hold: async () => {}, release: async () => {}, cancel: async () => {} });
}

describe("offload journal recovery", () => {
  it("prunes a torn index write on restart and runs a new command", async () => {
    const backing = memState();
    let clock = 1_000;
    const store = journalStore(backing.state, companyId, "pool-torn-put");
    const journal = journalFor(store, () => clock);

    // Crash between the index write and the record write: the admission's
    // record set fails after the index entry landed.
    backing.failNextSet((input) => input.stateKey !== "index");
    await expect(journal.execute(command("cmd-torn"), async () => completed("cmd-torn")))
      .rejects.toThrow("injected store failure");

    const dangling = commandKey(command("cmd-torn"));
    expect(await store.list("command/")).toEqual([dangling]);
    expect(await store.get(dangling)).toBeNull();

    // A restart prunes the dangling entry instead of wedging every submit.
    const restarted = journalFor(store, () => clock);
    await expect(restarted.recover()).resolves.toBeUndefined();
    expect(await store.list("command/")).toEqual([]);

    const result = await restarted.execute(command("cmd-fresh"), async () => completed("cmd-fresh"));
    expect(result.status).toBe("completed");
    await expect(restarted.collectGarbage()).resolves.toBeUndefined();
  });

  it("leaves a torn delete as an invisible orphan and keeps running", async () => {
    const backing = memState();
    let clock = 1_000;
    const store = journalStore(backing.state, companyId, "pool-torn-delete");
    const journal = journalFor(store, () => clock);

    const done = await journal.execute(command("cmd-doomed"), async () => completed("cmd-doomed"));
    expect(done.status).toBe("completed");
    const key = commandKey(command("cmd-doomed"));

    // Crash between the delete's index and record writes: the index entry is
    // gone while the terminal record remains.
    backing.failNextDelete(() => true);
    await expect(store.delete(key)).rejects.toThrow("injected store failure");
    expect(await store.list("command/")).toEqual([]);
    expect(await store.get(key)).not.toBeNull();

    // A restart never lists the orphan, so recovery resolves; the pool accepts
    // new work and retention converges without resurrecting the orphan.
    const restarted = journalFor(store, () => clock);
    await expect(restarted.recover()).resolves.toBeUndefined();
    const fresh = await restarted.execute(command("cmd-after"), async () => completed("cmd-after"));
    expect(fresh.status).toBe("completed");
    await expect(restarted.collectGarbage()).resolves.toBeUndefined();
    expect(await store.list("command/")).toEqual([commandKey(command("cmd-after"))]);
  });

  it("prunes torn entries when sandbox reconciliation scans after startup", async () => {
    const backing = memState();
    const store = journalStore(backing.state, companyId, "pool-torn-reconcile");
    const journal = journalFor(store, () => 1_000);
    await journal.recover();

    for (const scan of [() => journal.hasUnsettled("sandbox-1"), () => journal.settleSandboxUnknown("sandbox-1")]) {
      backing.failNextSet((input) => input.stateKey !== "index");
      await expect(store.set(commandKey(command("cmd-torn-scan")), {})).rejects.toThrow("injected store failure");
      await expect(scan()).resolves.toBeFalsy();
      expect(await store.list("command/")).toEqual([]);
    }
  });

  it("does not overwrite a sandbox's settled unknown with a stashed finish", async () => {
    const backing = memState();
    const store = journalStore(backing.state, companyId, "pool-settled-finish");
    const journal = journalFor(store, () => 1_000);
    const cmd = command("cmd-settled-finish");
    await expect(journal.execute(cmd, async () => {
      await journal.run("sandbox-1", cmd, async () => ({ exitCode: 0, seconds: 1 }));
      backing.failNextSet((input) => input.stateKey !== "index");
      return await journal.finish(cmd, completed(cmd.commandId));
    })).rejects.toThrow("injected store failure");
    expect(await journal.settleSandboxUnknown("sandbox-1")).toBe(1);
    const settled = await journal.readOutput(companyId, runId, cmd.commandId);
    await journal.settlePending();
    expect(await journal.readOutput(companyId, runId, cmd.commandId)).toEqual(settled);
    expect(settled.state).toBe("unknown");
  });

  it("heals a failed finish commit through settlePending", async () => {
    const backing = memState();
    let clock = 1_000;
    const store = journalStore(backing.state, companyId, "pool-lost-finish");
    const journal = journalFor(store, () => clock);
    let failWrites = false;
    backing.failNextSet(() => failWrites);

    const cmd = command("cmd-lost-finish");
    await expect(journal.execute(cmd, async () => {
      failWrites = true;
      try {
        return await journal.finish(cmd, completed(cmd.commandId));
      } finally {
        failWrites = false;
      }
    })).rejects.toThrow("injected store failure");

    // The guest already ran but the durable record is still non-terminal.
    const before = await journal.readOutput(companyId, runId, cmd.commandId);
    expect(before.state).not.toBe("completed");

    // Retention (or the pool sweep) commits the stashed terminal result.
    await journal.settlePending();
    const after = await journal.readOutput(companyId, runId, cmd.commandId);
    expect(after.state).toBe("completed");
    expect(after.result?.exitCode).toBe(0);
  });
});
