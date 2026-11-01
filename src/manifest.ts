import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { BOAT_SIZES } from "./size-policy.js";

export const PLUGIN_ID = "togetherweown.sandbox-boat";
export const PLUGIN_VERSION = "0.2.4";
export const DRIVER_KEY = "boat";
export const SWEEP_JOB_KEY = "boat-idle-sweep";

const advanced = (group: string) => ({ "x-paperclip-advanced": true, "x-paperclip-group": group });

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "boat.dev Sandbox Provider",
  description:
    "Runs Paperclip agent work on boat.dev VMs that exist only while a run needs them: one VM per card, resumed for a run and stopped on release, with a budget guard and per-run cost accounting. Uses the official @boatdev/sdk.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "environment.drivers.register",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "api.routes.register",
    "issues.read",
    "events.subscribe",
    "execution.workspaces.read",
    "secrets.read-ref",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  jobs: [
    {
      jobKey: SWEEP_JOB_KEY,
      displayName: "Stop idle boat VMs",
      description:
        "Stops boat VMs with no active run that idled longer than idleStopMinutes, and deletes stopped VMs whose card is done or cancelled or that were untouched for deleteAfterDays.",
      schedule: "*/5 * * * *",
    },
  ],
  apiRoutes: [
    {
      routeKey: "usage",
      method: "GET",
      path: "/usage",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "sweep",
      method: "POST",
      path: "/sweep",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "offload_exec",
      method: "POST",
      path: "/offload/exec",
      auth: "agent",
      capability: "api.routes.register",
    },
    {
      routeKey: "offload_read",
      method: "GET",
      path: "/offload/commands/:commandId",
      auth: "agent",
      capability: "api.routes.register",
    },
    {
      routeKey: "offload_heartbeat",
      method: "POST",
      path: "/offload/commands/:commandId/heartbeat",
      auth: "agent",
      capability: "api.routes.register",
    },
    {
      routeKey: "offload_cancel",
      method: "POST",
      path: "/offload/commands/:commandId/cancel",
      auth: "agent",
      capability: "api.routes.register",
    },
    {
      routeKey: "offload_report",
      method: "POST",
      path: "/offload/report",
      auth: "agent",
      capability: "api.routes.register",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      offloadExecutorEnabled: {
        type: "boolean",
        default: false,
        description: "Opt in to command-level offload through a lifecycle executor. The stock SSH executor also requires the guest transport opt-in and native workspace params. Does not enable the Cargo shim or change whole-run leases.",
      },
      offloadGuestTransportEnabled: {
        type: "boolean", default: false,
        description: "Enable the stock Linux SSH guest transport for explicitly approved public, secret-free workspaces. Requires offloadExecutorEnabled, native realization metadata and verified delegated cgroup v2. Never send production data.",
      },
      offloadCgroupParent: {
        type: "string",
        description: "Canonical delegated cgroup v2 parent on the guest, below /sys/fs/cgroup/. Missing or unwritable delegation keeps commands local; the plugin never changes guest services or delegation.",
      },
      offloadLocalRunsEnabled: {
        type: "boolean", default: false,
        description: "Bind otherwise-local runs for heavy-command offload. On each agent.run.started event the plugin reads the run's issue and its execution workspace from Paperclip and records that local source as the run's offload binding. Off by default.",
      },
      offloadLocalEnvironmentId: {
        type: "string",
        description: "Boat environment ID whose pool settings local-run offload uses. Required with offloadLocalRunsEnabled.",
      },
      offloadLocalApiKeySecretRef: {
        type: "object", required: ["type", "secretId"], additionalProperties: true,
        properties: { type: { const: "secret_ref" }, secretId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } },
        description: "Paperclip secret holding the scoped boat API key for local-run offload. Resolved per binding and never stored.",
      },
      offloadLocalDriverConfig: {
        type: "object", additionalProperties: true, default: {},
        description: "Driver settings for local-run offload pools (for example maxOffloadVms, maxActive, offloadIdleStopSeconds, size). apiKey is ignored here.",
      },
      offloadAllowedRepos: {
        type: "array", items: { type: "string" }, default: [],
        description: "Exact canonical repository IDs approved for public, secret-free offload (for example repo:https://github.com/example/public). Empty denies every repository, even with both flags enabled.",
      },
      offloadArtifactRoot: {
        type: "string",
        description: "Operator-owned persistent host directory for private frozen snapshots and staged returns. Required for stock command offload; no automatic application to source files.",
      },
      offloadProfiles: {
        type: "array", items: { type: "string" }, default: ["rust-public-1"],
        description: "Server profiles admitted for remote dispatch. Default rust-public-1 only; add node-public-1 and/or python-public-1 to opt into Node/Python offload. Unknown ids are ignored.",
      },
      offloadMinExpectedSeconds: {
        type: "number", default: 120,
        description: "A Node/Python command is a remote candidate only when its recorded median duration meets this threshold in seconds. Unknown signatures run local first and record. Rust is not gated by this setting.",
      },
      offloadMonthlyVmHourCap: {
        type: "number", default: 0,
        description: "Monthly cap on tracked offload VM-hours for the company; 0 disables the extra cap (existing budget admission still applies). When reached, new commands run local until next month.",
      },
    },
  },
  environmentDrivers: [
    {
      driverKey: DRIVER_KEY,
      kind: "sandbox_provider",
      displayName: "boat.dev VM",
      description:
        "boat.dev VMs over the official SDK and pinned-host-key SSH. One VM per card, stopped on release so it bills only while a run uses it. Budget guard, fail-fast starts, reverse tunnel to the model proxy.",
      defaultAcquireTimeoutMs: 600_000,
      // Per-card reuse: with `reuseLease: true` and `runnerLifecycleMode: "per_turn"`
      // on the environment, Paperclip stops the VM after each run (release with
      // stop_and_retain) and resumes the same VM for the card's next run
      // (ResumeLease). Never use "warm": it keeps the VM running between runs.
      sandboxCapabilities: { reusableLeases: true, nativeSyncIn: true, nativeSyncOut: true },
      supportsTemplateCapture: true,
      templateRefKind: "snapshot",
      templateConfigBinding: { field: "templateSnapshot" },
      templateIdentityPaths: ["apiBase"],
      supportsTemplateDelete: true,
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            format: "secret-ref",
            description:
              "boat API key with the `ci` preset (create, use, stop, resume and delete its own sandboxes). Create it with `boat api-key create <name> --preset ci --ttl 30d`. Leave blank to use BOAT_API_KEY on the plugin host.",
          },
          size: {
            type: "string",
            enum: ["small", "default", "large", "xlarge"],
            default: "small",
            description: "Fallback size when the task class has no measured data (default: small). Otherwise sizeCostTable selects the lowest cost per job. Plan limits still apply.",
          },
          taskClass: {
            type: "string",
            default: "default",
            pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$",
            description: "Workload class to look up in sizeCostTable. Acquire may override it with executionWorkspaceSettings.boatTaskClass; it is retained with the lease.",
          },
          sizeCostTable: {
            type: "object",
            default: {},
            description: "Measured completed jobs by task class and size; refresh weekly from the pilot JSONL log. Expected cost = hourlyRate * durationSeconds / 3600. No data: configured size (small unless overridden). Equal cost: faster wins.",
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              properties: Object.fromEntries(BOAT_SIZES.map((size) => [size, {
                type: "object",
                required: ["durationSeconds", "hourlyRate", "measuredAt"],
                additionalProperties: false,
                properties: {
                  durationSeconds: { type: "number", exclusiveMinimum: 0 },
                  hourlyRate: { type: "number", exclusiveMinimum: 0 },
                  measuredAt: { type: "string", format: "date-time" },
                  sampleCount: { type: "integer", minimum: 1, default: 1 },
                },
              }])),
            },
            ...advanced("Measured size policy"),
          },
          templateSnapshot: {
            type: "string",
            description:
              "Named snapshot to create new card VMs from (`boat snapshot <id> <name>`). Blank: create from the base environment.",
          },
          autoStopMinutes: {
            type: "number",
            default: 120,
            description:
              "boat auto-stop deadline in minutes, counted from each start or resume (not from activity). A safety net: the plugin stops VMs on release and extends the deadline only while a command runs. The trial allows at most 120.",
          },
          idleStopMinutes: {
            type: "number",
            default: 5,
            description: "The sweep stops a VM with no active run after this many idle minutes.",
          },
          maxOffloadVms: {
            type: "number",
            default: 4,
            description: "Offload pool: at most this many shared VMs for heavy commands (default 4). Beyond it, commands queue.",
            ...advanced("Offload pool"),
          },
          offloadIdleStopSeconds: {
            type: "number",
            default: 15,
            description: "Offload pool: stop a VM this many seconds after its last command ends (default 15).",
            ...advanced("Offload pool"),
          },
          maxActive: {
            type: "number",
            default: 2,
            description: "Budget guard: never run more than this many boat VMs at once (trial: 2).",
            ...advanced("Budget guard"),
          },
          maxStartsPerDay: {
            type: "number",
            default: 70,
            description: "Budget guard: refuse a create or resume when this many starts happened in the last 24 hours (trial limit: 75).",
            ...advanced("Budget guard"),
          },
          minComputeHoursLeft: {
            type: "number",
            default: 1,
            description: "Budget guard: refuse a start when fewer compute hours than this are left (trial: 25 h in total).",
            ...advanced("Budget guard"),
          },
          staleLeaseMinutes: {
            type: "number",
            default: 20,
            description: "The sweep also stops a VM whose run still holds the lease but sent no command for this many minutes.",
            ...advanced("Budget guard"),
          },
          deleteAfterDays: {
            type: "number",
            default: 7,
            description: "The sweep deletes a stopped VM untouched for this many days (boat deletes stopped disks after 14).",
            ...advanced("Budget guard"),
          },
          failFast: {
            type: "boolean",
            default: true,
            description: "Ask boat to answer at once when no machine is free instead of waiting (nothing is billed or counted).",
            ...advanced("Budget guard"),
          },
          noReadyMachineRetries: {
            type: "number",
            default: 2,
            description: "How many times to retry a fail-fast start that found no ready machine (5 s apart).",
            ...advanced("Budget guard"),
          },
          cliproxyTunnel: {
            type: "boolean",
            default: true,
            description: "Open an SSH reverse tunnel so 127.0.0.1:<tunnelRemotePort> inside the VM reaches the model proxy. Nothing is exposed publicly.",
            ...advanced("Model proxy tunnel"),
          },
          tunnelRemotePort: {
            type: "number",
            default: 8317,
            description: "Port on 127.0.0.1 inside the VM.",
            ...advanced("Model proxy tunnel"),
          },
          tunnelTargetHost: {
            type: "string",
            default: "127.0.0.1",
            description:
              "Where the tunnel leads, as seen from the plugin worker. Inside the Paperclip container use the CLIProxy service name (for example cliproxy).",
            ...advanced("Model proxy tunnel"),
          },
          tunnelTargetPort: {
            type: "number",
            default: 8317,
            description: "Port of the model proxy, as seen from the plugin worker.",
            ...advanced("Model proxy tunnel"),
          },
          modelProxyKeyFingerprint: {
            type: "string",
            description:
              "SHA-256 (64 hex) of the one dedicated, low-limit sandbox model-proxy key. ANTHROPIC_AUTH_TOKEN reaches the VM only when it is that key and ANTHROPIC_BASE_URL is the tunnel address; any other value (for example a managed AI-connection pool credential) is dropped. Unset: an on-tunnel token is delivered unverified and validation warns; an off-tunnel token is dropped either way.",
            ...advanced("Model proxy tunnel"),
          },
          managedGithub: {
            type: "boolean",
            default: false,
            description:
              "Deliver Paperclip's managed-GitHub capability and its git/gh launcher shells to the VM, so the agent can push. Off by default: any process in the VM can exchange the capability for a GitHub credential with the run's grants while the run is live. Leave off for public repos and PR branches.",
            ...advanced("VM"),
          },
          envAllowlist: {
            type: "array",
            items: { type: "string" },
            description:
              "Run env names that may reach the VM: exact names (ANTHROPIC_AUTH_TOKEN) and NAME_* prefixes (CARGO_*). Everything else Paperclip passes (project and routine env, its own process env) is dropped and logged by name. Secret-looking names (TOKEN, SECRET, PASSWORD, API_KEY, ..._KEY, SIGNING, HMAC, SALT, _AUTH, _PAT...) need an exact entry; PLANETSCALE_, CLOUDFLARE_, CF_, DISCORD_, GH_, GITHUB_, BOAT_ and ASCII_ names, values with a JWT in them and database URLs that leave the VM are never sent. Unset: the built-in list, which covers a Claude Code run through the model-proxy tunnel and Paperclip's sandbox bridge (see docs/security.md, Run env allowlist). A list you set replaces the built-in one; an empty list sends nothing.",
          },
          monitoring: {
            type: "boolean",
            default: true,
            description: "Retain boat command/process telemetry for new VMs. Set false to opt out for credential-bearing workloads; the plugin never changes the account-wide Monitoring off policy. Existing VMs retain their creation policy.",
            ...advanced("VM"),
          },
          noEnv: {
            type: "boolean",
            default: true,
            description: "Create VMs with noEnv: boat passes none of the account's secrets, GitHub token or model logins.",
            ...advanced("VM"),
          },
          boatEnvironment: {
            type: "string",
            description: "boat environment name for new VMs. Blank: the account default (base).",
            ...advanced("VM"),
          },
          remoteWorkspaceDir: {
            type: "string",
            description: "Workspace path inside the VM: a plain absolute path below /home/user, used as typed (no ~ or $HOME). Blank: $HOME/paperclip-workspace.",
            ...advanced("VM"),
          },
          namePrefix: {
            type: "string",
            default: "paperclip",
            description: "Prefix of the boat sandbox names this plugin owns. The sweep only touches names with this prefix.",
            ...advanced("VM"),
          },
          allowPaidNamedSnapshots: {
            type: "boolean",
            default: false,
            description: "Allow template capture beyond boat's 10 free named snapshots ($1.70 a month each).",
            ...advanced("VM"),
          },
          costApiKey: {
            type: "string",
            format: "secret-ref",
            description: "Optional read-only boat key used for usage reads. Blank: the main key.",
            ...advanced("API"),
          },
          apiBase: {
            type: "string",
            description: "boat API base URL. Default https://boat.dev/api/v1. Any other base needs its own apiKey (usage reads use costApiKey if set, else that apiKey): the host BOAT_API_KEY and BOAT_READONLY_KEY are only sent to the default.",
            ...advanced("API"),
          },
          timeoutMs: {
            type: "number",
            default: 300000,
            description: "Timeout for VM start, SSH setup and commands without their own timeout, in milliseconds.",
            ...advanced("API"),
          },
          stopConfirmTimeoutMs: {
            type: "number",
            default: 120000,
            description: "How long acquire, resume and the sweep wait for boat to confirm a stop, in milliseconds. Release itself returns as soon as boat accepts the stop; the sweep confirms the snapshot save.",
            ...advanced("API"),
          },
          sshConnectTimeoutSec: {
            type: "number",
            default: 15,
            description: "SSH connect timeout in seconds.",
            ...advanced("API"),
          },
        },
      },
    },
  ],
};

export default manifest;
