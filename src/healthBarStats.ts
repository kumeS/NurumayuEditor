/**
 * Pure helpers for the health bar's network-stats poll (BUG-006 step 2).
 *
 * The health bar polls `get_network_stats` every 4 s and each reply is a new
 * object, so storing it unconditionally re-renders the bar even when nothing
 * changed. `sameNetworkStats` lets the poll keep the previous object instead:
 * `setNetStats(prev => sameNetworkStats(prev, next) ? prev : next)`.
 *
 * Wiring: HealthBar.tsx's poll uses exactly that form (raw-source guard in
 * healthBarStats.test.ts).
 */
import type { NetworkStats } from "./types";

/** True when `next` carries the same four counters as `prev`. A missing
 * previous snapshot (first poll) always counts as a change. */
export function sameNetworkStats(prev: NetworkStats | null, next: NetworkStats): boolean {
  return (
    prev !== null &&
    prev.aiCalls === next.aiCalls &&
    prev.aiBytes === next.aiBytes &&
    prev.fetchCalls === next.fetchCalls &&
    prev.fetchBytes === next.fetchBytes
  );
}
