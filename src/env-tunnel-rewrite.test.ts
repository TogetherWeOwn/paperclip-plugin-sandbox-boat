import { describe, expect, it } from "vitest";
import { routeModelProxyThroughTunnel } from "./env-policy.js";

// An agent's own adapter env (e.g. ANTHROPIC_BASE_URL=http://cliproxy:8317,
// the host-side docker name) overrides the environment's tunnel address, and
// that name does not resolve inside a boat VM (ENOTFOUND on every model call).
// The plugin owns the tunnel, so it routes that exact target through it.
const tunnel = { cliproxyTunnel: true, tunnelTargetHost: "cliproxy", tunnelTargetPort: 8317, tunnelRemotePort: 8317 };

describe("routeModelProxyThroughTunnel", () => {
  it("rewrites a base URL that targets the tunnel target to the in-VM tunnel", () => {
    expect(routeModelProxyThroughTunnel([["ANTHROPIC_BASE_URL", "http://cliproxy:8317"]], tunnel))
      .toEqual([["ANTHROPIC_BASE_URL", "http://127.0.0.1:8317"]]);
  });
  it("keeps the path and uses the configured remote port", () => {
    expect(routeModelProxyThroughTunnel([["ANTHROPIC_BASE_URL", "http://cliproxy:8317/v1/"]], { ...tunnel, tunnelRemotePort: 18317 }))
      .toEqual([["ANTHROPIC_BASE_URL", "http://127.0.0.1:18317/v1/"]]);
  });
  it("leaves other hosts, other ports and other names alone", () => {
    const entries: Array<[string, string]> = [["ANTHROPIC_BASE_URL", "https://api.example.com"], ["OTHER_URL", "http://cliproxy:8317"]];
    expect(routeModelProxyThroughTunnel(entries, tunnel)).toEqual(entries);
    expect(routeModelProxyThroughTunnel([["ANTHROPIC_BASE_URL", "http://cliproxy:9999"]], tunnel))
      .toEqual([["ANTHROPIC_BASE_URL", "http://cliproxy:9999"]]);
  });
  it("does nothing when the tunnel is off or the value is not a URL", () => {
    expect(routeModelProxyThroughTunnel([["ANTHROPIC_BASE_URL", "http://cliproxy:8317"]], { ...tunnel, cliproxyTunnel: false }))
      .toEqual([["ANTHROPIC_BASE_URL", "http://cliproxy:8317"]]);
    expect(routeModelProxyThroughTunnel([["ANTHROPIC_BASE_URL", "not a url"]], tunnel))
      .toEqual([["ANTHROPIC_BASE_URL", "not a url"]]);
  });
});
