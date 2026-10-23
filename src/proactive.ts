// Background work outside any host invocation.
//
// The Paperclip host ties every worker->host call to the host request it was
// made in (the SDK tags calls with the active invocation id). Work that
// outlives its request, such as the sweep started after an acquire returns,
// would reuse that finished invocation, and the host refuses it ("missing,
// expired, or unknown invocation scope"). A scheduled job runs in an
// invocation with no company, so company-scoped plugin state is refused there
// too ("company context is required").
//
// This resource is created when the worker module loads, before any host
// request, so work run through it carries no invocation id. The host treats
// such calls as proactive: it allows them for the companies the plugin is
// configured for (one plugin config row per company) and refuses the rest.
import { AsyncResource } from "node:async_hooks";

const outsideInvocation = new AsyncResource("paperclip-boat-background");

export function runOutsideInvocation<T>(fn: () => Promise<T>): Promise<T> {
  return outsideInvocation.runInAsyncScope(fn);
}
