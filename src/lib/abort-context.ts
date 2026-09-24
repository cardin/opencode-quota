/**
 * Ambient abort signal for quota work.
 *
 * OpenCode 2 forwards session cancellation to Promise tool executors as
 * `context.signal`. The quota engine makes its provider HTTP calls through
 * `fetchWithTimeout`, and every provider plus its helper would need a new
 * parameter to thread that signal by hand. Instead the tool entry point runs
 * its work inside this `AsyncLocalStorage` scope, and `fetchWithTimeout` (and
 * the remote-provider fetch) merge the ambient signal with their own timeout.
 *
 * Scoping is per async execution, so unrelated quota work — periodic toasts,
 * pricing refreshes — does not inherit a tool's cancellation.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<AbortSignal>();

/** The abort signal of the tool execution this async flow belongs to, if any. */
export function getAmbientAbortSignal(): AbortSignal | undefined {
  return storage.getStore();
}

/** Run `fn` with `signal` available to nested `fetchWithTimeout` calls. */
export function runWithAbortSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  if (!signal) return fn();
  return storage.run(signal, fn);
}
