# Heavy-command offload shims

The agent and model stay on the Paperclip host; only an eligible heavy command and a frozen snapshot of the workspace's git-tracked files go to a pool VM. Everything is **default OFF**. To turn it on, see [Enabling the executor bridge](operations.md#enabling-the-executor-bridge). Internals: [Offload internals](design/offload-internals.md).

**What leaves the host.** Only files git tracks (the index, `git ls-files
--cached`), minus the sync excludes (caches, build outputs and secret-bearing
names such as `.env*`, `.dev.vars`, `*.pem`, `*.key`, `id_rsa*`, `.aws/`,
`*.tfvars`). Untracked or ignored workspace files never sync, so stage new
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

`rust-public-1` installs toolchains `stable` and `1.98.1` with clippy; a workspace `rust-toolchain.toml`/`rust-toolchain` pinning anything else stays local. Guest build settings come from the server profile, not the host: `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_DEV_DEBUG=0` and `CARGO_PROFILE_TEST_DEBUG=0`, matching two-bot-next's `scripts/cargo_cache.py`. The wrapper's host target, scratch and temp paths never travel; the guest uses its own. Host-service workloads stay local: any command run with a database/cache env set (`*DATABASE_URL`, `*REDIS_URL`, libpq `PG*`, `*TESTDB*`, `*_DB_HOST`; presence only, values never leave the host), and Cargo test runs that include ignored tests, use `--all-features` or enable a profile service feature (`db`). A wrapper that dispatches Cargo through `PATH`, as `cargo_cache.py` does with `shutil.which("cargo")`, reaches the shim when the shim dir leads `PATH`. Local fallback runs the real Cargo once, inside the wrapper's own lease and env, with the shim removed from `PATH` and `BOAT_OFFLOAD_SHIM_ACTIVE=1` so nested `cargo` calls never re-enter it.

Diagnostics never collide with cargo flags:

```sh
boat-offload-cargo --dry-run -- test --locked        # classify, no VM/sync/journal effect
boat-offload-cargo --dry-run --json -- test --locked # versioned envelope on stdout
boat-offload-cargo --json -- test --locked           # run; result envelope on stderr
```

Semantics the shim guarantees: incremental stdout/stderr with exit/signal passthrough (`128+N`); cancel kills the remote process group; a durable never-started receipt falls back locally exactly once; an ambiguous submit reconciles the same command ID for 10 s, then exits 75 with that ID and no replay; staged/conflicting remote outputs exit 74 with an artifact to apply explicitly; submit errors map to 64 (request), 77 (auth) or 75 (unknown/expired). Rollback is `BOAT_OFFLOAD=0`, which restores exactly the pre-existing local path.

## Pool isolation and mirror verification

A pool VM is only ever reused by the execution workspace that first claimed it: the host resolves each submit's trust domain from its (host-fetched) execution workspace, and the pool compatibility key includes it, so code from one workspace — for example an untrusted PR branch — never runs on a VM another workspace later reuses warm or resumed. Commands without a resolvable workspace fail closed to per-workspace isolation in the executor. Repos listed in `offloadEphemeralRepos` go further: every command creates a fresh VM and deletes it at the provider after collect, and an incompatible VM retired from the pool is likewise deleted rather than left as a stopped disk. Each guest command runs with a root-owned-only `PATH` (`/usr/local/bin:/usr/bin:/bin`, plus a uv venv bin when applicable) and a fresh per-command `HOME`, so guest templates must install toolchains under root-owned paths and home-directory state never carries between commands. Toolchain caches (`CARGO_HOME`, and `PYTHONUSERBASE` for python commands) live outside `HOME` in a per-VM directory under the state root: cargo cache priming and pip user-site installs write there and commands read from there, so warm-VM caches survive across commands, but the tree is never on `PATH` and never leaves the VM's trust domain. Cargo configuration is executable state, not cache: the guest supervisor deletes `config.toml`/`config` from the per-VM `CARGO_HOME` before each command and before cache priming (which additionally refuses to run at all when any cargo config it would load names a credential provider), so a wrapper or alias planted by one command cannot ride the cache into the next.

The delta push does not trust the guest-side mirror marker alone: files the delta would skip are hashed on the guest against the host manifest on every push, and any missing or differing file is resent before the command runs, so a tampered mirror (including a poisoned lockfile) is repaired instead of executed or staged back.

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
and record, so the second identical long run can go remote. Recordings come
from completed remote runs (server-side) and from shim-reported local runs
(`POST /offload/report`, agent-authed, bounded samples). Rust keeps its
existing behaviour and is never gated by this setting.

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
`*credentials*.json`). Symlinked config is never followed:
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
