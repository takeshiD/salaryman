import { digest } from "./model";

export type RoutePolicy = { mode: "manual" | "auto" | "random"; eligible: boolean; explicitlyRequested: boolean;
  available: boolean; attemptId: string; rate?: number };

export function route(policy: RoutePolicy): "human" | "ai" {
  if (policy.explicitlyRequested) return "human";
  if (policy.mode === "manual" || !policy.eligible || !policy.available) return "ai";
  if (policy.mode === "auto") return "human";
  const rate = policy.rate ?? 0;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new RangeError("Random rate must be between 0 and 1");
  const sample = Number.parseInt(digest(policy.attemptId).slice(0, 12), 16) / 2 ** 48;
  return sample < rate ? "human" : "ai";
}
