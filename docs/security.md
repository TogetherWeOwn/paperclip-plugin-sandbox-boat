# Security

* VMs are created, by default, with `noEnv: true` and `monitoring: true`. Monitoring stays **ON by owner decision**; deployments can explicitly set `monitoring: false` for new credential-bearing VMs. Use a boat environment marked *safe for third parties*. See [monitoring retention](#monitoring-retention-and-privacy).
* **Default-deny run env.** Paperclip passes a sandbox provider the whole run env, with every secret resolved, and filters nothing for sandboxes. The plugin sends the VM only what the [env allowlist](#run-env-allowlist) names and drops the rest.
* The VM gets nothing of the account except boat's own `BOAT_ID` and `ASCII_TOKEN` (see [boat account settings](#boat-account-settings)). The plugin removes both from every command's environment, starts the shell above the command through `env -u` so no parent keeps them in its `/proc/<pid>/environ`, and deletes the `export ASCII_TOKEN=...` line from `~/.bashrc`, so the agent cannot casually publish a port on a public URL.
* Besides the allowlisted run env, one more secret reaches the VM, as a file that Paperclip writes itself: the [run MCP config](#the-run-mcp-config-exception) with the run JWT. The plugin cannot keep it out of the VM. It keeps it out of boat's snapshots: `~/.boatignore` leaves the directory it lands in out of every snapshot, and it is deleted before every stop, delete and template capture as well.
* The staged env file never sits in the workspace (the git checkout), so `git add -A` cannot commit it. It sits under `/tmp`, which boat snapshots do not save ([What a snapshot saves](https://docs.boat.dev/snapshots/whats-saved)), and it is gone before the command starts. If ssh drops before the script runs, the plugin removes it itself.
* An ephemeral ed25519 key is made per worker process with `ssh-keygen`. It is never stored.
* The host key comes from the API, and SSH uses `StrictHostKeyChecking=yes` with `HostKeyAlias=<sandbox id>`.
* The tunnel binds to `127.0.0.1` inside the VM only. Nothing is published.

## Run env allowlist

### Why

On 2026-10-22 the first pilot run on a boat VM (TOG-37420) received the TWO Bot Next project env, including four PlanetScale production secret references, which Paperclip resolves to their values before a run starts. Paperclip merges project, routine and environment env into every run and filters nothing for a sandbox, and plugin versions before 0.2.0 sent every string entry to the VM. The claude-local adapter also passes `{ ...process.env, ...env }` (the Paperclip server's own environment) to the command-resolution probe it runs in the sandbox. Since 0.2.0 no run env key reaches a VM unless an allowlist names it. That covers env only: the run JWT still reaches the VM in a file Paperclip writes, which `~/.boatignore` keeps out of every boat snapshot, and which the plugin deletes before every stop (see [The run MCP config exception](#the-run-mcp-config-exception)).

### Rules

For each `NAME=value` that Paperclip passes to Execute:

1. The name must match the allowlist: an exact `NAME`, or a `NAME_*` prefix. Anything else is dropped.
2. These are never sent, even when the allowlist names them exactly:
   * names starting with `PLANETSCALE_`, `CLOUDFLARE_`, `CF_`, `DISCORD_`, `GH_`, `GITHUB_`, `BOAT_` or `ASCII_`;
   * a value with a JWT anywhere in it (`eyJ...` header, `.`, `eyJ...` payload, `.`), bare, behind `Bearer `, or inside JSON or a header, for example Paperclip's run token (`PAPERCLIP_API_KEY` before the sandbox bridge starts);
   * a value with anything URL-like in it (`scheme://`, also JSON-escaped as `:\/\/` or percent-encoded, or a `user:password@`) that is not, as a whole, one URL in unambiguous characters (no space, quote, backslash or control character; one `@` at most, in the authority; nothing URL-like in its path, query or fragment), or JSON whose every URL-like string is one. A URL that parses is never taken as proof that the text around it is safe: the old check parsed only `https://o/` out of `https://o/'reilly:pw@github.com/o/r`;
   * a database URL, or a URL with credentials (a user, a password or a credential query parameter such as `access_token`), unless its effective destination is the VM itself: the literal host `localhost`, `127.0.0.1` or `[::1]`, an empty host or a unix socket path, and no query parameter that names another endpoint (libpq's `host`, `hostaddr`, `service`, and anything like them; a `host` or `socket` of absolute paths is a socket). No other IP spelling (`0xc0000214` is 192.0.2.20 to the resolver) and no one-label name (a DNS search domain can resolve it off the VM) counts. Such a VM-local URL is allowed only by an exact entry. A `..._DATABASE_URL` or `..._DB_URL` name (also `_URI`, `_DSN`) counts as a database URL whatever its value, so it must be one such URL.
3. A name with `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `PRIVATE_KEY`, `API_KEY`, `APIKEY`, `ACCESS_KEY`, `CREDENTIAL`, `COOKIE`, `SIGNING`, `HMAC` or `SALT` in it, or ending in `_KEY` (or named just `KEY`), `_AUTH` or `_PAT`, is sent only when the allowlist names it exactly, never through a prefix. So `PAPERCLIP_BRIDGE_SIGNING_KEY` and `LC_SESSION_KEY` are dropped although `PAPERCLIP_BRIDGE_*` and `LC_*` are on the built-in list. A `..._TOKENS` name with a whole-number value is a token budget, not a credential.

Dropped keys are logged once per run as a warning, by name and reason (`not_allowlisted`, `denied_family`, `jwt`, `remote_database_or_credential_url`, `secret_name_needs_exact_entry`, `github_capability_rejected`, `github_launcher_mismatch`, `invalid_name`). Values are never logged.

The plugin also refuses every command of Paperclip's ACP process-session launcher, because that launcher starts the agent from a base64 envelope of its command and its whole launch env (project secrets included) that no env filter sees. An envelope up to 64 KiB rides the launch inline as `PAPERCLIP_PROCESS_SESSION_COMMAND_B64`. A larger one is uploaded through Execute as a file, `<runtime root>/process-sessions/<uuid>/command.b64`, in `printf '%s' <base64 chunk> >> ...` commands, and the launch then carries only `PAPERCLIP_PROCESS_SESSION_DIR`. So Execute refuses a command whose command or arguments name a `/process-sessions` directory or a `command.b64` file, or contain `PAPERCLIP_PROCESS_SESSION_COMMAND_B64=` or `PAPERCLIP_PROCESS_SESSION_DIR=`, and a command whose env holds either variable. Every ACP step names that directory, starting with the wrapper-script sync, so an ACP run fails at its first step, before any envelope reaches the VM (error `BOAT_ACP_PROCESS_SESSION_REFUSED`). claude_local uses ACP unless its engine is set, so set `engine` to `cli` for agents on boat environments.

### The built-in list

It covers a Claude Code run through the model-proxy tunnel and Paperclip's sandbox callback bridge. Each `PAPERCLIP_*` name was checked in Paperclip's claude-local adapter and adapter-utils: ids, modes and paths, plus the bridge's per-run credentials.

| Group | Names |
| - | - |
| Model proxy | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (the environment's dedicated model-proxy key), `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_*` |
| Claude Code | `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`, `API_TIMEOUT_MS`, `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, `MAX_THINKING_TOKENS`, `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, `DISABLE_AUTOUPDATER`, `DISABLE_ERROR_REPORTING`, `DISABLE_TELEMETRY`, `DISABLE_NON_ESSENTIAL_MODEL_CALLS`, `IS_SANDBOX` |
| Paperclip run context | `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID`, `PAPERCLIP_ISSUE_WORK_MODE`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS`, `PAPERCLIP_WORKSPACE_CWD`, `PAPERCLIP_WORKSPACE_SOURCE`, `PAPERCLIP_WORKSPACE_STRATEGY`, `PAPERCLIP_WORKSPACE_ID`, `PAPERCLIP_WORKSPACE_REPO_URL`, `PAPERCLIP_WORKSPACE_REPO_REF`, `PAPERCLIP_WORKSPACE_BRANCH`, `PAPERCLIP_WORKSPACE_WORKTREE_PATH`, `PAPERCLIP_WORKSPACES_JSON`, `AGENT_HOME` |
| Paperclip sandbox bridge | `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_API_BRIDGE_MODE`, `PAPERCLIP_BRIDGE_TOKEN`, `PAPERCLIP_BRIDGE_*`, `PAPERCLIP_SANDBOX_EXEC_CHANNEL` |
| Managed GitHub | `PAPERCLIP_GITHUB_BROKER_TOKEN` (the one JWT let through), `ZDOTDIR`, `BASH_ENV` (only as the launcher dir; see below) |
| Shell | `PATH`, `HOME`, `TERM`, `LANG`, `LC_*`, `TZ` |

In a sandbox run, `PAPERCLIP_API_KEY` and `PAPERCLIP_BRIDGE_TOKEN` hold the bridge token: a random per-run value that only the bridge inside this VM accepts, and the host forwards each bridged call with the real run token. When `PAPERCLIP_API_KEY` holds the run JWT itself (the commands Paperclip runs before the bridge starts), the JWT rule drops it.

**Managed GitHub (`git push` from the VM).** Paperclip stages token-free `git` and `gh` launchers in the VM at `<workspace>/.paperclip-runtime/paperclip-runner/github/<run id>` and puts that dir first on `PATH`. For a push or fetch they ask Paperclip for a credential through the sandbox bridge (`POST /runtime-tools/github/credentials`, which the bridge allows), presenting the run's capability in `PAPERCLIP_GITHUB_BROKER_TOKEN`. That capability is a JWT (HS256, scope `github_credentials`, bound to the run, valid only while the run is live), so the JWT rule would drop it. The name is handled on its own: its value is sent only when the allowlist names `PAPERCLIP_GITHUB_BROKER_TOKEN` exactly (a prefix such as `PAPERCLIP_GITHUB_*` does not deliver it), the same env carries `PAPERCLIP_RUN_ID`, and the token has the shape Paperclip's `runtime-tools-token.ts` mints: a signature segment that is one 32-byte HMAC-SHA256 (43 base64url characters), only the header keys `alg`/`typ` and the claim keys `sub`, `company_id`, `run_id`, `responsible_user_id`, `scope`, `iat`, `exp` and `instance_id`, with `scope: github_credentials`, `run_id` equal to that run and an `exp` in the future. Any other value under that name, a raw `ghp_` or `github_pat_` token, a GitHub token in the signature segment of a capability-shaped value, extra claims or a malformed value included, is dropped (`github_capability_rejected`). A custom `envAllowlist` must add that exact name. No GitHub token is sent. `PAPERCLIP_GITHUB_BROKER_URL` (the controller's address, unreachable from the VM) is not on the list: without it the launcher falls back to `PAPERCLIP_API_URL`, the in-VM bridge.

A login shell can rebuild `PATH` from `/etc/profile` or `~/.profile` and lose the launcher dir, so `git` would be the image's own binary with no credential. Paperclip's launcher setup (adapter-utils `prepareGitHubOperationLaunchers`) covers that with `ZDOTDIR=<launcher dir>` and `BASH_ENV=<launcher dir>/.bashrc`: those profiles re-export the launcher `PATH` (and unset empty `GIT_AUTHOR_*`/`GIT_COMMITTER_*` identity values), so zsh and non-interactive bash, login or not, find the launcher first. Both names are on the built-in list and are sent only as exactly those VM paths for the launcher dir that `PATH` starts with. That dir must be an absolute path ending in `/.paperclip-runtime/paperclip-runner/github/<name>`, with that parent only once (a doubled or nested parent is not a dir Paperclip stages), where `<name>` is the `PAPERCLIP_RUN_ID` of the same env (Paperclip names a run's launcher dir after the run) or one of the native runner's own names (`anonymous-<agent id>-<16 hex>`, `native-session-<uuid>`), with no `.`, `..` or empty segment, no control character, and no `$`, backtick or backslash: bash runs parameter expansion, command substitution and arithmetic expansion on `BASH_ENV` before it opens the file, so such a path would run code in every non-interactive bash (`remoteWorkspaceDir` rejects these characters for the same reason). Spaces, quotes and non-ASCII characters in the workspace path are fine. Any other value is dropped (`github_launcher_mismatch`), since `BASH_ENV` runs a file in every non-interactive bash. A custom `envAllowlist` must add them to keep this. An interactive bash that is not a login shell reads neither, and inherits the launcher `PATH`. `GIT_*`, `SSH_ASKPASS`, `SSH_AUTH_SOCK` and `GH_CONFIG_DIR` (a denied `GH_` name) stay out: the launcher sets them itself for each operation and falls back to a temporary `gh` config dir, so sending the controller's values would only add host state.

Not on the list, on purpose: `ANTHROPIC_API_KEY` and any other model key (the Paperclip server's own key reaches the probe otherwise), `PAPERCLIP_RUNTIME_SERVICES_JSON` and its siblings (host services a VM cannot reach), `PAPERCLIP_PROCESS_SESSION_COMMAND_B64` and `PAPERCLIP_PROCESS_SESSION_DIR` (the ACP launcher, refused anyway), GitHub tokens (Paperclip restores the workspace and its git history to the host after each run).

### Adding names

A list you set replaces the built-in one, so start from the table above and add what the work needs. An empty list (`envAllowlist: []`) sends no run env at all; validation keeps it and warns, since a Claude run cannot work without the model-proxy and bridge keys. A blank string counts as unset. Validation fails on an entry that is not `NAME` or `NAME_*`, and warns when the list no longer delivers `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` or `PAPERCLIP_BRIDGE_TOKEN`, or names a family that is never sent. For a Rust card with a test database in a container on the VM, add for example `CARGO_*`, `RUSTUP_HOME` and `TWO_TEST_DATABASE_URL` (an exact entry, and its URL must point at the VM).

## The run MCP config exception

The env allowlist covers the run env only. Paperclip also syncs files into the VM, and one of them holds a credential: claude_local writes the run's MCP config, `{"mcpServers": {...: {"headers": {"Authorization": "Bearer <token>"}}}}`, where the "Paperclip projects" server carries the **run JWT**. That JWT is valid for up to 48 hours and the Paperclip API that accepts it is reachable from the internet. Paperclip syncs the file as the `mcp-config` runtime asset to `<remoteCwd>/.paperclip-runtime/<adapter>/mcp-config/mcp-config.json` and never removes it (tog.22: server `heartbeat.ts` ~25853; claude-local `claude-config.ts` ~175 and `execute.ts` ~658-713; adapter-utils `sandbox-managed-runtime.ts` ~1531 and ~1690). `<remoteCwd>` is under `/home/user`.

boat saves `/home/user` in a snapshot every minute while a VM runs and once more at each stop. Resume and fork use only the newest snapshot, and a stopped VM's newest snapshot is kept for 14 days. The older per-minute snapshots are not used by resume or fork, but they stay in the VM's snapshot list for a short time, usually less than a day, and `boat snapshot pull <snapshotId>` can download files from them with the account's API key. Deleting the VM erases all of them ([How long boat keeps data](https://docs.boat.dev/data-retention#how-long-boat-keeps-data), [Restore an older snapshot](https://docs.boat.dev/snapshots/resume-and-fork#restore-an-older-snapshot-roll-back)). None of them saves `/tmp`, nor any path that a `.boatignore` names ([What a snapshot saves](https://docs.boat.dev/snapshots/whats-saved)).

### The runtime directory is left out of snapshots

So the plugin puts the rule `.paperclip-runtime/` into `~/.boatignore` and makes `<root>/.paperclip-runtime` a real 0700 directory (lease metadata `runtimeDir` names it). boat reads a `.boatignore` with .gitignore rules, and one in the home folder applies to the whole sandbox ([Leave files out with .boatignore](https://docs.boat.dev/snapshots/whats-saved#leave-files-out-with-boatignore)); with no slash before the name, the rule matches a `.paperclip-runtime` at any depth. Measured on boat on 2026-10-23: with the rule, the per-minute and the stop snapshot trees hold each `.paperclip-runtime` as an empty directory, nothing below it. The plugin does this at acquire, at a resumed lease and at RealizeWorkspace, before Paperclip syncs anything, and again for every known root after it resumes a VM that stopped mid-lease. Everything Paperclip puts there for a run (the MCP config, skills, config, the bridge queue, GitHub launchers, upload tarballs) stays out of every snapshot. Paperclip syncs these files again for every run, so a resume on a new machine, which restores an empty directory, loses nothing it needs.

**It must be a real directory.** Before each run of an agent with an instructions bundle, Paperclip runs its own `node -e` program through Execute to write `.paperclip-runtime/.gitignore`, and that program refuses a `.paperclip-runtime` that is a symlink ("Unsafe runtime exclusion directory"; tog.22 `agent-instruction-files.ts`, `instructionGitExcludeProgram`), which fails the run with "Could not exclude agent files from task Git staging". Version 0.2.0 linked the directory into `/tmp`, and every run failed there. A bind mount from `/tmp` is no way out: boat's snapshots save what a bind mount shows under `/home/user` (measured the same day).

Paperclip's inbound workspace tar carries the host workspace's own `.paperclip-runtime/` (tog.22: neither `workspaceArchiveExclude` nor the git overlay copy leaves it out; repository clones, detached repositories), and Paperclip runs `tar -xf <tar> -C <root>`. So **every command the plugin runs exports `TAR_OPTIONS="--exclude=.paperclip-runtime ..."`** (after the run env, and ahead of any `TAR_OPTIONS` already set). GNU tar then skips every member with a path component of that name when it extracts, creates or lists: the host's runtime files are not unpacked over the run's, and an archive an agent packs never holds the run MCP config, even with `-h`. The exclude is not anchored and adds no position-sensitive option, so a command line's own `--exclude`s and member names match as before. A tar that ignores `TAR_OPTIONS` (busybox, bsdtar) is not covered; boat's image ships GNU tar. The fix that belongs in Paperclip is to add `.paperclip-runtime` to the inbound workspace excludes, as its restore and its SSH lane already do.

* An existing real directory is kept with its files, so a second run on a running VM keeps the first run's files. The run MCP config among them is already gone after a stop: the scrub removed it.
* A symlink (left by 0.2.0) or a file is replaced by a fresh directory. A link's target is left alone.
* Existing `~/.boatignore` lines stay; the rule is added once.
* The workspace root must be a plain absolute path under `$HOME` (no `.` or `..` components), where the home `.boatignore` applies. When the rule cannot be written or the directory cannot be made, acquire fails with `BOAT_RUNTIME_DIR_FAILED` and nothing of the run reaches the VM. A VM that this start created is deleted when that failed on the VM itself (a fresh VM holds nothing yet); ssh losing the command only stops it. The card's resumed VM is stopped with its disk kept (`keep: resumed_disk`): its disk holds the card's checkout and caches, and possibly a failed run's unexported work, so the error surfaces at its next start instead of the work being destroyed.

The agent can edit `~/.boatignore` (it is root in its VM). The plugin writes the rule again at every acquire, resumed lease and realize, and the scrub below covers the gap.

### The scrub before every stop, delete and capture

The plugin still deletes the MCP config before every stop (release, StopLease, the idle sweep, and a failed start), every delete (DestroyLease, release of a per-run VM) and every template capture, as defense in depth: a VM whose `~/.boatignore` lost the rule would keep it in its snapshots. Over SSH it deletes:

* `<dir>/<adapter>/mcp-config` and `<dir>/<adapter>/mcp-config-upload.tar*` (the upload tarball and its partial-upload files), where `<dir>` is the `.paperclip-runtime` of every workspace root it knows of: the lease's `remoteCwd`, the roots it set up or realized on that VM (kept in plugin state, so another worker, and a failed start in a new worker, knows them too), `remoteWorkspaceDir` and `$HOME/paperclip-workspace`;
* the same paths in every `.paperclip-runtime` under `$HOME`, down to 4 levels (so the asset is at most 6 deep), skipping `node_modules`, `.git` and `target`.

`<adapter>` is exactly one path component: a skill's own `mcp-config` deeper down (`.paperclip-runtime/claude/skills/mcp-config/`) is not the run's asset and stays. The scrub then looks again and logs the result. Nothing else is removed: the checkout, `skills`, `config` and the bridge stay. Each match goes to `rm` as one argument and is never read back as a line of text, so a name with a newline in it (from repo content or an agent) cannot add delete targets. A VM that a second run on the same card still uses is left alone until the last release.

The scrub is verified only when its last look searched everything. `find`'s status and errors are checked, never discarded, and each runtime and adapter directory must be listable; a path that is missing only because a directory above it cannot be searched counts too (EACCES is not ENOENT). Anything unreadable makes the result `walk=incomplete` (exit 3): nothing left that it could see, but not verified.

### When the scrub fails

When the cleanup fails (something is left, the script gives no result, or SSH to the running VM fails), the plugin does not stop the VM, because the stop snapshot could keep the token for 14 days (wherever it sits on the saved disk), and does not leave it running, because it would bill and keep the token live. It **deletes the VM instead** (an ordinary release, the sweep, a failed start of a VM that start created), which also erases its older snapshots, and logs why (`deleting the VM instead of stopping it (<trigger>)`). The card's next run starts a fresh VM, from `templateSnapshot` when that is set: one start, and a cold build cache. If the delete itself fails, the VM is stopped after all, with an error log. A template capture is refused instead (`BOAT_RUNTIME_SCRUB_FAILED`).

The one exception: a VM whose disk may hold work that Paperclip still needs is **stopped and its disk kept**, with an error log (`stopping the VM and keeping its disk although ...`, `keep` says why). That is:

* StopLease, and a release with `resourceDisposition: "stop_and_retain"`. Paperclip sends these to keep a run's unexported work (a failed run, a failed native finalize), and its export-resume recovery needs the `stopped` receipt. The plugin SDK forbids a delete as their fallback. The scrub fails most often exactly then: a wedged or out-of-memory VM. A VM keyed to a single run is stopped too.
* A forced release (`cancelActiveWork`) of a VM that another run on the card still holds.
* A sweep stop of a VM that a run still holds: an active run whose lease went stale, or a resumed lease (it never joins the active runs; its open run window counts).
* A failed start of the card's resumed VM (`keep: resumed_disk`); only a VM that the failed start created is deleted.
* A scrub whose walk was incomplete (`keep: incomplete_scan`): it found nothing left, but could not search part of the disk (a directory the SSH user cannot read, for example one a container made). That is not verified, so a template capture is refused, but it is no evidence of a left-over JWT either, so the card's work is not destroyed on it. A VM keyed to a single run is still deleted on release.

With the `~/.boatignore` rule in place, the stop snapshot of such a VM does not get the MCP config. A VM whose `~/.boatignore` lost the rule can keep the run JWT there for up to 14 days; that residual risk is accepted.

What this does not cover: per-minute snapshots taken before a VM first got the rule (a VM set up by 0.1.0) can hold the JWT until boat drops them, usually within a day, or the VM is deleted. A VM that boat's auto-stop stops, or one the plugin cannot reach, is not scrubbed by that stop; with the rule its snapshots have nothing to scrub, but boat keeps its machine and disk for 10 minutes, so a resume in that time finds the file again until the next scrub. Inside a running VM the agent can read the file, as it can read its own env. The real fix belongs in Paperclip: give sandbox MCP servers a bridge-scoped, short-lived token instead of the host run JWT.

## Native task network-policy admission (not network isolation)

Boat VMs have outbound internet and a guest user with passwordless sudo. This
plugin does **not** implement default-deny egress, an allowlist firewall, guest
root/Docker separation or runtime policy revocation. Environment filtering is not
network containment. The command-level offload transport below is a separate
boundary and is not certified by this native lease check.

* **AcquireLease:** before config caches, provider calls, state writes or SSH,
  reject every non-null `executionWorkspaceSettings.networkEgress` with
  `BOAT_NETWORK_EGRESS_UNSUPPORTED`. Empty grants/lists and malformed values are
  rejected too. Omitted/null settings or an omitted/null grant preserve existing
  **unrestricted** compatibility. A malformed settings container is unavailable,
  not an unrestricted grant.
* **ResumeLease:** the SDK payload has no workspace settings. Read current policy
  through company-scoped `ctx.issues.get(issueId, companyId)`, using only the
  current request's issue identity, never lease metadata or cached settings.
  Non-null grants are rejected as above. Missing task identity, reader, issue,
  top-level settings field, undefined settings or malformed settings fail closed
  with `BOAT_NETWORK_POLICY_UNAVAILABLE`, before provider/SSH/state effects. A
  present null settings field or a valid settings object with an omitted/null
  grant preserves unrestricted compatibility; it is not proof that a host-wide
  base policy is satisfied. Lookup errors and policy values are not echoed.
* Refusal is an admission error, not a warning or an expired-lease receipt. Never
  strip the policy and retry unrestricted or locally. Ordinary stop/release/destroy
  recovery remains separate; this check grants no authority to delete retained
  data or start a VM for export.

**Activation remains held until the deployed host contract is verified.** Pin the
actual host revision and demonstrate that acquire forwards current task settings,
resume's issue reader preserves current settings and field presence, and both
errors terminate admission without unrestricted fallback or retained-disk
cleanup. Upstream types alone do not establish forwarding, inheritance or
omission semantics. No live provider activation is implied by merging this code.

Before scheduling on the upgraded provider, inventory active/retained leases and
VM mappings, reconcile unknown provenance, prevent concurrent unadmitted starts,
and drain legacy runs using the existing authorized **stop-and-retain** path.
Confirm termination and that every relevant host worker uses the reviewed artifact
and routes new work through checked acquisition/resume. Execute/sync/realize can
reconnect and restart an old lease without admission; if the host cannot prevent
that path with its supported lifecycle controls, keep activation held. Tightening
policy during an active lease does not stop its commands: drain before changing
policy and re-admit afterward. Preserve export access and record the existing
retention deadline; ordinary release can delete per-run or unverified disks, so
it is not a substitute for explicit stop-and-retain.

Rollback must preserve unsupported-policy refusal: do not remove a requested grant
or resume through an unrestricted older artifact. Full isolation and live
forbidden/approved-destination before/after measurements remain unverified.

## boat account settings

These are the settings the plugin expects, with the docs (docs.boat.dev) that back them. Check yours with `boat env info <env>`, `boat data-retention status` and `boat limits`. The AI-proxy and auto-refill switches need an admin key or the dashboard to read.

* **Sign in with Google or email, not GitHub.** Then boat has no GitHub token of yours to pass into a VM ([docs](https://docs.boat.dev/environments/access#what-a-normal-sandbox-receives)).
* **Environment: safe for third parties ON.** The raw toggles still read `true`; the `effective` `passGithub`, `passSecrets`, `passSandboxCredentials` and `passAgentsCredentials` must all be false ([docs](https://docs.boat.dev/environments/access)). Keep `proxyAiCredentials` off.
* **AI credentials proxy OFF.** It costs $1 a day, and on the trial one day uses the whole 25 h allowance ([docs](https://docs.boat.dev/free-trial)).
* **Zero data retention OFF.** It deletes a VM's data at every stop, so resume would never work ([docs](https://docs.boat.dev/data-retention/zero-data-retention)).
* **Snapshots off: OFF.** With it on, a stop erases the VM ([docs](https://docs.boat.dev/data-retention/snapshots-and-monitoring-off)).
* **Monitoring on: per VM, with an explicit opt-out.** The default remains `monitoring: true` by owner decision. Set `"monitoring": false` on the sandbox environment for new VMs when retained command/process telemetry is inappropriate. If the account-wide *Monitoring off* switch is on, a monitored create is refused (`409 monitoring_off_for_account`, surfaced as `BOAT_MONITORING_OFF_FOR_ACCOUNT`). The plugin never enables monitoring account-wide, changes that switch on an account/key change, or silently retries with a different policy ([docs](https://docs.boat.dev/data-retention/snapshots-and-monitoring-off#monitoring-off)).
* **Auto-refill OFF.** It needs a paid plan and does not work during the trial. With it off, spend stops at the balance ([docs](https://docs.boat.dev/billing#control-your-spend)).
* **Keys:** a scoped `ci` key for the plugin and a `read-only` key for cost reads. Never use an admin key in the plugin.

Even with safe for third parties on, every VM gets `BOAT_ID` and `ASCII_TOKEN`. `ASCII_TOKEN` can publish a port of that one VM on a public URL and nothing else ([docs](https://docs.boat.dev/security#boat-credentials-inside-a-sandbox)). boat sets it in the exec environment and in an `export ASCII_TOKEN=...` line near the top of `~/.bashrc`, above the interactive guard, so any shell that reads `~/.bashrc` exports it. The plugin:

* runs every command script as `exec env -u ASCII_TOKEN -u BOAT_ID sh -c <script>`: sshd's login shell, which started with the tokens, becomes a `sh` that never had them, so no process between sshd and the command keeps them in its `/proc/<pid>/environ` (`unset` hides a variable from children, but `/proc/<pid>/environ` keeps a process's startup environment). That `sh` stays the command's parent and exits with its status, so a command killed by a signal reports 128+n; when the command itself replaced every shell, sshd reported the signal and ssh exited 255, which reads as a lost VM. The script unsets both again after the profiles and the env file are sourced, before the command starts;
* deletes the `export ASCII_TOKEN=` line from `~/.bashrc` when it sets up a VM (acquire, resumed lease) and when it resumes one for a command, so a shell the agent starts (Claude Code's Bash tool sources the user's shell rc file) does not get it back.

This stops casual use, not a determined agent: `user` has passwordless `sudo` and is root in its VM. boat documents no switch to leave the token out: it stays even with safe for third parties.

### Monitoring retention and privacy

Monitoring is provider-side capture, not just a CPU/RAM counter. Boat SDK 1.10.0 documents command history retained for 90 days and other processes' stdout/stderr for 72 hours, readable while a VM is stopped (`docs/BoatApi.md`, `commandHistory`). An agent that prints a credential or places it in argv can expose it to that capture even over SSH. **`noEnv`, `.boatignore`, and the pre-stop/pre-template disk scrub do not redact or erase already captured provider telemetry.** The SDK exposes no monitoring-output redaction/deletion guarantee; this plugin does not promise one.

The plugin deliberately does not request history, command logs or process samples, and projects lifecycle responses onto metadata-only fields: captured output is never copied into plugin state or logs. The same no-secret-output boundary applies to snapshot scrub diagnostics: only counts, status and fixed failure reasons are logged, never raw guest stdout/stderr. Existing runtime-directory exclusions and the scrub before stop/delete/template capture remain mandatory with monitoring on **or** off. These protect the disk, not the provider's telemetry store.

To opt out, set `"monitoring": false` in the environment config **before creating** a VM. This does not change or purge an existing VM's monitoring history; the SDK's update/resume requests do not support changing that creation policy. Keep existing work, export it through the normal Paperclip lifecycle, then use a newly created lease with the opted-out config if required. Never auto-delete a working VM or override an account's privacy setting to make a create succeed. With the default on, do not print credentials or put them in command arguments; if that cannot be assured, use the explicit opt-out.
