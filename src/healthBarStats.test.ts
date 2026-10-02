import { describe, expect, it } from "vitest";
import { sameNetworkStats } from "./healthBarStats";
import type { NetworkStats } from "./types";

const base: NetworkStats = { aiCalls: 1, aiBytes: 2, fetchCalls: 3, fetchBytes: 4 };

describe("sameNetworkStats", () => {
  it("treats a fresh poll with identical counters as unchanged", () => {
    expect(sameNetworkStats(base, { ...base })).toBe(true);
  });

  it("reports a change when there is no previous snapshot", () => {
    expect(sameNetworkStats(null, base)).toBe(false);
  });

  // One case per field: dropping any single comparison fails exactly one case.
  it.each(["aiCalls", "aiBytes", "fetchCalls", "fetchBytes"] as const)(
    "reports a change when only %s differs",
    (field) => {
      expect(sameNetworkStats(base, { ...base, [field]: base[field] + 1 })).toBe(false);
    }
  );
});

// Wiring guard: HealthBar's network-stats poll keeps the previous object when
// the counters are unchanged. Scoped to the getNetworkStats() poll callback.
const healthBarSource = import.meta.glob("./components/HealthBar.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("HealthBar network-stats poll wiring", () => {
  it("imports sameNetworkStats and uses it in the poll's state update", () => {
    const source = healthBarSource["./components/HealthBar.tsx"];
    expect(source, "HealthBar.tsx not found").toBeTruthy();
    expect(source).toMatch(/import \{ sameNetworkStats \} from "\.\.\/healthBarStats";/);
    const start = source.indexOf("api.getNetworkStats().then(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("});", start));
    expect(body).toMatch(
      /setNetStats\(\(prev\) => \(sameNetworkStats\(prev, stats\) \? prev : stats\)\)/
    );
    expect(body).not.toMatch(/setNetStats\(stats\)/);
  });
});
