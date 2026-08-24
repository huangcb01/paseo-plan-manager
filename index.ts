import type { PluginContext } from "@getpaseo/plugin";
import {
  applyPlan,
  deletePlan,
  getDashboard,
  refreshUsage,
  savePlan,
} from "./plans.shared";
import {
  handleApplyPlan,
  handleDeletePlan,
  handleGetDashboard,
  handleRefreshUsage,
  handleSavePlan,
} from "./handlers.server";
import { CodingPlansWorkspacePanel } from "./main.client";

export default function contribute(plugin: PluginContext) {
  plugin.handle(getDashboard, handleGetDashboard);
  plugin.handle(savePlan, handleSavePlan);
  plugin.handle(deletePlan, handleDeletePlan);
  plugin.handle(refreshUsage, handleRefreshUsage);
  plugin.handle(applyPlan, handleApplyPlan);

  plugin.addWorkspacePanel({
    id: "coding-plans",
    title: "Coding Plans",
    icon: "Gauge",
    context: "workspace",
    Component: CodingPlansWorkspacePanel,
  });
  plugin.addCommandCenterItem({
    id: "open-coding-plans",
    title: "Open Coding Plans",
    icon: "Gauge",
    keywords: ["quota", "usage", "codex", "glm", "kimi"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("coding-plans");
    },
  });
  plugin.addCommandCenterItem({
    id: "refresh-coding-plans",
    title: "Open and refresh Coding Plan usage",
    icon: "RefreshCw",
    keywords: ["quota", "usage"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("coding-plans");
    },
  });
  return () => {};
}
