# Heavy-command offload shims

The agent and model stay on the Paperclip host; only an eligible heavy command and a frozen, secret-free source snapshot go to a pool VM. Everything is **default OFF**. To turn it on, see [Enabling the executor bridge](operations.md#enabling-the-executor-bridge). Internals: [Offload internals](design/offload-internals.md). For local runs, the snapshot source is admitted only under an operator-listed `offloadLocalSourceRoots` entry with a matching on-disk git origin — see [Local-run offload source authority](security.md#local-run-offload-source-authority).

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
are never synced and keep commands local. Symlinked config is never followed:
a symlinked `pyproject.toml` stays local without reading its target, and
regular `pyproject.toml` files are read bounded at 256 KiB. Only an empty env
travels with Node/Python requests except `VIRTUAL_ENV` for `uv.lock` venv
commands; secret-free env policy, public allow-listed
repositories and cwd/argv confinement apply unchanged.
