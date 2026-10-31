# Development

```sh
npm ci
npm run typecheck
npm test        # vitest, mocked boat API + scripted ssh; plus an SDK wire test
npm run build
```

## Real-SSH acceptance tests (no Boat calls)

Tests use the isolated loopback `sshd` harness, throwaway keys and an unprivileged
daemon, without host SSH/service changes. `PAPERCLIP_TEST_SSHD` selects an isolated
OpenSSH executable if needed. Execution assertions need Linux cgroup delegation;
without it the ordinary suite verifies real-SSH refusal/local fallback instead.
`PAPERCLIP_TEST_CGROUP_REQUIRED=1` makes absent delegation an explicit failure,
never a skipped execution proof. On a Linux development machine with delegation,
this **one-shot test scope** is not an installed service, timer or automation:

```sh
scratch=$(mktemp -d)
# From the repository root, after npm ci --ignore-scripts:
systemd-run --user --scope --quiet --property=Delegate=yes \
  env VITEST_MAX_WORKERS=1 PAPERCLIP_RUN_SCRATCH_DIR="$scratch" \
  PAPERCLIP_TEST_CGROUP_REQUIRED=1 \
  nice -n 15 python3 -I src/test-support/run-loopback-ssh-tests.py --check
rm -rf "$scratch"
```

The launcher runs typecheck, full Vitest suite and build under one child-subreaper
boundary, then reaps only its own descendants. `PAPERCLIP_TEST_CGROUP_PARENT` can
select an existing test delegation. Provider calls are fake; SSH, file transfer,
watchdogs, cgroups, cancellation and staging are real. No live Boat VM is used.
