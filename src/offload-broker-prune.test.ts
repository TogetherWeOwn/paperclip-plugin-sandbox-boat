import { describe, expect, it } from "vitest";
import {
  OffloadBroker,
  type BackendCommand,
  type OffloadBackend,
  type OffloadBackendHandle,
  type OffloadJournalStore,
  type OffloadOutputSink,
} from "./offload/broker.js";

// Chains are per-key promise tails, not records: a reference store proves they
// drain, and it keeps 10k submits off the O(n^2) retention-index clone path a
// cloning store would pay (that persisted index is sweep-pruned, not leaked).
class RefStore implements OffloadJournalStore {
  readonly data = new Map<string, unknown>();
  async get(key: string): Promise<unknown> { return this.data.has(key) ? this.data.get(key) : null; }
  async set(key: string, value: unknown): Promise<void> { this.data.set(key, value); }
  async delete(key: string): Promise<void> { this.data.delete(key); }
}

// The backend never completes: submit answers 202 at dispatch, so settled
// chain tails must already be gone with every command still running.
class HungBackend implements OffloadBackend {
  starts = 0;
  start(_cmd: BackendCommand, _sink: OffloadOutputSink): OffloadBackendHandle {
    this.starts += 1;
    return { cancel: async () => {}, done: new Promise<void>(() => {}) };
  }
}

const pad = (i: number) => String(i).padStart(12, "0");

describe("broker chain pruning", () => {
  it("10,000 submits leave no settled chain tails behind", async () => {
    const broker = new OffloadBroker({ store: new RefStore(), backend: new HungBackend(), now: () => Date.now() });
    for (let i = 0; i < 10_000; i += 1) {
      const response = await broker.submit({
        version: 1,
        commandId: `00000000-0000-4000-8000-${pad(i)}`,
        executionWorkspaceId: "b9d0e6ac-a14e-4440-a324-7dcdd758be08",
        cwdRelative: ".",
        argv: ["test", "--locked"],
        env: { CARGO_TERM_COLOR: "never" },
        queueTimeoutMs: 30000,
        timeoutMs: 1200000,
        dryRun: false,
      }, {
        companyId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        runId: `11111111-1111-4111-8111-${pad(i)}`,
        cardId: "card-1",
        repoId: "repo-1",
        profileId: "rust-public-1",
      });
      expect(response.status).toBe(202);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect((broker as unknown as { chains: Map<string, unknown> }).chains.size).toBe(0);
  }, 300_000);
});
