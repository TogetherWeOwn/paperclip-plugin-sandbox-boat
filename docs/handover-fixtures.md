# Pinned source handover fixtures

This is a source-only, secret-free compatibility experiment, not permission to
install, downgrade, publish aliases, clean up live VMs, or replay an unknown
command. Required refusal is a useful result. No production enforcement is added.

## Exact source identities

| Role | Commit | Git tree |
| --- | --- | --- |
| Old installed-source reference (0.2.16) | `ab50dd7b7027debc08c02a4f70e6cd77fc7f9618` | `830281ea6b0e63b0faa4cb4a512c840a6bc9e530` |
| Accepted candidate-source reference (0.2.17) | `6250c7a6e1ad0cc0f496f11367c956f2aa7f5428` | `9ead7c773ed3fa78289fd39052a8db37336449af` |

The fixture checks both commit and tree objects before exporting tracked source
into independent temporary module roots. Missing objects fail the test; there is
no network fetch or substitution with current `main`. CI fetches history during
checkout. The PR base may include later repairs; that does not change this pair.
Each persistence handoff reopens JSON state or actual files and uses new module
roots. No installed-state paths, credentials, provider SDK clients or host state
are inputs. Network entrypoints are denied while fixtures are open.

## Semantic ledger and journal coverage

`src/handover-state.test.ts` operates the actual pinned account ledgers in both
directions: ambiguous reservations and expiry; uncommitted write refusal; scoped
holds; warm/resume reservation failure and predecessor restoration; terminal
settlement; legacy observation transition; candidate rollover and repeated
observations; lifetime and cached-allowance expiry refusal. Provider calls use
`FakeBoat` only. Ledger-level cases deliberately never start a VM.

Downgrade cannot be justified by `version: 1` parser acceptance. The old source
can reserve against wallet/trial counters even when the included allowance has
expired, while the candidate refuses. The fixture characterizes that behavior
without dispatching it. **Required operational outcome: downgrade REFUSAL and
fix-forward.** This PR does not claim that installed old code enforces refusal,
restore stale state, or offer automatic old-package fallback.

`src/handover-journal.test.ts` reopens file-backed stores between pinned journal
implementations. Synthetic `remoteStarted: true` and `remoteStarted: null` UNKNOWN
shapes preserve command/digest/scope/guest identity, retained holds, no local
fallback, and no relaunch. Missing or mismatched receipts cannot manufacture
completion or release isolation. A delayed matching receipt stages one synthetic
artifact, then a reverse handoff returns that same result/reference without
restaging or dispatching. These are synthetic shapes, not a claim to have read
or resolved either historical installed UNKNOWN record.

## Client/broker and alias coverage

`src/offload/handover-clients.test.ts` connects each old/new client to each
old/new validator and broker through an in-memory HTTP-shaped adapter. Common
cargo, Node and Python requests execute once. Never-started refusals permit one
local fallback; ambiguous receipts permit none and never resubmit. The candidate
`depSelection` field is refused by the old validator even though both advertise
`OFFLOAD_VERSION = 1`: the expected result is invalid-request exit, zero backend
starts and no local replay, not a weakened validator.

The shim dependency seam checks all eight same-name fallback resolutions, removes
the shim PATH entry and sets the recursion guard. This proves shim behavior under
the injected executable lookup, not the effective PATH of any installed agent.

`src/offload/handover-aliases.test.ts` uses exact pinned bin bytes and the actual
candidate installer against temporary packages. Sentinel ESM dist modules prove
all eight bin import paths and invoked alias names without a build; actual source
shim/client logic is tested separately. This is **not** compiled release tarball
qualification. Already-resolved old bin paths remain present after publication.
Interrupted renames, publication failure, failed restore and restart resolution
leave visible old/new mixtures; no claim of eight-rename atomicity is made.

The shipped installer requires, but does not enforce, an exclusive publisher. A
deterministic interleaving test demonstrates two successful publishers can leave
a mixed set. There is no new host lock, daemon, package hook or core machinery in
this PR. The tests invoke one publisher at a time except that explicit negative
control, retain immutable package targets, and never delete a package in use.

**Smallest remaining procedure dependency:** an externally exclusive publisher
plus an admission-free handover window for requests requiring candidate-only
fields until the broker is candidate-capable. Retain immutable old targets for
existing consumers. Common client requests being compatible does not make all
mixed clients safe. If the operator cannot establish that bounded window, route
a prebuilt immutable-pointer/admission coordination dependency; do not improvise
a second installer or silently fall back to the old package. A failed alias
restore is not reversal of journal/account semantics.

## Evidence and explicit limits

GitHub Actions is the CI of record. Exact-head run and job URLs, conclusions and
fresh-context assessment belong in the PR verification record. No local suite,
CI mirror, build, Boat workload or real provider command is used for these tests.

These fixtures cannot prove installed-source applicability, active old-package
quiescence, actual protected-state migration, real remote execution/cleanup,
current operator procedure acceptance, or fleet completion. They do not export
protected state, resolve historical unknowns, change routing/caps, install a
package, or waive native QA, Security, release or production-approval gates.
Production source/install applicability must be established separately before
merge; if the automatic path is unknown, retain the release gate.

REA angle: reuse the shipped parsers, account ledger, durable journal, shim and
installer seams. Characterize incompatible semantics instead of replacing their
authority with a second control plane.
