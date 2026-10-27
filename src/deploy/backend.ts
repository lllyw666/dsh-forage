import type { DeployBackend, EffectiveBackend } from "../types.js";

/**
 * auto keeps the old dsh-install path when the caller explicitly supplied a
 * runner or --dsh-bin; otherwise it uses the local writer. That preserves
 * scripted/tests behavior and makes a bare CLI work on hosts where the
 * dsh-install plugin is absent or skipped.
 */
export function resolveDeployBackend(
  requested: DeployBackend | undefined,
  hasExplicitDsh: boolean
): EffectiveBackend {
  if (requested === "local") return "local";
  if (requested === "dsh-install") return "dsh-install";
  return hasExplicitDsh ? "dsh-install" : "local";
}
