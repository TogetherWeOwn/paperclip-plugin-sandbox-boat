# paperclip-plugin-sandbox-boat

A [Paperclip](https://github.com/paperclipai/paperclip) sandbox-provider plugin that runs agent work on [boat.dev](https://boat.dev) VMs. A VM exists for one card and runs only while a run on that card needs it.

It started as a copy of Paperclip's bundled `exe-dev` provider. All boat calls go through the official TypeScript SDK, [`@boatdev/sdk`](https://docs.boat.dev/sdks/typescript) (pinned to 1.10.0). There is no hand-written REST client.

## What it does

| Paperclip hook | boat action |
| - | - |
| AcquireLease | The card already has a VM: resume it if it is stopped, or share it if it is running. Otherwise create a VM, from `templateSnapshot` when that is set. Every start passes the budget guard first and uses fail-fast. |
| Execute | SSH as boat's non-root `user`, with the host key pinned from `POST /sandboxes/{id}/sshkey`. Only the run env keys the [env allowlist](#run-env-allowlist) names reach the VM; the rest is dropped and logged by name. The kept env goes over stdin into a 0600 file in a fresh 0700 directory under `/tmp`, never in argv. The command script sources the file, removes it, clears boat's `ASCII_TOKEN` and `BOAT_ID`, and only then `exec`s the command; the login shell `exec`s too, so no shell started with those tokens stays alive as the command's parent. A reverse tunnel makes `127.0.0.1:8317` inside the VM reach the model proxy. |
| ReleaseLease | Remove [Paperclip's run MCP config](#the-run-mcp-config-exception) from the VM, then stop the VM at once, which stops billing. A VM keyed to a single run has nothing worth keeping, so it is deleted instead. A VM that another run on the card still uses stays up, untouched, until the last release. |
| (reuse) | The driver declares `sandboxCapabilities.reusableLeases`. With `reuseLease: true` and `runnerLifecycleMode: "per_turn"` on the environment, Paperclip stops the card's VM after each run and resumes it for the card's next run, so the checkout and build output stay on its disk. Without reuse, Paperclip destroys the VM after every run (DestroyLease) and the next run starts a fresh one from `templateSnapshot`. Never set `runnerLifecycleMode: "warm"`: it keeps the VM running between runs. |
| StopLease | Remove the run MCP config, stop the VM, keep its disk, and confirm the stop or throw. |
| DestroyLease | Remove the run MCP config (in case the delete fails), delete the VM and forget the card mapping. |
| ResumeLease | Resume the lease's VM, or report the lease expired. |
| RealizeWorkspace | `mkdir -p` the workspace inside the VM (`$HOME/paperclip-workspace` by default). |
| Probe | Read `GET /limits`, check the `ssh` client and the tunnel target. It never starts a VM. |
| CaptureTemplate / DeleteTemplate | Save or delete a boat named snapshot. Capture refuses to go past the 10 free snapshots unless `allowPaidNamedSnapshots` is set. Before the save it removes the run MCP config and refuses the capture (`BOAT_RUNTIME_SCRUB_FAILED`) when it cannot verify that; a stopped VM is resumed for that, budget-guarded. |

### Cost rules

* **One VM per card.** The key is the execution workspace, else the issue, else the run. The mapping lives in plugin state and in the VM's name, `<namePrefix>-<16 hex>`, so a lost state does not lose the VM. The checkout and build dirs stay on the stopped disk. boat keeps a stopped disk free for 14 days.
* **Stop on release.** Billing stops at the stop ([docs](https://docs.boat.dev/snapshots/stop)). In our trial a resume within 10 minutes of a stop got the same machine back and did not count as a start.
* **One lock per card.** Acquire, release, destroy and the sweep's stop take the same per-card lock, so a new run never reads the VM as running while the previous run's release stops it. A new run that finds the VM still stopping (`archiving`) waits up to `stopConfirmTimeoutMs` for the save to end, then resumes it, or fails with `BOAT_STOP_PENDING` without starting anything.
* **Auto-stop is a deadline, not idle detection.** It counts from the start or resume ([docs](https://docs.boat.dev/long-running-tasks/auto-stop)). The plugin sets it to `autoStopMinutes` (120, the trial maximum) as a safety net. It extends the deadline only while a command is running and less than half of it is left. An idle VM is never extended.
* **Idle sweep, every 5 minutes.** It runs outside any host request (`src/proactive.ts`), because the host refuses plugin state in a scheduled job's company-less request and in a request that already ended. A VM with no active run is stopped after `idleStopMinutes` (15) idle. A VM whose lease is held but sent no command for `staleLeaseMinutes` (60) is stopped too. Before each of these stops the sweep removes the run MCP config, the same as release, opening an SSH session when this worker has none. A stopped VM is deleted when its card is done or cancelled, or after `deleteAfterDays` (7) untouched. The sweep only touches sandboxes named with our prefix.
* **Budget guard.** Before every create or resume, the plugin reads `GET /limits` once. It refuses the start, fast and with a clear error, when any of these is true:
  * `maxActive` (2) VMs already run;
  * `maxStartsPerDay` (70) starts happened in the last 24 hours;
  * boat's hour or minute start window is full;
  * fewer than `minComputeHoursLeft` (1.0) compute hours are left;
  * the size is not allowed on the plan.

  A warning log line names the limit. If the limits cannot be read, nothing is started.
* **Fail-fast starts.** A start that finds no ready machine gets `503 no_ready_machine` at once. Nothing is started or billed. The plugin retries twice, 5 s apart, then fails with `BOAT_NO_READY_MACHINE`.
* **Retries never double-bill.** Creates send an `Idempotency-Key`. boat documents the key for create and fork only, and the SDK has no key for resume. A resume retry therefore checks the VM state first and treats `sandbox_resuming` as done.

### Usage accounting

* For each run, the plugin records the boat sandbox id, the size, the start kind (create, resume or shared) and the start and stop times.
* At release it reads boat's own meter, `GET /sandboxes/{id}/usage`, for that run's window and for the VM's lifetime.
* `GET /api/plugins/<pluginId>/api/usage?companyId=<id>` (board auth) returns:
  * totals;
  * per card;
  * per VM;
  * per run, in seconds and dollars;
  * the last budget snapshot.
* `refresh=0` skips the live re-read. By default, run windows read right at a stop are read again, because the meter can lag.
* `POST .../api/sweep` runs the sweep now.

### Security

* VMs are created with `noEnv: true` and `monitoring: false`. Use a boat environment marked *safe for third parties*.
* **Default-deny run env.** Paperclip passes a sandbox provider the whole run env, with every secret resolved, and filters nothing for sandboxes. The plugin sends the VM only what the [env allowlist](#run-env-allowlist) names and drops the rest.
* The VM gets nothing of the account except boat's own `BOAT_ID` and `ASCII_TOKEN` (see [boat account settings](#boat-account-settings)). The plugin removes both from every command's environment, `exec`s the command so no parent shell keeps them in its `/proc/<pid>/environ`, and deletes the `export ASCII_TOKEN=...` line from `~/.bashrc`, so the agent cannot casually publish a port on a public URL.
* Besides the allowlisted run env, one more secret reaches the VM, as a file that Paperclip writes itself: the [run MCP config](#the-run-mcp-config-exception) with the run JWT. The plugin cannot keep it out; it deletes it before every stop, delete and template capture.
* The staged env file never sits in the workspace (the git checkout), so `git add -A` cannot commit it. It sits under `/tmp`, which boat snapshots do not save ([What a snapshot saves](https://docs.boat.dev/snapshots/whats-saved)), and it is gone before the command starts. If ssh drops before the script runs, the plugin removes it itself.
* An ephemeral ed25519 key is made per worker process with `ssh-keygen`. It is never stored.
* The host key comes from the API, and SSH uses `StrictHostKeyChecking=yes` with `HostKeyAlias=<sandbox id>`.
* The tunnel binds to `127.0.0.1` inside the VM only. Nothing is published.

### The run MCP config exception

The env allowlist covers the run env only. Paperclip also syncs files into the VM, and one of them holds a credential: claude_local writes the run's MCP config, `{"mcpServers": {...: {"headers": {"Authorization": "Bearer <token>"}}}}`, where the "Paperclip projects" server carries the **run JWT**. That JWT is valid for up to 48 hours and the Paperclip API that accepts it is reachable from the internet. Paperclip syncs the file as the `mcp-config` runtime asset to `<remoteCwd>/.paperclip-runtime/<adapter>/mcp-config/mcp-config.json`, under `/home/user`, which boat saves in every snapshot, and never removes it (tog.22: server `heartbeat.ts` ~25853; claude-local `claude-config.ts` ~175 and `execute.ts` ~658-713; adapter-utils `sandbox-managed-runtime.ts` ~1531 and ~1690).

So before every stop (release, StopLease, the idle sweep, and a failed start), every delete (DestroyLease, release of a per-run VM) and every template capture, the plugin deletes, over SSH:

* `<root>/.paperclip-runtime/*/mcp-config` and `<root>/.paperclip-runtime/*/mcp-config-upload.tar*` (the upload tarball and its partial-upload files), for every workspace root it knows of: the lease's `remoteCwd`, the roots it set up or realized on that VM (kept in plugin state, so another worker knows them too), `remoteWorkspaceDir` and `$HOME/paperclip-workspace`;
* the same paths anywhere under `$HOME`, 6 levels deep, skipping `node_modules`, `.git` and `target`.

It then looks again and logs the result. Nothing else is removed: the checkout, `skills`, `config` and the bridge stay. Each match goes to `rm` as one argument and is never read back as a line of text, so a name with a newline in it (from repo content or an agent) cannot add delete targets. When the cleanup fails, a stop still goes ahead (a running VM bills and keeps the token live) with an error log; a template capture is refused instead. A VM that a second run on the same card still uses is left alone until the last release.

What this does not cover: while a run holds the VM the file is on its disk, so boat's rolling per-minute snapshot can contain it; a VM that boat's auto-stop stops (the plugin was not called) keeps it on its stopped disk until a later release, sweep or capture of that VM removes it. The real fix belongs in Paperclip: give sandbox MCP servers a bridge-scoped, short-lived token instead of the host run JWT.

## Configuration

Set these on the Paperclip sandbox environment, driver `boat`. Only `apiKey` is required.

| Key | Default | Notes |
| - | - | - |
| `apiKey` | - | A boat key with the `ci` preset: `boat api-key create <name> --preset ci --ttl 30d`. Falls back to `BOAT_API_KEY` on the host. |
| `size` | `default` | `small` costs $0.018/h and `default` $0.036/h. The trial allows only these two. |
| `templateSnapshot` | none | A named snapshot to create new card VMs from. |
| `autoStopMinutes` | 120 | The trial allows at most 120. |
| `idleStopMinutes` | 15 | |
| `staleLeaseMinutes` | 60 | |
| `deleteAfterDays` | 7 | 1 to 13. |
| `maxActive` / `maxStartsPerDay` / `minComputeHoursLeft` | 2 / 70 / 1.0 | Matches the trial: 2 at once, 75 starts a day, 25 h. |
| `failFast` / `noReadyMachineRetries` | true / 2 | |
| `cliproxyTunnel` | true | |
| `tunnelRemotePort` | 8317 | |
| `tunnelTargetHost` | `127.0.0.1` | **Inside the Paperclip container, set this to `cliproxy`**: the container's 127.0.0.1 is not the CLIProxy. |
| `tunnelTargetPort` | 8317 | |
| `envAllowlist` | built-in list | Run env names that may reach the VM. See [Run env allowlist](#run-env-allowlist). A list you set replaces the built-in one; an empty list (`[]`) sends nothing. |
| `noEnv` | true | |
| `boatEnvironment` | account default | |
| `remoteWorkspaceDir` | `$HOME/paperclip-workspace` | |
| `namePrefix` | `paperclip` | |
| `costApiKey` | main key | An optional read-only key for usage reads. |
| `timeoutMs` / `stopConfirmTimeoutMs` / `sshConnectTimeoutSec` | 300000 / 120000 / 15 | |

## Run env allowlist

### Why

On 2026-10-22 the first pilot run on a boat VM (TOG-37420) received the TWO Bot Next project env, including four PlanetScale production secret references, which Paperclip resolves to their values before a run starts. Paperclip merges project, routine and environment env into every run and filters nothing for a sandbox, and plugin versions before 0.2.0 sent every string entry to the VM. The claude-local adapter also passes `{ ...process.env, ...env }` (the Paperclip server's own environment) to the command-resolution probe it runs in the sandbox. Since 0.2.0 no run env key reaches a VM unless an allowlist names it. That covers env only: the run JWT still reaches the VM in a file Paperclip writes, which the plugin deletes before the VM is saved (see [The run MCP config exception](#the-run-mcp-config-exception)).

### Rules

For each `NAME=value` that Paperclip passes to Execute:

1. The name must match the allowlist: an exact `NAME`, or a `NAME_*` prefix. Anything else is dropped.
2. These are never sent, even when the allowlist names them exactly:
   * names starting with `PLANETSCALE_`, `CLOUDFLARE_`, `CF_`, `DISCORD_`, `GH_`, `GITHUB_`, `BOAT_` or `ASCII_`;
   * a value with a JWT anywhere in it (`eyJ...` header, `.`, `eyJ...` payload, `.`), bare, behind `Bearer `, or inside JSON or a header, for example Paperclip's run token (`PAPERCLIP_API_KEY` before the sandbox bridge starts);
   * a database URL, or any URL with a password, that points off the VM. A URL on the VM itself (loopback, or a one-label host such as a container on the VM) is allowed only by an exact entry. A `..._DATABASE_URL` or `..._DB_URL` name (also `_URI`, `_DSN`) counts as a database URL whatever its value.
3. A name with `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `PRIVATE_KEY`, `API_KEY`, `APIKEY`, `ACCESS_KEY`, `CREDENTIAL`, `COOKIE`, `SIGNING`, `HMAC` or `SALT` in it, or ending in `_KEY` (or named just `KEY`), `_AUTH` or `_PAT`, is sent only when the allowlist names it exactly, never through a prefix. So `PAPERCLIP_BRIDGE_SIGNING_KEY` and `LC_SESSION_KEY` are dropped although `PAPERCLIP_BRIDGE_*` and `LC_*` are on the built-in list. A `..._TOKENS` name with a whole-number value is a token budget, not a credential.

Dropped keys are logged once per run as a warning, by name and reason (`not_allowlisted`, `denied_family`, `jwt`, `remote_database_or_credential_url`, `secret_name_needs_exact_entry`, `invalid_name`). Values are never logged.

The plugin also refuses every command of Paperclip's ACP process-session launcher, because that launcher starts the agent from a base64 envelope of its command and its whole launch env (project secrets included) that no env filter sees. An envelope up to 64 KiB rides the launch inline as `PAPERCLIP_PROCESS_SESSION_COMMAND_B64`. A larger one is uploaded through Execute as a file, `<runtime root>/process-sessions/<uuid>/command.b64`, in `printf '%s' <base64 chunk> >> ...` commands, and the launch then carries only `PAPERCLIP_PROCESS_SESSION_DIR`. So Execute refuses a command whose command or arguments name a `/process-sessions` directory or a `command.b64` file, or contain `PAPERCLIP_PROCESS_SESSION_COMMAND_B64=` or `PAPERCLIP_PROCESS_SESSION_DIR=`, and a command whose env holds either variable. Every ACP step names that directory, starting with the wrapper-script sync, so an ACP run fails at its first step, before any envelope reaches the VM (error `BOAT_ACP_PROCESS_SESSION_REFUSED`). claude_local uses ACP unless its engine is set, so set `engine` to `cli` for agents on boat environments.

### The built-in list

It covers a Claude Code run through the model-proxy tunnel and Paperclip's sandbox callback bridge. Each `PAPERCLIP_*` name was checked in Paperclip's claude-local adapter and adapter-utils: ids, modes and paths, plus the bridge's per-run credentials.

| Group | Names |
| - | - |
| Model proxy | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (the environment's dedicated model-proxy key), `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_*` |
| Claude Code | `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`, `API_TIMEOUT_MS`, `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, `MAX_THINKING_TOKENS`, `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, `DISABLE_AUTOUPDATER`, `DISABLE_ERROR_REPORTING`, `DISABLE_TELEMETRY`, `DISABLE_NON_ESSENTIAL_MODEL_CALLS`, `IS_SANDBOX` |
| Paperclip run context | `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID`, `PAPERCLIP_ISSUE_WORK_MODE`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS`, `PAPERCLIP_WORKSPACE_CWD`, `PAPERCLIP_WORKSPACE_SOURCE`, `PAPERCLIP_WORKSPACE_STRATEGY`, `PAPERCLIP_WORKSPACE_ID`, `PAPERCLIP_WORKSPACE_REPO_URL`, `PAPERCLIP_WORKSPACE_REPO_REF`, `PAPERCLIP_WORKSPACE_BRANCH`, `PAPERCLIP_WORKSPACE_WORKTREE_PATH`, `PAPERCLIP_WORKSPACES_JSON`, `AGENT_HOME` |
| Paperclip sandbox bridge | `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_API_BRIDGE_MODE`, `PAPERCLIP_BRIDGE_TOKEN`, `PAPERCLIP_BRIDGE_*`, `PAPERCLIP_SANDBOX_EXEC_CHANNEL` |
| Shell | `PATH`, `HOME`, `TERM`, `LANG`, `LC_*`, `TZ` |

In a sandbox run, `PAPERCLIP_API_KEY` and `PAPERCLIP_BRIDGE_TOKEN` hold the bridge token: a random per-run value that only the bridge inside this VM accepts, and the host forwards each bridged call with the real run token. When `PAPERCLIP_API_KEY` holds the run JWT itself (the commands Paperclip runs before the bridge starts), the JWT rule drops it.

Not on the list, on purpose: `ANTHROPIC_API_KEY` and any other model key (the Paperclip server's own key reaches the probe otherwise), `PAPERCLIP_RUNTIME_SERVICES_JSON` and its siblings (host services a VM cannot reach), `PAPERCLIP_PROCESS_SESSION_COMMAND_B64` and `PAPERCLIP_PROCESS_SESSION_DIR` (the ACP launcher, refused anyway), git and GitHub credentials (Paperclip restores the workspace and its git history to the host after each run).

### Adding names

A list you set replaces the built-in one, so start from the table above and add what the work needs. An empty list (`envAllowlist: []`) sends no run env at all; validation keeps it and warns, since a Claude run cannot work without the model-proxy and bridge keys. A blank string counts as unset. Validation fails on an entry that is not `NAME` or `NAME_*`, and warns when the list no longer delivers `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` or `PAPERCLIP_BRIDGE_TOKEN`, or names a family that is never sent. For a Rust card with a test database in a container on the VM, add for example `CARGO_*`, `RUSTUP_HOME` and `TWO_TEST_DATABASE_URL` (an exact entry, and its URL must point at the VM).

## Install on a Paperclip host

The worker must resolve `@paperclipai/plugin-sdk` from the host's own SDK. That is what the bundled providers do.

Stage the package with `scripts/stage-package.sh`. It builds from one pushed commit, never from the working tree:

```sh
git clone https://github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat && cd paperclip-plugin-sandbox-boat
git fetch origin
scripts/stage-package.sh <commit> <plugin packages root>   # prints <root>/sandbox-boat-<version>-<short sha>
```

The script:

* exports the commit with `git archive`, then runs `npm ci` and `npm run check` (typecheck, tests, build) on that copy;
* copies `dist`, `package.json`, `README.md`, `LICENSE` and `@boatdev/sdk` into the package, links `node_modules/@paperclipai/plugin-sdk` to `/app/packages/plugins/sdk` (the SDK path inside the Paperclip container; a third argument changes it), and writes the full sha to `.source-commit`;
* makes the package read-only, and uses `sudo` only for the final move when the root is not writable.

It refuses:

* a commit that is not on `origin/main`;
* a commit older than `0721a3a`. Before it, the run env file sat in the workspace, so `git add -A` or a boat snapshot could pick up the tokens in it;
* a build without the run env allowlist (0.2.0). Before it, every env key Paperclip passed, project secrets included, reached the VM;
* a build that does not delete Paperclip's run MCP config before a stop, delete or capture. Without it the run JWT stays in boat snapshots;
* a destination that already exists.

Then install it as an instance admin. `packageName` is the path as the server sees it:

```sh
curl -X POST "$PAPERCLIP/api/plugins/install" -H 'content-type: application/json' \
  -d '{"packageName":"/paperclip/plugin-packages-root/sandbox-boat-0.2.0-<sha>","isLocalPath":true}'
```

The capabilities are:

* `environment.drivers.register`;
* `plugin.state.read` and `plugin.state.write`;
* `jobs.schedule`;
* `api.routes.register`;
* `issues.read`, used to see whether a card is done.

After the install, save a plugin config for every company that uses the plugin. It can be empty:

```sh
curl -X POST "$PAPERCLIP/api/plugins/<pluginId>/config" -H 'content-type: application/json' \
  -d '{"companyId":"<companyId>","configJson":{}}'
```

The host lets a plugin's background work (the idle sweep, and the sweep that starts after an acquire or release) touch only the state of companies the plugin is configured for. Without that row, the sweep logs `state <companyId>: ... company context is required` and skips the company; release still stops each VM, and boat's auto-stop stays the backstop.

Then create a sandbox environment with provider `boat` and the config above. Run *Probe*, which starts no VM, and then point one pilot agent at it.

To undo, uninstall the plugin from the Plugins page and delete any `paperclip-*` VMs with `boat delete <id> --yes`.

## boat account settings

These are the settings the plugin expects, with the docs (docs.boat.dev) that back them. Check yours with `boat env info <env>`, `boat data-retention status` and `boat limits`. The AI-proxy and auto-refill switches need an admin key or the dashboard to read.

* **Sign in with Google or email, not GitHub.** Then boat has no GitHub token of yours to pass into a VM ([docs](https://docs.boat.dev/environments/access#what-a-normal-sandbox-receives)).
* **Environment: safe for third parties ON.** The raw toggles still read `true`; the `effective` `passGithub`, `passSecrets`, `passSandboxCredentials` and `passAgentsCredentials` must all be false ([docs](https://docs.boat.dev/environments/access)). Keep `proxyAiCredentials` off.
* **AI credentials proxy OFF.** It costs $1 a day, and on the trial one day uses the whole 25 h allowance ([docs](https://docs.boat.dev/free-trial)).
* **Zero data retention OFF.** It deletes a VM's data at every stop, so resume would never work ([docs](https://docs.boat.dev/data-retention/zero-data-retention)).
* **Snapshots off: OFF.** With it on, a stop erases the VM ([docs](https://docs.boat.dev/data-retention/snapshots-and-monitoring-off)).
* **Monitoring off: per VM.** The plugin creates every VM with `monitoring: false`, so boat keeps no command output, process list or CPU/RAM samples for it. That works whether the account-wide *Monitoring off* switch is on or off: with the switch on, boat refuses only `monitoring: true` (`409 monitoring_off_for_account`). Turning the switch on as well also covers VMs made by hand, for example `boat new` without `--no-monitoring`. Either way, these VMs get no disk-full alerts ([docs](https://docs.boat.dev/data-retention/snapshots-and-monitoring-off#monitoring-off)).
* **Auto-refill OFF.** It needs a paid plan and does not work during the trial. With it off, spend stops at the balance ([docs](https://docs.boat.dev/billing#control-your-spend)).
* **Keys:** a scoped `ci` key for the plugin and a `read-only` key for cost reads. Never use an admin key in the plugin.

Even with safe for third parties on, every VM gets `BOAT_ID` and `ASCII_TOKEN`. `ASCII_TOKEN` can publish a port of that one VM on a public URL and nothing else ([docs](https://docs.boat.dev/security#boat-credentials-inside-a-sandbox)). boat sets it in the exec environment and in an `export ASCII_TOKEN=...` line near the top of `~/.bashrc`, above the interactive guard, so any shell that reads `~/.bashrc` exports it. The plugin:

* unsets `ASCII_TOKEN` and `BOAT_ID` in every command script, after the profiles and the env file are sourced and before the command starts, and then `exec`s the command, as sshd's login shell `exec`s the script, so no shell that started with the tokens stays alive above the command (`unset` hides a variable from children, but `/proc/<pid>/environ` keeps a process's startup environment);
* deletes the `export ASCII_TOKEN=` line from `~/.bashrc` when it sets up a VM (acquire, resumed lease) and when it resumes one for a command, so a shell the agent starts (Claude Code's Bash tool sources the user's shell rc file) does not get it back.

This stops casual use, not a determined agent: `user` has passwordless `sudo` and is root in its VM. boat documents no switch to leave the token out: it stays even with safe for third parties.

## Live smoke test

`scripts/live-smoke.mjs` runs the plugin's own code against the real API. It does create, SSH, env (an allowlisted key arrives, denied keys and `ASCII_TOKEN` do not), tunnel, stop, resume, stop and delete. It also checks that boat's `ASCII_TOKEN`/`BOAT_*` names are in neither `/proc/$PPID/environ` (nor any readable ancestor's), `/etc/environment` nor `~/.bashrc`, and that a stand-in run MCP config planted before the stop is gone after the resume while `skills/` stays. It costs about $0.001.

```sh
npm run build
read -rs BOAT_API_KEY; export BOAT_API_KEY
SMOKE_TUNNEL_HOST=127.0.0.1 node scripts/live-smoke.mjs
```

## Development

```sh
npm ci
npm run typecheck
npm test        # vitest, mocked boat API + scripted ssh; plus an SDK wire test
npm run build
```

## License

MIT
