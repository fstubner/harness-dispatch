import type { SafetyProfile, ServiceConfig } from "./types.js";

export const DEFAULT_SAFETY_PROFILE: SafetyProfile = "workspace_edit";

const SAFETY_LEVEL: Record<SafetyProfile, number> = {
  read_only: 0,
  workspace_edit: 1,
  full_auto: 2,
};

export function normalizeSafetyProfile(value: unknown): SafetyProfile | undefined {
  if (value === "read_only" || value === "workspace_edit" || value === "full_auto") {
    return value;
  }
  return undefined;
}

export function requestedSafetyProfile(
  svc: ServiceConfig,
  requested?: SafetyProfile,
): SafetyProfile {
  return requested ?? svc.safetyProfile ?? DEFAULT_SAFETY_PROFILE;
}

export function effectiveSafetyProfile(
  svc: ServiceConfig,
  requested?: SafetyProfile,
): SafetyProfile {
  const harness = svc.harness ?? svc.name;
  if (harness === "cursor") return "full_auto";
  if (svc.type === "openai_compatible") return "read_only";
  return requestedSafetyProfile(svc, requested);
}

export function safetyProfileCompatible(
  svc: ServiceConfig,
  requested?: SafetyProfile,
): boolean {
  const request = requestedSafetyProfile(svc, requested);
  const effective = effectiveSafetyProfile(svc, requested);
  return SAFETY_LEVEL[effective] <= SAFETY_LEVEL[request];
}
