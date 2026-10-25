// Receipt-driven bridge between the HTTP broker and the durable pool executor.
// No provider/SSH operations or retries live here: guest ownership, cleanup,
// sync and admission remain the executor's responsibility.
import type { OffloadExecutor, OffloadCommand } from "../offload.js";
import type { OffloadReadView } from "../offload-journal.js";
import { runOutsideInvocation } from "../proactive.js";
import type {
  BackendCancellation, BackendCommand, OffloadBackend, OffloadBackendHandle, OffloadOutputSink,
} from "./broker.js";

export interface ExecutorPort extends Pick<OffloadExecutor, "readOutput" | "heartbeatCommand" | "cancelCommand"> {
  start(command: OffloadCommand): Promise<OffloadReadView>;
}
export interface ExecutorBackendDeps {
  /** Trusted host binding only. Resolution must not dispatch a command itself.
   * Return null unless a lifecycle-enabled executor with confined sync is installed. */
  resolveExecutor(command: BackendCommand): Promise<ExecutorPort | null>;
  pollIntervalMs?: number;
}

const uncertain = () => Object.assign(new Error("OFFLOAD_EXECUTION_UNKNOWN"), { code: "OFFLOAD_EXECUTION_UNKNOWN" });

function terminal(view: OffloadReadView): BackendCancellation | null {
  if (view.state === "not_started" && view.remoteStarted === false && view.fallbackSafe === true
    && view.result === null && view.events.length === 0 && view.nextCursor === 0) {
    return { state: "not_started", remoteStarted: false, fallbackSafe: true, result: null };
  }
  if ((view.state === "completed" || view.state === "cancelled") && view.remoteStarted === true
    && view.fallbackSafe === false && view.result) {
    return { state: view.state, remoteStarted: true, fallbackSafe: false, result: view.result };
  }
  if (["not_started", "completed", "cancelled", "failed", "unknown"].includes(view.state)) throw uncertain();
  return null;
}

export class ExecutorBackend implements OffloadBackend {
  private readonly pollIntervalMs: number;
  constructor(private readonly deps: ExecutorBackendDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 250;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) throw new Error("Invalid offload poll interval");
  }

  start(input: BackendCommand, sink: OffloadOutputSink): OffloadBackendHandle {
    // No external effect before returning a handle to the broker. Snapshot now:
    // resolving the host binding may await config/workspace metadata.
    const command = structuredClone(input);
    let executor: ExecutorPort | null = null;
    let dispatched = false;
    let sawStart = false;
    let outcome: BackendCancellation | null = null;
    let cancellation: Promise<void> | null = null;
    const cancelGuest = (): Promise<void> => {
      if (!cancellation) cancellation = (async () => {
        if (executor && dispatched) await executor.cancelCommand(command.companyId, command.runId, command.commandId, "broker_cancel");
      })();
      return cancellation;
    };
    const ready = runOutsideInvocation(async () => {
      const resolved = await this.deps.resolveExecutor(command);
      executor = resolved;
      if (!resolved) return null;
      // A rejection from start is ambiguous: admission may have persisted and
      // dispatched before the acknowledgement was lost. Never retry/remint.
      dispatched = true;
      await resolved.start(command);
      return resolved;
    });
    // The output pump outlives the API request. Host state calls must use the
    // plugin's proactive, explicit-company scope, not its expired invocation.
    const done = runOutsideInvocation(async () => {
      try {
        const active = await ready;
        if (!active) {
          sink.failToStart("offload executor is disabled or not installed");
          outcome = { state: "not_started", remoteStarted: false, fallbackSafe: true, result: null };
          return;
        }
        let cursor = 0;
        for (;;) {
          const view = await active.readOutput(command.companyId, command.runId, command.commandId, cursor);
          // `starting` is already a durable may-have-spawned intent, not a
          // never-started receipt. Output is also positive execution evidence.
          if (!sawStart && (view.remoteStarted === true || view.state === "starting"
            || view.state === "syncing_out" || view.events.length > 0)) {
            sawStart = true;
            sink.started();
          }
          for (const event of view.events) {
            if (event.seq !== cursor + 1 || event.seq > view.nextCursor) throw uncertain();
            sink.write(event.stream, Buffer.from(event.dataBase64, "base64"));
            cursor = event.seq;
          }
          if (view.nextCursor !== cursor) throw uncertain();
          // A terminal read can be paginated too. Drain until an empty page so
          // completion never overtakes the tail of stdout/stderr.
          if (view.events.length > 0) continue;
          const result = terminal(view);
          if (result?.state === "not_started" && sawStart) throw uncertain();
          if (result) {
            outcome = result;
            if (result.state === "not_started") sink.failToStart("verified executor never-started receipt");
            else sink.complete(result.result);
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
        }
      } catch {
        if (!dispatched) {
          // Config/binding failed before calling start: no execution effect.
          outcome = { state: "not_started", remoteStarted: false, fallbackSafe: true, result: null };
          sink.failToStart("offload executor binding unavailable");
        } else {
          await cancelGuest().catch(() => undefined);
          sink.fail(uncertain());
        }
      }
    });
    return {
      done,
      heartbeat: async () => {
        await ready;
        if (executor && !outcome) await executor.heartbeatCommand(command.companyId, command.runId, command.commandId);
      },
      cancel: async () => {
        await ready;
        await cancelGuest();
        // A cancel acknowledgement alone is not a settled workspace: sync-in
        // may still read it, or sync-out may still stage returned changes.
        await done;
        if (!outcome) throw uncertain();
        return outcome;
      },
    };
  }
}
