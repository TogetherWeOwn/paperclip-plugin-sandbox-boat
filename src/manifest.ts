import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { BOAT_SIZES } from "./size-policy.js";

export const PLUGIN_ID = "togetherweown.sandbox-boat";
export const PLUGIN_VERSION = "0.2.1";
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
  ],
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
            default: "default",
            description: "Fallback size when the task class has no measured data (default: default). Otherwise sizeCostTable selects the lowest cost per job. Plan limits still apply.",
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
            description: "Measured completed jobs by task class and size; refresh weekly from the pilot JSONL log. Expected cost = hourlyRate * durationSeconds / 3600. No data: configured size (default). Equal cost: faster wins.",
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
            default: 15,
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
            default: 60,
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
          envAllowlist: {
            type: "array",
            items: { type: "string" },
            description:
              "Run env names that may reach the VM: exact names (ANTHROPIC_AUTH_TOKEN) and NAME_* prefixes (CARGO_*). Everything else Paperclip passes (project and routine env, its own process env) is dropped and logged by name. Secret-looking names (TOKEN, SECRET, PASSWORD, API_KEY, ..._KEY, SIGNING, HMAC, SALT, _AUTH, _PAT...) need an exact entry; PLANETSCALE_, CLOUDFLARE_, CF_, DISCORD_, GH_, GITHUB_, BOAT_ and ASCII_ names, values with a JWT in them and database URLs that leave the VM are never sent. Unset: the built-in list, which covers a Claude Code run through the model-proxy tunnel and Paperclip's sandbox bridge (see the README). A list you set replaces the built-in one; an empty list sends nothing.",
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
            description: "boat API base URL. Default https://boat.dev/api/v1.",
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
