# Changelog

## 0.2.0 (unreleased)

### Security

* **Default-deny run env.** Execute now sends the VM only the env keys that `envAllowlist` names (exact names and `NAME_*` prefixes) and drops the rest, logging each dropped key once per run by name and reason, never by value. Before, every string entry Paperclip passed reached the VM: in the first pilot run (TOG-37420, run eca3f106, 2026-10-22) that was the TWO Bot Next project env with PlanetScale production secrets, and the claude-local adapter also passes the Paperclip server's own process env to its command probe.
* The built-in allowlist covers a Claude Code run through the model-proxy tunnel and Paperclip's sandbox bridge. Names with `TOKEN`, `SECRET`, `PASSWORD` and similar need an exact entry. `PLANETSCALE_`, `CLOUDFLARE_`, `CF_`, `DISCORD_`, `GH_`, `GITHUB_`, `BOAT_` and `ASCII_` names, JWTs (such as Paperclip's run token) and database or credential URLs that leave the VM are never sent.
* Every command script unsets `ASCII_TOKEN` and `BOAT_ID` before the payload starts, and VM setup deletes boat's `export ASCII_TOKEN=` line from `~/.bashrc`, so an agent's shells do not get the token that publishes VM ports on public URLs.
* Every command of Paperclip's ACP process-session launcher is refused (`BOAT_ACP_PROCESS_SESSION_REFUSED`), because it starts the agent from an envelope of the whole launch env that no filter sees. That covers both forms: the inline `PAPERCLIP_PROCESS_SESSION_COMMAND_B64` envelope (up to 64 KiB) and the `process-sessions/<uuid>/command.b64` file that Paperclip uploads in `printf` chunks above 64 KiB, which then launches with only `PAPERCLIP_PROCESS_SESSION_DIR`. A command or argument naming a `/process-sessions` directory or `command.b64`, or an env holding either launcher variable, is refused. The first ACP step (the wrapper-script sync) already fails, so no envelope reaches the VM. `PAPERCLIP_PROCESS_SESSION_DIR` left the built-in allowlist. claude_local defaults to ACP, so agents on boat environments need `engine: cli`.

### Added

* `envAllowlist` driver config, validated: entries must be `NAME` or `NAME_*`; a list that no longer delivers the model-proxy or bridge keys gets a warning. An unset list stays unset in the normalized config and follows the plugin's built-in list.

### Fixed (since the 0.1.0 package 41a0a43)

* One per-card lock for acquire, release, destroy and the sweep's stop (0fa36d4).
* The idle sweep runs outside host invocations, so the host no longer refuses its state calls (ce7dedd).
* The driver declares `sandboxCapabilities.reusableLeases`, so Paperclip stops a card's VM between runs and resumes it (c674915).
* `reuseLease` survives config normalization (8aa3f71).

## 0.1.0

* boat.dev sandbox provider: one VM per card, stopped on release, budget guard, fail-fast starts, usage accounting, CLIProxy reverse tunnel (92073eb).
* The run env file is staged in a fresh 0700 directory under `/tmp` and removed before the command starts (0721a3a).
* Packages are staged only from a pushed commit that has the env-file fix (41a0a43).
