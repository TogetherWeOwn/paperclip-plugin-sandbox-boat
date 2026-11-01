import { createHash } from "node:crypto";
import path from "node:path";

// Guest directory layout under the state root, shared by the guest controller
// (command env, cargo priming) and the sync layer (pip installs) so every
// host-side actor points a VM's toolchains at the same places. The guest
// supervisor creates exactly these directories and nothing else.

const key = (parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

/** Fresh HOME per command: shell hooks or wrappers planted under one
 * command's home are never seen by the next command on a reused VM. */
export function guestCommandHome(stateRoot: string, command: { companyId: string; runId: string; commandId: string }): string {
  return path.posix.join(stateRoot,
    `paperclip-boat-home-${key([command.companyId, command.runId, command.commandId])}`);
}

/** Per-VM toolchain cache root, outside HOME. Pool VMs are never shared
 * across trust domains and PATH never includes this tree, so cached crates
 * or user-site packages cannot become a trojan toolchain for another
 * workspace; within one VM they keep cargo/pip caches warm across commands. */
export function guestToolchainRoot(stateRoot: string, sandboxId: string): string {
  return path.posix.join(stateRoot, `paperclip-boat-toolchain-${key([sandboxId])}`);
}

export function guestCargoHome(stateRoot: string, sandboxId: string): string {
  return path.posix.join(guestToolchainRoot(stateRoot, sandboxId), "cargo");
}

export function guestPythonUserBase(stateRoot: string, sandboxId: string): string {
  return path.posix.join(guestToolchainRoot(stateRoot, sandboxId), "python");
}
