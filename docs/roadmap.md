# Product roadmap

Maintainer: Product Lead · Last reviewed: 2026-11-09

This is the repository's public entry point for product direction and non-goals. It describes intentions, not a delivery schedule, an installation record or a promise that a capability is enabled. Priorities, live work status and forecast dates remain in the maintainers' Paperclip planning workspace; they are not mirrored here. For shipped changes, use the [changelog](../CHANGELOG.md) and [tagged releases](https://github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat/releases).

## Direction

The goal is trustworthy sandbox execution and useful command offload, not feature breadth for its own sake.

- **Reliable execution and handover.** Strengthen the lifecycle and host compatibility of both whole-run sandboxes and individual offloaded commands. Interrupted or uncertain execution must remain visible and must not lead to an unsafe replay.
- **Heavy-work offload.** Advance the existing initiative to move eligible heavy work away from the agent host, while keeping lightweight tools and model waiting separate from command execution. Broader workload coverage depends on verified host integration and workload compatibility; this is not a claim that every project or command is covered.
- **Evidence before expansion.** Use reliable tests, reviewed release artifacts and bounded validation to establish correctness and operational value before expanding adoption. Judge efficiency over completed work, including transfer, recovery and idle overhead, rather than compilation speed alone.
- **Usable adoption documentation.** Keep the user entry point short and the configuration, operations and design references distinct, so readers can distinguish available software from deployment prerequisites.

GitHub Actions remains the CI of record for full suites and CI gates. The heavy-work initiative does not move CI to Boat or authorize local full-suite substitutes.

## Non-goals and boundaries

- No automatic installation, activation or rollout follows from this roadmap. Those require their own validation and authorization.
- No unrestricted remote shell or assumption that every workload is suitable for offload. Host-dependent or unsupported work needs an explicitly supported execution path.
- No automatic application of returned workspace changes as part of the current stage-first offload direction.
- No new workload profiles or features merely to broaden the catalog; reliability and compatibility of the existing execution paths come first.
- No npm publication in the accepted scope. Tagged GitHub Releases remain the distribution direction; reconsidering npm requires a separate product decision.
- No new spending, host automation, workflow changes or relaxation of security and release gates is authorized here.

## How the existing documents fit

This page owns the public direction and non-goals. Existing material is retained, not replaced with a second editable tracker:

| Source | Role |
| --- | --- |
| [README](../README.md) | User entry point and links, not a separate plan. |
| [Changelog](../CHANGELOG.md) and tagged releases | Historical record of shipped software, not evidence of a live installation. |
| [Heavy-command offload ADR](design/adr/0001-heavy-command-offload.md) | Accepted design rationale and historical implementation/pilot contracts. Its projections and sequencing are not a current roadmap, CI policy or rollout authorization. |
| [Execution vocabulary](../CONTEXT.md) and [design references](../README.md#documentation) | Terminology and technical contracts, not priority or delivery trackers. |
| [Operations](operations.md), [configuration](configuration.md) and [release procedure](releasing.md) | Procedures and prerequisites. Future or deferred procedures do not establish enabled capability or scheduled work. |

## Feedback and maintenance

Use [repository Issues](https://github.com/TogetherWeOwn/paperclip-plugin-sandbox-boat/issues) for questions, workload needs and proposals; report vulnerabilities privately through the organization's [security policy](https://github.com/TogetherWeOwn/.github/blob/main/SECURITY.md). The maintainer reviews this page when accepted direction or non-goals change and updates the last-reviewed date. A proposal or roadmap entry alone is not a commitment to ship.
