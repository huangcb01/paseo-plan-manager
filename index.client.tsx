import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CodingPlansWorkspacePanel } from "./client/main";
import { refreshUsage } from "./shared/plans";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "coding-plans",
    title: "Coding Plans",
    icon: "Gauge",
    locations: ["explorer"],
    context: "workspace",
    Component: CodingPlansWorkspacePanel,
  });
  client.addCommandCenterItem({
    id: "open-coding-plans",
    title: "Open Coding Plans",
    icon: "Gauge",
    keywords: ["quota", "usage", "codex", "glm", "kimi"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("coding-plans", { location: "explorer" });
    },
  });
  client.addCommandCenterItem({
    id: "refresh-coding-plans",
    title: "Refresh Coding Plan usage",
    icon: "RefreshCw",
    keywords: ["quota", "usage"],
    context: "workspace",
    async onSelect({ rpc }) {
      await rpc(refreshUsage, {});
    },
  });
  return () => {};
}
