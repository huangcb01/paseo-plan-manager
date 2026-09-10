import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  applyPlan,
  deletePlan,
  getDashboard,
  refreshUsage,
  savePlan,
} from "./shared/plans";
import {
  handleApplyPlan,
  handleDeletePlan,
  handleGetDashboard,
  handleRefreshUsage,
  handleSavePlan,
} from "./server/handlers";

export default function contribute(server: PluginServerContext) {
  server.handle(getDashboard, handleGetDashboard);
  server.handle(savePlan, handleSavePlan);
  server.handle(deletePlan, handleDeletePlan);
  server.handle(refreshUsage, handleRefreshUsage);
  server.handle(applyPlan, handleApplyPlan);
  return () => {};
}
