// Native task network-policy admission, shared by the whole-run lease path
// (vm-manager) and the local-run offload path (local-run-binding and the
// offload executor gate). Boat VMs have unrestricted outbound internet, so a
// task carrying a non-null networkEgress grant can never run on Boat: the
// grant is refused, never stripped and retried unrestricted. Policy values
// are never echoed in codes, messages or reasons.
export const NETWORK_POLICY_UNSUPPORTED = "BOAT_NETWORK_EGRESS_UNSUPPORTED";
export const NETWORK_POLICY_UNAVAILABLE = "BOAT_NETWORK_POLICY_UNAVAILABLE";

export const NETWORK_POLICY_UNSUPPORTED_MESSAGE =
  "Boat cannot enforce the requested network policy; admission refused.";
export const NETWORK_POLICY_UNAVAILABLE_MESSAGE =
  "Current task network policy is unavailable; Boat admission refused.";

/** Stay-local gate reasons for the offload executor and bind refusal logs. */
export const NETWORK_POLICY_UNSUPPORTED_REASON =
  "task network egress policy is not supported by Boat; running local";
export const NETWORK_POLICY_UNAVAILABLE_REASON =
  "task network policy is unavailable; running local";

export interface NetworkPolicyRefusal {
  code: string;
  message: string;
  /** Stay-local gate reason for the offload executor and bind refusal logs. */
  reason: string;
}

/**
 * Null when the settings carry no enforceable grant (omitted/null settings or
 * an omitted/null networkEgress, the explicitly unrestricted legacy
 * compatibility). Every other non-null grant — including empty grants and
 * malformed shapes — is refused; a malformed settings container is
 * unavailable, never an unrestricted grant.
 */
export function networkPolicyRefusal(settings: unknown): NetworkPolicyRefusal | null {
  if (settings == null) return null;
  if (typeof settings !== "object" || Array.isArray(settings)) {
    return { code: NETWORK_POLICY_UNAVAILABLE, message: NETWORK_POLICY_UNAVAILABLE_MESSAGE,
      reason: NETWORK_POLICY_UNAVAILABLE_REASON };
  }
  if ((settings as Record<string, unknown>).networkEgress != null) {
    return { code: NETWORK_POLICY_UNSUPPORTED, message: NETWORK_POLICY_UNSUPPORTED_MESSAGE,
      reason: NETWORK_POLICY_UNSUPPORTED_REASON };
  }
  return null;
}
