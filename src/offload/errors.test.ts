import { describe, expect, it } from "vitest";
import { exitForError, exitForTerminal, offloadError } from "./errors.js";
import type { OffloadTerminalResult } from "./protocol.js";

const CMD = "7d82278c-2ba7-4e68-96ab-a2cc10b697af";

function terminal(over: Partial<OffloadTerminalResult>): OffloadTerminalResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    syncBack: { state: "clean", changedPaths: [], conflictPaths: [], artifactId: null },
    usageRecordId: null,
    ...over,
  };
}

describe("offloadError", () => {
  it("builds the RFC-9457 envelope", () => {
    const envelope = offloadError("OFFLOAD_INVALID_REQUEST", "bad argv", { commandId: CMD });
    expect(envelope).toMatchObject({
      type: "https://boat.offload/errors/v1",
      status: 400,
      code: "OFFLOAD_INVALID_REQUEST",
      detail: "bad argv",
      commandId: CMD,
    });
    expect(envelope.title.length).toBeGreaterThan(0);
    expect(envelope.next_action.length).toBeGreaterThan(0);
  });

  it("maps each code to its HTTP status", () => {
    expect(offloadError("OFFLOAD_UNAVAILABLE", "x", {}).status).toBe(503);
    expect(offloadError("OFFLOAD_UNAUTHORIZED", "x", {}).status).toBe(401);
    expect(offloadError("OFFLOAD_FORBIDDEN", "x", {}).status).toBe(403);
    expect(offloadError("OFFLOAD_IDEMPOTENCY_CONFLICT", "x", {}).status).toBe(409);
    expect(offloadError("OFFLOAD_SYNC_STAGED", "x", {}).status).toBe(409);
    expect(offloadError("OFFLOAD_RESULT_EXPIRED", "x", {}).status).toBe(410);
    expect(offloadError("OFFLOAD_OUTPUT_LIMIT", "x", {}).status).toBe(413);
  });

  it("marks only the 503s retryable", () => {
    expect(offloadError("OFFLOAD_UNAVAILABLE", "x", {}).retryable).toBe(true);
    expect(offloadError("OFFLOAD_EXECUTION_UNKNOWN", "x", {}).retryable).toBe(true);
    expect(offloadError("OFFLOAD_INVALID_REQUEST", "x", {}).retryable).toBe(false);
    expect(offloadError("OFFLOAD_SYNC_STAGED", "x", {}).retryable).toBe(false);
  });
});

describe("exitForError", () => {
  it("falls back locally only on a durable never-started receipt", () => {
    expect(exitForError(offloadError("OFFLOAD_UNAVAILABLE", "x", { remoteStarted: false, fallbackSafe: true })).action).toBe("fallback");
    expect(exitForError(offloadError("OFFLOAD_UNAVAILABLE", "x", { remoteStarted: false, fallbackSafe: false }))).toMatchObject({
      action: "exit",
      code: 75,
    });
    expect(exitForError(offloadError("OFFLOAD_UNAVAILABLE", "x", { remoteStarted: null, fallbackSafe: false }))).toMatchObject({
      action: "exit",
      code: 75,
    });
  });

  it("maps client errors to 64 and auth to 77", () => {
    expect(exitForError(offloadError("OFFLOAD_INVALID_REQUEST", "x", {}))).toMatchObject({ action: "exit", code: 64 });
    expect(exitForError(offloadError("OFFLOAD_IDEMPOTENCY_CONFLICT", "x", {}))).toMatchObject({ action: "exit", code: 64 });
    expect(exitForError(offloadError("OFFLOAD_UNAUTHORIZED", "x", {}))).toMatchObject({ action: "exit", code: 77 });
    expect(exitForError(offloadError("OFFLOAD_FORBIDDEN", "x", {}))).toMatchObject({ action: "exit", code: 77 });
  });

  it("maps uncertainty to 75 and output limits to 74", () => {
    expect(exitForError(offloadError("OFFLOAD_EXECUTION_UNKNOWN", "x", {}))).toMatchObject({ action: "exit", code: 75 });
    expect(exitForError(offloadError("OFFLOAD_RESULT_EXPIRED", "x", {}))).toMatchObject({ action: "exit", code: 75 });
    expect(exitForError(offloadError("OFFLOAD_OUTPUT_LIMIT", "x", {}))).toMatchObject({ action: "exit", code: 74 });
  });
});

describe("exitForTerminal", () => {
  it("passes a clean success through as 0", () => {
    expect(exitForTerminal(terminal({}))).toBe(0);
  });

  it("preserves a nonzero cargo exit", () => {
    expect(exitForTerminal(terminal({ exitCode: 101 }))).toBe(101);
  });

  it("maps a remote signal to 128+N", () => {
    expect(exitForTerminal(terminal({ exitCode: 0, signal: 9 }))).toBe(137);
    expect(exitForTerminal(terminal({ exitCode: 0, signal: 15 }))).toBe(143);
  });

  it("maps staged/conflict success to 74", () => {
    const staged = terminal({ syncBack: { state: "staged", changedPaths: ["Cargo.lock"], conflictPaths: [], artifactId: "a1" } });
    expect(exitForTerminal(staged)).toBe(74);
    const conflict = terminal({ syncBack: { state: "conflict", changedPaths: [], conflictPaths: ["x"], artifactId: "a2" } });
    expect(exitForTerminal(conflict)).toBe(74);
  });

  it("preserves a nonzero exit even with a staged artifact", () => {
    const failed = terminal({
      exitCode: 101,
      syncBack: { state: "staged", changedPaths: ["Cargo.lock"], conflictPaths: [], artifactId: "a1" },
    });
    expect(exitForTerminal(failed)).toBe(101);
  });

  it("preserves a signal even with a staged artifact", () => {
    const killed = terminal({
      exitCode: 0,
      signal: 9,
      syncBack: { state: "staged", changedPaths: ["Cargo.lock"], conflictPaths: [], artifactId: "a1" },
    });
    expect(exitForTerminal(killed)).toBe(137);
  });
});
