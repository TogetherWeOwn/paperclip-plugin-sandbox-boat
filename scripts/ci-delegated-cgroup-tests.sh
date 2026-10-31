#!/bin/sh
# Run the cgroup-gated guest-watchdog suites inside a systemd user scope with
# delegated cgroup v2, with PAPERCLIP_TEST_CGROUP_REQUIRED=1 so any gated test
# that skips fails the run. A plain `npm test` on a CI runner has no delegated
# cgroup and only reports those tests as skipped.
#
# Usage: scripts/ci-delegated-cgroup-tests.sh
#   Needs passwordless sudo to start the runner user's systemd manager.
set -eu

uid=$(id -u)
# A lingering user starts user@<uid>.service, the only place cgroup v2 is
# delegated to an unprivileged user.
sudo loginctl enable-linger "$(id -un)"
XDG_RUNTIME_DIR=/run/user/$uid
export XDG_RUNTIME_DIR
i=0
until systemctl --user is-system-running --wait >/dev/null 2>&1 || [ "$(systemctl --user is-system-running 2>/dev/null)" = degraded ]; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "ci-delegated-cgroup-tests: user@$uid.service did not start" >&2
    exit 1
  fi
  sleep 1
done

exec systemd-run --user --scope --quiet -p Delegate=yes \
  env PAPERCLIP_TEST_CGROUP_REQUIRED=1 npx vitest run --project guest-watchdog
