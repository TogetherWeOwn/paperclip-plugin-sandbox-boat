import type { PluginEnvironmentRealizeWorkspaceParams } from "@paperclipai/plugin-sdk";

/** Shape forwarded by environment-run-orchestrator.ts, with no provider effect. */
export function nativeWorkspaceParams(companyId: string, runId: string, executionWorkspaceId: string): PluginEnvironmentRealizeWorkspaceParams {
  return {
    driverKey: "boat", companyId, environmentId: "environment-a", config: {}, lease: { providerLeaseId: null },
    workspace: { localPath: "/work/public-rust", remotePath: "/home/user/paperclip-workspace", metadata: {
      workspaceRealizationRequest: {
        version: 1, companyId, environmentId: "environment-a", heartbeatRunId: runId, executionWorkspaceId,
        source: { localPath: "/work/public-rust", projectId: "project-a", projectWorkspaceId: "pws-a",
          repoUrl: "https://github.com/example/public-rust" },
      },
    } },
  };
}
