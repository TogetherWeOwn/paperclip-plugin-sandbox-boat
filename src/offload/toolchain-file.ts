// Workspace toolchain pin. rustup honours `rust-toolchain.toml` (or the legacy
// `rust-toolchain`) in the synced source, so a pin the server profile does not
// install would make the guest download a toolchain, or build with a different
// compiler than the host. The nearest file from the run directory
// (cwdRelative) up to the workspace root wins, as with rustup.

import path from "node:path";
import { readProbeFile } from "./probe-file.js";

export type ToolchainPin =
  | { kind: "none" }
  | { kind: "pinned"; channel: string; file: string }
  | { kind: "unreadable"; file: string };

// rustup prefers the legacy name when both exist in one directory.
const FILES = ["rust-toolchain", "rust-toolchain.toml"];
const MAX_BYTES = 16 * 1024;
const CHANNEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The channel a toolchain file pins; `none` when there is no file. The file
 * is repo-controlled, so it is read no-follow with a size cap (probe-file.ts):
 * a symlink, FIFO, device or oversized file is `unreadable`, never opened. */
export async function readToolchainPin(root: string): Promise<ToolchainPin> {
  for (const file of FILES) {
    const probe = await readProbeFile(path.join(root, file), MAX_BYTES);
    if (probe.kind === "missing") continue;
    if (probe.kind === "unreadable") return { kind: "unreadable", file };
    const text = probe.bytes.toString("utf8");
    const channel = parseChannel(text, file);
    return channel === null ? { kind: "unreadable", file } : { kind: "pinned", channel, file };
  }
  return { kind: "none" };
}

function parseChannel(text: string, file: string): string | null {
  // Legacy one-line form: the whole file is the channel name.
  const trimmed = text.trim();
  if (file === "rust-toolchain" && !trimmed.includes("\n") && !trimmed.includes("=") && !trimmed.startsWith("[")) {
    return CHANNEL_RE.test(trimmed) ? trimmed : null;
  }
  // TOML form: `channel = "..."` inside [toolchain]. Anything else (path
  // toolchains, a missing channel) is not a pin the profile can match.
  let section = "";
  let channel: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    if (section !== "toolchain") continue;
    const match = /^channel\s*=\s*["']([^"']*)["']$/.exec(line);
    if (match) channel = match[1]!;
    else if (/^path\s*=/.test(line)) return null;
  }
  return channel !== null && CHANNEL_RE.test(channel) ? channel : null;
}

/** Local reason when the pin is not installed on the profile, else null. */
export function toolchainPinMismatch(pin: ToolchainPin, toolchains: string[]): string | null {
  if (pin.kind === "none") return null;
  if (pin.kind === "unreadable") return `${pin.file} is unreadable or has no plain channel; stays local`;
  if (toolchains.includes(pin.channel)) return null;
  return `${pin.file} pins ${pin.channel}, not installed on the profile`;
}
