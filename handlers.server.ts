import type { SavePlanInput, Target } from "./plans.shared";
import { applyPlanToTarget, toolsAndPaths } from "./config.server";
import { planStore } from "./store.server";
import { cachedUsage, refreshUsageSnapshots } from "./usage.server";

export async function handleGetDashboard() {
  const [plans, usage, activeTargets, status] = await Promise.all([
    planStore.listPlans(),
    cachedUsage(),
    planStore.getActiveTargets(),
    toolsAndPaths(),
  ]);
  return {
    plans,
    usage,
    activeTargets,
    tools: status.tools,
    defaultPaths: status.defaultPaths,
    storagePath: planStore.root,
  };
}

export async function handleSavePlan(input: SavePlanInput) {
  return planStore.savePlan(input);
}

export async function handleDeletePlan({ planId }: { planId: string }) {
  return { deleted: await planStore.deletePlan(planId) };
}

export async function handleRefreshUsage({ planId }: { planId?: string }) {
  return { usage: await refreshUsageSnapshots(planId) };
}

export async function handleApplyPlan({ planId, target }: { planId: string; target: Target }) {
  return applyPlanToTarget(planId, target);
}
