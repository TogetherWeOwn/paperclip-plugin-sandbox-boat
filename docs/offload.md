# Heavy-command offload shims

The agent and model stay on the Paperclip host; only an eligible heavy command and a frozen snapshot of the workspace's git-tracked files go to a pool VM. Everything is **default OFF**. To turn it on, see [Enabling the executor bridge](operations.md#enabling-the-executor-bridge). Internals: [Offload internals](design/offload-internals.md). For local runs, the snapshot source is admitted only under an operator-listed `offloadLocalSourceRoots` entry with a matching on-disk git origin — see [Local-run offload source authority](security.md#local-run-offload-source-authority).

**What leaves the host.** Only files git tracks (the index, `git ls-files
--cached`), minus the sync excludes (caches, build outputs and secret-bearing
names such as `.env*`, `.dev.vars`, `*.pem`, `*.key`, `id_rsa*`, `.aws/`,
`*.tfvars`). One exception: a tracked `*.pem` whose contents verify as
certificate-only — one or more X.509 `CERTIFICATE` blocks and nothing else,
re-verified on the frozen bytes at capture — syncs like any other tracked
file, because public CA certificates are fixtures a build may read; any
`.pem` that is a key, mixed, malformed, oversized or a symlink keeps the
command local. Untracked or ignored workspace files never sync, so stage new
files (`git add`) before offloading a command that needs them; submodule
contents are not in the parent index and do not sync. A source that is not a
git work tree (or whose tracked files cannot be listed) stays local. Before
admission, the tracked syncable files go through a bounded scan for known
credential shapes (cloud key ids, private-key headers, provider tokens,
JWTs); any hit keeps the command local, and the push re-checks. That scan is
a heuristic net for well-known token formats, not a proof that a workspace
holds no secrets: only approve repositories whose tracked content may run on
an untrusted VM.

## Cargo offload shim (`bin/boat-offload-cargo`)

Design: [ADR 0001](design/adr/0001-heavy-command-offload.md). Status: routes, broker, shim, executor adapter and concrete SSH guest lifecycle are implemented. Command dispatch is **default OFF**. Without all company and native-binding prerequisites below, each accepted submit journals `not_started` and the shim falls back to the existing bounded local path.

Install the shim as `cargo` ahead of the real executable for opted-in runs (`BOAT_OFFLOAD=1`); anything else, including unset and `0`, runs local cargo with no broker calls. Eligible subcommands are `build`, `test`, `check`, `clippy`, `nextest run` and `llvm-cov` compilation/test modes on an installed profile toolchain. Everything else (`fmt`, `add`, `update`, `metadata`, help/version, install, custom aliases, `--config`/`-Z`, path-bearing options such as `--manifest-path`/`--target-dir`, compound shell text, `RUSTFLAGS` builds) stays local. Only an explicit nonsecret env (`CARGO_TERM_COLOR`, `RUST_BACKTRACE`) reaches the request; the run token travels in HTTP headers only.

`rust-public-1` installs toolchains `stable` and `1.99.1` with clippy; a workspace `rust-toolchain.toml`/`rust-toolchain` pinning anything else stays local. Guest build settings come from the server profile, not the host: `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_DEV_DEBUG=0` and `CARGO_PROFILE_TEST_DEBUG=0`, matching two-bot-next's `scripts/cargo_cache.py`. The wrapper's host target, scratch and temp paths never travel; the guest uses its own. Host-service workloads stay local: any command run with a database/cache env set (`*DATABASE_URL`, `*REDIS_URL`, libpq `PG*`, `*TESTDB*`, `*_DB_HOST`; presence only, values never leave the host), and Cargo test runs that include ignored tests, use `--all-features` or enable a profile service feature (`db`). A wrapper that dispatches Cargo through `PATH`, as `cargo_cache.py` does with `shutil.which("cargo")`, reaches the shim when the shim dir leads `PATH`. Local fallback runs the real Cargo once, inside the wrapper's own lease and env, with the shim removed from `PATH` and `BOAT_OFFLOAD_SHIM_ACTIVE=1` so nested `cargo` calls never re-enter it.

Diagnostics never collide with cargo flags:

```sh
boat-offload-cargo --dry-run -- test --locked        # classify, no VM/sync/journal effect
boat-offload-cargo --dry-run --json -- test --locked # versioned envelope on stdout
boat-offload-cargo --json -- test --locked           # run; result envelope on stderr
```

Dry-run applies every executor gate checkable without starting a VM (config, binding, profile, allowlist, tracked-file secret scan), so a `remote_candidate` answer predicts what the identical real invocation will do, up to capacity and start-time conditions; a gate refusal answers `local` with that gate's reason.

Semantics the shim guarantees: incremental stdout/stderr with exit/signal passthrough (`128+N`); cancel kills the remote process group; a durable never-started receipt falls back locally exactly once; any command classified remote that ends up running locally prints one stderr line naming the pre-start refusal reason (`offload: running local (<reason>)`) — a classified-remote command never falls back silently, while commands classified local from the start print nothing extra; an ambiguous submit reconciles the same command ID for 10 s, then exits 75 with that ID and no replay; staged/conflicting remote outputs exit 74 with an artifact to apply explicitly; submit errors map to 64 (request), 77 (auth) or 75 (unknown/expired). Rollback is `BOAT_OFFLOAD=0`, which restores exactly the pre-existing local path.

## Pool isolation and mirror verification

A pool VM is only ever reused by the execution workspace that first claimed it: the host resolves each submit's trust domain from its (host-fetched) execution workspace, and the pool compatibility key includes it, so code from one workspace — for example an untrusted PR branch — never runs on a VM another workspace later reuses warm or resumed. Commands without a resolvable workspace fail closed to per-workspace isolation in the executor. Repos listed in `offloadEphemeralRepos` go further: every command creates a fresh VM and deletes it at the provider after collect, and an incompatible VM retired from the pool is likewise deleted rather than left as a stopped disk. Each guest command runs with a root-owned-only `PATH` (`/usr/local/bin:/usr/bin:/bin`, plus a uv venv bin when applicable) and a fresh per-command `HOME`, so guest templates must install toolchains under root-owned paths and home-directory state never carries between commands. Toolchain caches (`CARGO_HOME`, and `PYTHONUSERBASE` for python commands) live outside `HOME` in a per-VM directory under the state root: cargo cache priming and pip user-site installs write there and commands read from there, so warm-VM caches survive across commands, but the tree is never on `PATH` and never leaves the VM's trust domain. Cargo configuration is executable state, not cache: the guest supervisor deletes `config.toml`/`config` from the per-VM `CARGO_HOME` before each command and before cache priming (which additionally refuses to run at all when any cargo config it would load names a credential provider), so a wrapper or alias planted by one command cannot ride the cache into the next.

Pool identity also includes a KDF digest of the API credential (the digest is persisted inside the pool id, never the key). A run's binding captures its credential at bind time, so rotating or re-pointing the key takes effect for the next binding that presents the new key — the next run or workspace realization, or the first bind after a worker restart — without any pool surgery: that resolve builds a pool bound to the new credential, and the superseded pool is swept under the old credential and retired, with its journal retained for the normal retired-pool retention instead of being orphaned. A run that is already bound keeps its bind-time credential until it ends, and its pool is never handed to a new-credential binding; to cut a compromised key off immediately, also end live runs or restart the worker.

The delta push does not trust the guest-side mirror marker alone: files the delta would skip are hashed on the guest against the host manifest on every push, and any missing or differing file is resent before the command runs, so a tampered mirror (including a poisoned lockfile) is repaired instead of executed or staged back.

A released pool VM also releases its SSH session: a confirmed idle stop, retirement, quarantine, or failed pending delete closes and forgets that VM's cached control session (a next command re-opens on demand), and runtime shutdown closes any sessions left cached. Session cleanup never loses a stop receipt: hook failures are logged and swallowed.

Collect compares the mirror against both the uploaded manifest and the previous command's host-kept post-collect guest scan: guest-only output a previous command already reported (test caches, reports, generated files outside the return set) is not staged again, and a guest-only unsupported create never turns a successful remote exit into 74 or keeps an artifact on its own — it is listed as unsupported in the result instead. Files the host uploaded are always compared against the baseline (push restores them before every command), so a repeated edit or delete of an uploaded file stages on every command that makes it. Common tool caches (`.hypothesis/`, `.mypy_cache/`, `.ruff_cache/`, `.tox/`, `.nox/`, `test-results/`, `playwright-report/`, `*.egg-info/`, `*.profraw`) are sync-excluded outright. FIFOs, sockets and devices in the mirror are recorded as metadata-only special files and files past the 256 MiB scan hash budget as unhashed; hitting the scan entry or serialized-size limit truncates the scan, and a truncated scan never stages deletions for files it did not reach — none of these make collect throw. When collect still fails deterministically on guest mirror content after the transport returned an exit, the command completes with its real exit code and a `truncated` sync-back (no artifact, no replay), the VM is released normally, and the mirror is wiped and fully resynced on the next push; transport failures during collect keep the held-for-reconciliation path. Retained artifact directories are swept by age; the count cap only evicts artifacts older than the one-day result-retention window, oldest first, so an artifact a retained result can still name is never deleted early.

Pool creates carry the reservation id as the `Idempotency-Key`, so a create whose reply is lost never bills a second VM: the next claim replays the same key and adopts the replayed VM when it is compatible, or stops it and frees the slot when another trust domain retries first. The replay resends the exact persisted create body (type, ttl, monitoring, failFast, noEnv, fork source), because the provider refuses a same-key retry with a different body; a refusal that proves nothing about the lost VM (409/422/429/503 and transport errors) keeps the placeholder quarantined for the next claim instead of retiring it. Adoption funds the adopting command warm — the live VM already holds its provider active slot, so no second active/start charge is admitted — extends the provider TTL whenever the remaining provider life cannot cover the adopter's funded envelope (the deadline runs from the original create, not the replay, so a delayed replay renews even for a shorter adopter; the replay response's archiveAfter is the verified remaining deadline when present), renews the original hold through a granted extension before receipting the adopter, and releases the original hold only after the adopter is receipted and the pool write is durable; a failed receipt, TTL extension, or pool write fails the new hold and keeps the placeholder quarantined for the next same-key replay.

## Node and Python offload (`bin/boat-offload-node`, `bin/boat-offload-python`)

Rust offload above extends to long Node and Python commands on two more server
profiles: `node-public-1` (npm/pnpm/yarn scripts and test binaries such as
`vitest run`, `jest`, `playwright test`, `next build`) and `python-public-1`
(`pytest` and `python -m pytest|unittest` suites). Install the shim as
`npm`/`pytest`/etc. ahead of the real executable for opted-in runs
(`BOAT_OFFLOAD=1`); anything else runs locally. Diagnostics work the same:
`boat-offload-node --dry-run -- run test`. Only profile `rust-public-1` is
enabled by default; add profiles explicitly:

```json
{
  "offloadProfiles": ["rust-public-1", "node-public-1", "python-public-1"]
}
```

Only LONG commands go remote. The plugin keeps per company + repository +
profile + normalized-command-signature duration history (last 20 runs,
30-day TTL) in its existing company-scoped state. A Node/Python command is a
remote candidate only when its recorded median meets
`offloadMinExpectedSeconds` (default 120); unknown signatures run local first
and record, so the second identical long run can go remote. The gate learns
host-measured wall time only: a completed remote run records the host-side
elapsed interval (the guest-reported value can only shorten it, never
lengthen it), and every sample is clamped to one day. Recordings come from
completed remote runs (server-side) and from shim-reported local runs
(`POST /offload/report`, agent-authed, bounded samples). For an otherwise-local
run with no prior offload binding, the plugin captures a credential-free source
snapshot once on `agent.run.started`, while the host's issue/run association and
workspace selection agree before and after lookup. The snapshot pins the source
path, repository and execution/project workspace IDs for that company and run.
Reports revalidate that source, never select a new source from the issue's mutable
current workspace. A later move to another checkout (even one sharing the project
alias) cannot train that other repository; the original primary ID and alias still
name only the captured source. A rewritten execution workspace row is refused.
This requires `offloadLocalRunsEnabled` and a source under
`offloadLocalSourceRoots` whose on-disk origin matches the workspace repository,
both at capture and report time. It does not require an environment, credential,
admission grant, executor flag or guest-transport flag. Missing source/run facts,
lookup failure or preparation after the start event leaves reporting unavailable
for that run; duplicate starts cannot replace the snapshot. Capture requires a
previously unobserved run and a trusted event timestamp strictly after this worker
started and no later than capture time. Missing, invalid, equal-millisecond, old
or future timestamps refuse learning. This freshness fence also prevents a start
replayed after restart from reconstructing source from the current issue, even
when the original ownership write failed or terminal cleanup removed it. Terminal
events discard snapshots and fence in-flight lookups.
The metadata serves only telemetry: it is never registered for dispatch,
resolves no secret, and adds no persistent company-upkeep enrollment. Existing
report-host construction still caches a company broker; unscoped sweeps include
cached-broker companies for upkeep. Report-only metadata resolution does not
isolate requests from that preexisting behavior. Explicitly withdrawn workspace
aliases and invalid registered bindings remain refused, without falling back to
current issue metadata. Fresh real submits and dry-runs still need their existing
exact-run admission; retained
receipt handling is unchanged. With local runs disabled, an unbound local run
cannot report. Reports for
local-mode signatures (watch mode, single-file filters, inline code,
unrecognized scripts) are refused before any state write, and each run is
rate-limited (a short burst, then one report per second, 200 per run); excess
samples are dropped. History keeps the last 20 runs per signature with a
30-day TTL, and at most 500 signature keys per company scope (shared across
repos): evicted
and expired keys are deleted during the pool sweep, so unique-argv report
loops cannot grow plugin state without bound. Guest-reported exit facts are
untrusted input: only an integer exit code 0..255 with finite non-negative
seconds is accepted, `cancelled`/`timedOut` come from host state only, and
anything else ends the command `unknown` instead of entering the journal or
the account ledger. Heartbeats renew interest with a duration, never an
absolute timestamp, so a skewed guest clock can neither fail renewals nor
refuse prepare. Rust keeps its existing behaviour and is never gated by this
setting.

Short commands must stay local: sync plus VM overhead (~30 s) makes anything
shorter slower remotely. Watch modes, single-file filters, lint/typecheck/
format, install/ci, dev servers, inline `python -c`, deploy/publish/release-like
scripts (any name containing deploy, publish, release, push, upload, prod or
ship) and anything unrecognized stay local. Only exact `build` plus an
allowlisted build suffix stays remote. Frozen source sync excludes `node_modules`, `.venv`/`venv`,
caches and build outputs; the guest installs dependencies from the lockfile
(`npm ci`, `pnpm/yarn --frozen-lockfile`, `uv sync --frozen`, hash-pinned
`requirements.txt` via `pip install --require-hashes -r`, where every
requirement is `name[extras]==version` with `--hash=sha256:` and no pip
option lines) into a per-VM cache keyed by lockfile hash. Global pip installs reuse the cache across runs;
checkout-local installs (`node_modules`, `.venv`) live in the per-card mirror
and run again only when the lockfile hash changes, the mirror was wiped or
lost, or the previous install failed, so a warm mirror never reuses a stale
checkout. Python commands from a `uv.lock` plan
run from the checkout `.venv` interpreter (`.venv/bin/<runner>`) with
`VIRTUAL_ENV=<checkout>/.venv` and `<checkout>/.venv/bin` prepended to the
guest `PATH` for that command only (every other env key stays empty), so
console scripts and bare `python` subprocesses cannot resolve the system
interpreter. No lockfile
(or competing lockfiles for the same tool) means the command stays local: the
plugin never installs from an unlocked manifest, and an unpinned
`requirements.txt` stays local.
Package lockfiles at the repo root are return-eligible like `Cargo.lock`.
Registry credential files (`.npmrc`, `.yarnrc*`, `.pypirc`, `pip.conf`,
`.netrc`) at any depth, plus `uv.toml` and `pyproject.toml` uv auth config,
are never synced and keep commands local; the same holds for secret-bearing
names and credential directories (`.dev.vars`, `.envrc`, `*.pem`, `*.key`,
`id_rsa*`, `.git-credentials`, `.aws/`, `.docker/`, `.kube/`, `*.tfvars`,
`*credentials*.json`) — except a tracked `*.pem` verified certificate-only,
as described under "What leaves the host". Symlinked config is never followed:
a symlinked `pyproject.toml` stays local without reading its target, and
regular `pyproject.toml` files are read bounded at 256 KiB. The same rule
covers every host-side workspace probe: toolchain pins (`rust-toolchain*`,
bounded at 16 KiB) and lockfiles (bounded at 32 MiB) are opened no-follow and
must be regular files under real directories — a symlink, FIFO, device,
oversized file or symlinked run directory is unreadable and the command stays
local, so a hostile checkout cannot make the worker buffer or block on
host files outside the workspace. Only an empty env
travels with Node/Python requests except `VIRTUAL_ENV` for `uv.lock` venv
commands; secret-free env policy, public allow-listed
repositories and cwd/argv confinement apply unchanged.
