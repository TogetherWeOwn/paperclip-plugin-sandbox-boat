# Multi-toolchain guest template contract

This extends [Delegated guest template](operations.md#delegated-guest-template-required-for-remote-offload), not its authority or safety controls. It defines the image layout and evidence needed before adding `node-public-1` and `python-public-1` to a rollout. **No image, installed version, fresh-boot result or profile qualification is claimed by this document.**

## Versioned, source-free image

Use a new snapshot name for every changed image, for example `<prefix>-mt-<yyyymmdd>-<revision>`. Pool reuse is keyed on that name: reusing an old name could serve a VM with old tools. Record the image's exact versions, artifact provenance and verified checksums alongside its snapshot identity; preserve the previous name for rollback.

Select immutable versions from the target repositories' current lockfiles and toolchain manifests, never install from an unresolved range or `latest`:

| Tool | Requirements to resolve before building |
| - | - |
| Rust | `stable` and `1.99.1`, with clippy, as required by `rust-public-1`. Record which exact stable release was installed. |
| Node | Node 24, at least 24.11.0, with an exact patch and verified distribution checksum. Recheck each target's engine range. |
| Package managers | pnpm 9.15.4 is an observed target pin, not a universal pin. Supply the exact npm/pnpm/yarn versions needed by each admitted lockfile. |
| Playwright | Observed manifests include `1.64.1` and `^1.62.1`. Resolve the actual lockfile versions and supply each matching browser revision and required system libraries. |
| Python | An observed scanner requirement is CPython 3.11, not evidence of a pytest workload. Select an interpreter and pinned pip/uv tooling from a real locked target before qualifying the profile. |
| Transport | `rsync`, Python 3 for the supervisor, and the existing delegated SSH and settle/path units. |

Verify distributions using the publisher's checksums/signatures and retain provenance. Put each downloaded archive in its own new empty directory. Keep installer scripts outside download/extraction directories, and do not run interpreters with an untrusted download directory as their working directory.

Install tools into root-owned prefixes and link their executables into `/usr/local/bin`. The command PATH is `/usr/local/bin:/usr/bin:/bin` (plus a checkout-local uv venv bin for Python when applicable). Audit every directory, executable and resolved symlink target: the SSH user must not be able to replace them, including through group permissions, ACLs or writable ancestor directories. A symlink into the image builder's home is not a root-owned toolchain installation.

## Browser cache and fresh HOME

The server-owned `node-public-1` environment sets exactly:

```text
PLAYWRIGHT_BROWSERS_PATH=/opt/paperclip-boat/ms-playwright
```

It does not copy a host environment variable, accept a caller-selected path, change PATH or reuse the builder's HOME. Rust and Python profiles do not receive this key.

Populate that directory during image construction with the browsers matching every qualified Playwright lockfile. Keep the cache, all its ancestors and browser executable targets root-owned and non-writable by the SSH user. Multiple browser revisions can coexist; do not run a later installer that garbage-collects revisions another qualified target needs. If a build tool needs a different browser cache convention, that tool remains unqualified until its own supported contract is established.

Commands get a fresh per-command HOME. Existing per-VM `CARGO_HOME` and Python `PYTHONUSERBASE` caches remain outside HOME and off PATH; Cargo configuration is scrubbed before use. Do not seed home configuration or depend on `.npmrc`, a corepack home cache, `.rustup`, pip configuration or registry credentials in the image. Dependency preparation remains lockfile-bound and credential-free. A version check alone does not prove a package manager can prepare the real target under this environment.

### Threat model

A repository command is untrusted and can write its workspace, command HOME and allowed per-workspace caches. A browser executable is code: a writable shared browser cache would let one command plant executable state for later commands on the same VM. The image must therefore make this shared path non-writable, just like its toolchain executables. Existing per-workspace VM isolation, pinned SSH, bounded output, cgroup watchdog, TTL funding and secret/source admission remain mandatory. The fixed browser path grants no new provider action, host environment forwarding or cross-workspace cache sharing. Missing browser revisions fail the workload; they do not authorize a host download, credential forwarding or replay.

## Build and fresh-boot qualification

Use the existing authorized template-build path and recorded included-capacity budget. This document does not authorize purchases, wallet top-ups, credential changes, plugin installation or live configuration changes. Keep credentials at the host broker and use `--no-env` for guarded wrapper execution; export only reviewed source-free construction inputs, never a host workspace or cache. Retain auto-stop, a recorded hard cutoff and verified resource cleanup.

1. Resolve the exact version/checksum manifest above before starting the build. Record the construction-input identity and maximum VM-minutes.
2. Preserve every delegation step from the existing Rust runbook: `Delegate=cpu memory pids`, linger, `paperclip-delegated-ssh` and its `ForceCommand`, the sshd settle service and config path/service pair. Install `rsync` and the root-owned toolchains/browser cache.
3. Audit root ownership and write access, including resolved symlinks. In a fresh HOME and the fixed PATH, check actual interpreter/package-manager versions and browser availability. Do not infer qualification from successful installation.
4. Verify the image contains no project checkout, workspace mirror, run journal, command state, build output, host cache, registry credential, SSH private key, run MCP configuration or host/Boat/Paperclip token. Inspect image-local environment/configuration and temporary build inputs before snapshotting. Required platform-managed files are not deleted blindly. Retain an audit receipt without secret values.
5. Reboot hands-off: no manual sshd restart or other repair after boot. Exercise the real delegation preflight with `offloadCgroupParent=/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service`. Only literal `true` passes. A refusal token or a success obtained after manual repair is failure evidence, not qualification.
6. Save under the new snapshot name, then verify a fresh instance from that saved snapshot, not only the construction VM. Record snapshot identity, boot identity, preflight and version/permission checks. Stop/delete temporary instances and verify provider state and billed usage. If using a stopped fork source instead of a named snapshot, retain that source: deleting it invalidates future forks.

## Runtime evidence and rollout gate

Package tests, typechecking, builds and CI gates run in GitHub Actions on the exact head. Do not run a local or Boat full suite or CI mirror. The only local test allowance is focused reproduction of one failing test or crate under the existing guarded-wrapper controls; template construction and bounded acceptance probes are not permission to duplicate CI.

Before enabling a profile or expanding repository admission, retain:

- Passing exact-head Actions and independent QA/Security acceptance for the package.
- The untouched saved-image fresh-boot evidence above.
- Representative Rust, Node/browser and real locked Python focused commands producing remote receipts with boot/cgroup identities, exit status and correct expected output. A canary checks mechanics; an empty Python suite or a scaffold repository does not qualify a production workload.
- The target's exact canonical repository identity, native managed/isolated source roots, lockfile/interpreter/toolchain match and trusted duration-history route. An unknown Node/Python signature may still stay local; this contract does not remove that bootstrap gate.
- Never-started limit refusal/fallback evidence distinct from uncertain execution. Exit 75 is not replay permission; reconcile the same command ID. Exit 74 means staged outputs need explicit review. A local fallback is a coverage exception, not a remote receipt or permission to run forbidden CI.
- Command wall time including boot/upload, provider usage/cost evidence, bounded cleanup, and matched host CPU/RAM measurements. No sustained host-relief claim follows from a version check or a single idle host observation.

Only after each profile qualifies should the authorized operator change the plugin's snapshot/profiles/exact repository and source-root admission and the build-capable agents' native environment/PATH. Do not interrupt live runs or add hooks, host samplers or new schedulers. Retain the existing native telemetry job and reporting routine.

Rollback uses the previous accepted snapshot/profile/configuration and shim package, through the same operator controls. New-image VMs retire through the normal stop/delete reconciliation; never overwrite snapshots in place or replay uncertain commands.
