import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  applyPlan,
  deletePlan,
  getDashboard,
  refreshUsage,
  savePlan,
  type ApplyPlanInput,
  type ApplyPlanResult,
  type CodexAuthMode,
  type Dashboard,
  type Plan,
  type Provider,
  type QuotaHistory,
  type SavePlanInput,
  type Target,
  type TokenActivity,
  type TokenActivityPoint,
  type UsageSnapshot,
  type UsageWindow,
  type ZhipuRegion,
} from "./plans.shared";

interface EditorState {
  id?: string;
  provider: Provider;
  label: string;
  region: ZhipuRegion;
  codexAuthMode: CodexAuthMode;
  authFilePath: string;
  authJsonContent: string;
  accountId: string;
  apiKey: string;
  useProxy: boolean;
}

interface ApplyDraft {
  planId: string;
  target: Target;
  models: string[];
  customModel: string;
  pickerOpen: boolean;
}

interface NoticeState {
  kind: "success" | "error";
  message: string;
  details?: string[];
}

const PROVIDER_LABELS: Record<Provider, string> = {
  codex: "ChatGPT",
  zhipu: "智谱 GLM",
  kimi: "Kimi Coding",
};

const TARGET_LABELS: Record<Target, string> = {
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude Code",
};

const PROVIDER_MARKS: Record<Provider, string> = {
  codex: "OA",
  zhipu: "GL",
  kimi: "KM",
};

function defaultModelFor(provider: Provider, target: Target): string {
  if (provider === "codex") return "gpt-5.6-sol";
  if (provider === "zhipu") return target === "codex" ? "glm-5.3" : "glm-5.1";
  return "kimi-for-coding";
}

function modelCandidatesFor(provider: Provider, target: Target): readonly string[] {
  if (provider === "codex") {
    return ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.3-codex-spark"];
  }
  if (provider === "zhipu") {
    if (target === "codex") return ["glm-5.3", "glm-5-turbo", "glm-4.7"];
    if (target === "claude") return ["glm-5.1", "glm-5.3", "glm-5.3[1m]", "glm-5-turbo", "glm-4.7"];
    return ["glm-5.1", "glm-5.3", "glm-5-turbo", "glm-4.7"];
  }
  return target === "claude"
    ? ["kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3[1m]", "k3-256k"]
    : ["kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k"];
}

function emptyEditor(provider: Provider, dashboard?: Dashboard): EditorState {
  return {
    provider,
    label: "",
    region: "cn",
    codexAuthMode: "path",
    authFilePath: provider === "codex" ? dashboard?.defaultPaths.codexAuth ?? "~/.codex/auth.json" : "",
    authJsonContent: "",
    accountId: "",
    apiKey: "",
    useProxy: provider === "codex",
  };
}

function editorFor(plan: Plan, dashboard?: Dashboard): EditorState {
  return {
    id: plan.id,
    provider: plan.provider,
    label: plan.label,
    region: plan.region ?? "cn",
    codexAuthMode: plan.authFilePath ? "path" : "content",
    authFilePath: plan.authFilePath ?? dashboard?.defaultPaths.codexAuth ?? "~/.codex/auth.json",
    authJsonContent: "",
    accountId: plan.accountId ?? "",
    apiKey: "",
    useProxy: plan.useProxy,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败";
}

function isTargetSupported(plan: Plan, target: Target): boolean {
  if (target === "opencode") return true;
  if (target === "claude") return plan.provider !== "codex";
  return plan.provider === "codex" || (plan.provider === "zhipu" && plan.region !== "cn-dev");
}

function unsupportedTargetReason(plan: Plan, target: Target): string {
  if (target === "claude" && plan.provider === "codex") {
    return "无法接入 Claude Code：ChatGPT Codex OAuth 与 Anthropic 协议不兼容，需要 Anthropic-to-Responses 协议转换代理；本插件未内置该代理。";
  }
  if (target === "codex") {
    return `无法接入 Codex：${PROVIDER_LABELS[plan.provider]} Plan 仅提供 Chat Completions，而 Codex 要求 Responses API，需要协议转换代理；本插件未内置该代理。`;
  }
  return `无法将 ${PROVIDER_LABELS[plan.provider]} Plan 接入 ${TARGET_LABELS[target]}。`;
}

function resetLabel(value: string | undefined): string {
  if (!value) return "重置时间未知";
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "重置时间未知";
  const remaining = milliseconds - Date.now();
  if (remaining > 0) {
    const minutes = Math.ceil(remaining / 60_000);
    const relative = minutes < 60
      ? `${minutes} 分钟后`
      : minutes < 1440
        ? `${Math.ceil(minutes / 60)} 小时后`
        : `${Math.ceil(minutes / 1440)} 天后`;
    return `${relative} · ${new Date(milliseconds).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
  return "等待额度刷新";
}

function usageDetail(window: UsageWindow): string {
  const displayNumber = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toLocaleString() : value;
  };
  if (window.used !== undefined && window.limit !== undefined) {
    return `${displayNumber(window.used)} / ${displayNumber(window.limit)}`;
  }
  if (window.remaining !== undefined) return `剩余 ${displayNumber(window.remaining)}`;
  return window.usedPercent !== undefined ? `${Math.round(window.usedPercent)}% 已使用` : "额度未知";
}

function compactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return Math.round(value).toLocaleString();
}

function localDateKey(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function activityRange(activity: TokenActivity, days: 7 | 30): TokenActivityPoint[] {
  const byDate = new Map(activity.points.map((point) => [point.date, point]));
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - index - 1));
    const key = localDateKey(date);
    return byDate.get(key) ?? { date: key, tokens: 0 };
  });
}

function shortDate(date: string): string {
  const match = date.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${Number(match[1])}/${Number(match[2])}` : date;
}

function shortTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function historyTimestamp(value: string, includeTime: boolean): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const date = new Date(timestamp);
  return includeTime
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : `${date.getMonth() + 1}/${date.getDate()}`;
}

function downsample<T>(values: T[], limit: number): T[] {
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, index) => (
    values[Math.round((index * (values.length - 1)) / (limit - 1))]
  ));
}

function axisIndexes(length: number, count: number): number[] {
  const tickCount = Math.min(length, count);
  if (tickCount <= 0) return [];
  if (tickCount === 1) return [0];
  return [...new Set(Array.from({ length: tickCount }, (_, index) => (
    Math.round((index * (length - 1)) / (tickCount - 1))
  )))];
}

function createStyles(theme: PluginWorkspacePanelProps["theme"], compact: boolean) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.colors.surface0,
    },
    content: {
      width: "100%",
      maxWidth: 1320,
      alignSelf: "center",
      padding: compact ? 16 : 28,
      paddingBottom: 48,
      gap: 18,
    },
    header: {
      flexDirection: "row",
      flexWrap: "nowrap",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 14,
      paddingBottom: 18,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.foregroundMuted,
    },
    headerCopy: {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
    },
    eyebrow: {
      color: theme.colors.accent,
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 1.8,
      textTransform: "uppercase",
    },
    title: {
      color: theme.colors.foreground,
      fontSize: compact ? 28 : 36,
      lineHeight: compact ? 34 : 42,
      fontWeight: "800",
      letterSpacing: -1.2,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 8,
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      flexShrink: 0,
      justifyContent: "flex-end",
      alignSelf: "flex-start",
      maxWidth: "100%",
      gap: 8,
    },
    button: {
      minHeight: 32,
      maxWidth: "100%",
      alignSelf: "flex-start",
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      paddingHorizontal: 8,
      paddingVertical: 4,
      justifyContent: "center",
      alignItems: "center",
    },
    buttonPressed: {
      opacity: 0.68,
    },
    buttonPrimary: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    buttonDanger: {
      borderColor: theme.colors.statusDanger,
    },
    buttonDisabled: {
      opacity: 0.42,
    },
    buttonText: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "700",
      textAlign: "center",
    },
    buttonTextPrimary: {
      color: theme.colors.accentForeground,
    },
    buttonTextDanger: {
      color: theme.colors.statusDanger,
    },
    stats: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    stat: {
      minWidth: 80,
      maxWidth: 200,
      flexBasis: 80,
      flexGrow: 1,
      flexShrink: 1,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.accent,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    statValue: {
      color: theme.colors.foreground,
      fontSize: 19,
      fontWeight: "800",
    },
    statLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      marginTop: 2,
    },
    notice: {
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.accent,
      paddingVertical: 9,
      paddingHorizontal: 12,
      gap: 3,
    },
    noticeError: {
      borderLeftColor: theme.colors.statusDanger,
    },
    noticeText: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "700",
    },
    noticeDetail: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      lineHeight: 16,
    },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    sectionTitle: {
      color: theme.colors.foreground,
      fontSize: 16,
      fontWeight: "800",
      letterSpacing: 0.2,
    },
    sectionMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
    },
    cards: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "flex-start",
      gap: 12,
    },
    card: {
      minWidth: 250,
      maxWidth: 620,
      flexBasis: 250,
      flexGrow: 1,
      flexShrink: 1,
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      padding: compact ? 14 : 17,
      gap: 14,
    },
    cardTop: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 10,
    },
    providerMark: {
      width: 34,
      height: 34,
      borderWidth: 1,
      borderColor: theme.colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    providerMarkText: {
      color: theme.colors.accent,
      fontSize: 10,
      fontWeight: "900",
      letterSpacing: 0.8,
    },
    cardHeading: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    cardHeadingTop: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 7,
    },
    cardTitleRow: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 7,
    },
    cardTitle: {
      color: theme.colors.foreground,
      fontSize: 16,
      fontWeight: "800",
    },
    cardProvider: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "700",
    },
    cardMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
    },
    cardActions: {
      height: 20,
      flexDirection: "row",
      alignItems: "center",
      flexShrink: 0,
      gap: 4,
    },
    cardStale: {
      color: theme.colors.foregroundMuted,
      fontSize: 8,
    },
    iconButton: {
      width: 20,
      height: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    tier: {
      color: theme.colors.accent,
      fontSize: 10,
      fontWeight: "800",
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    targetBadge: {
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    targetBadgeActive: {
      borderColor: theme.colors.accent,
    },
    targetBadgeText: {
      color: theme.colors.foregroundMuted,
      fontSize: 9,
      fontWeight: "700",
    },
    targetBadgeTextActive: {
      color: theme.colors.accent,
    },
    quotaList: {
      gap: 11,
    },
    quota: {
      gap: 5,
    },
    quotaHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      gap: 8,
    },
    quotaLabel: {
      color: theme.colors.foreground,
      fontSize: 11,
      fontWeight: "700",
    },
    quotaValue: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
    },
    quotaTrack: {
      height: 5,
      backgroundColor: theme.colors.foregroundMuted,
      overflow: "hidden",
    },
    quotaFill: {
      height: 5,
      backgroundColor: theme.colors.accent,
    },
    quotaFillDanger: {
      backgroundColor: theme.colors.statusDanger,
    },
    reset: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
    },
    historySection: {
      borderTopWidth: 1,
      borderTopColor: theme.colors.foregroundMuted,
      paddingTop: 12,
      gap: 9,
    },
    historyHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      flexWrap: "wrap",
      gap: 7,
    },
    historyTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 6,
    },
    historyTitle: {
      color: theme.colors.foreground,
      fontSize: 11,
      fontWeight: "800",
    },
    historySource: {
      color: theme.colors.accent,
      fontSize: 8,
      fontWeight: "800",
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    historyRange: {
      flexDirection: "row",
      gap: 3,
    },
    historyRangeButton: {
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    historyRangeButtonActive: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accent,
    },
    historyRangeText: {
      color: theme.colors.foregroundMuted,
      fontSize: 8,
      fontWeight: "800",
    },
    historyRangeTextActive: {
      color: theme.colors.accentForeground,
    },
    historySummary: {
      color: theme.colors.foreground,
      fontSize: 10,
      fontWeight: "700",
    },
    historyChart: {
      gap: 3,
    },
    historyChartBody: {
      height: 58,
      flexDirection: "row",
      alignItems: "stretch",
      gap: 3,
    },
    historyYAxis: {
      width: 22,
      flexShrink: 0,
      justifyContent: "space-between",
      alignItems: "flex-end",
      paddingVertical: 1,
    },
    historyYAxisText: {
      color: theme.colors.foregroundMuted,
      fontSize: 8,
      lineHeight: 9,
    },
    historyPlot: {
      flex: 1,
      minWidth: 0,
      position: "relative",
      borderLeftWidth: 1,
      borderBottomWidth: 1,
      borderColor: theme.colors.foregroundMuted,
    },
    historyGrid: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      justifyContent: "space-between",
    },
    historyGridLine: {
      height: 1,
      backgroundColor: theme.colors.foregroundMuted,
      opacity: 0.25,
    },
    historyBars: {
      flex: 1,
      height: "100%",
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 2,
    },
    historyBarSlot: {
      flex: 1,
      minWidth: 1,
      height: "100%",
      justifyContent: "flex-end",
    },
    historyBar: {
      width: "100%",
      minHeight: 1,
      backgroundColor: theme.colors.accent,
    },
    historyBarEmpty: {
      backgroundColor: theme.colors.foregroundMuted,
      opacity: 0.45,
    },
    historyBarReset: {
      borderTopWidth: 2,
      borderTopColor: theme.colors.statusDanger,
    },
    historyAxis: {
      marginLeft: 25,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    historyAxisText: {
      color: theme.colors.foregroundMuted,
      fontSize: 8,
    },
    quotaHistoryList: {
      gap: 11,
    },
    quotaHistoryItem: {
      gap: 5,
    },
    quotaHistoryHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      flexWrap: "wrap",
      gap: 5,
    },
    quotaHistoryDelta: {
      color: theme.colors.accent,
      fontSize: 9,
      fontWeight: "800",
    },
    error: {
      color: theme.colors.statusDanger,
      fontSize: 11,
      lineHeight: 16,
    },
    muted: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      lineHeight: 17,
    },
    editor: {
      borderWidth: 1,
      borderColor: theme.colors.accent,
      padding: compact ? 14 : 18,
      gap: 15,
    },
    editorCard: {
      minWidth: 250,
      maxWidth: 620,
      flexBasis: 250,
      flexGrow: 1,
      flexShrink: 1,
      alignSelf: "flex-start",
    },
    applyConfigurator: {
      borderTopWidth: 1,
      borderTopColor: theme.colors.foregroundMuted,
      paddingTop: 13,
      gap: 11,
    },
    modelSelector: {
      gap: 7,
    },
    modelSelectorTrigger: {
      minHeight: 42,
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      paddingHorizontal: 10,
      paddingVertical: 7,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    modelSelectorSummary: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    modelSelectorTitle: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "800",
    },
    modelSelectorMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
    },
    modelSelectorToggle: {
      color: theme.colors.accent,
      fontSize: 10,
      fontWeight: "800",
    },
    modelMenu: {
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      padding: 8,
      gap: 7,
    },
    modelOption: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
    },
    modelOptionToggle: {
      flex: 1,
      minWidth: 0,
      minHeight: 30,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
    },
    modelCheckbox: {
      width: 17,
      height: 17,
      flexShrink: 0,
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      alignItems: "center",
      justifyContent: "center",
    },
    modelCheckboxSelected: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    modelCheckboxText: {
      color: theme.colors.accentForeground,
      fontSize: 10,
      fontWeight: "900",
    },
    modelOptionLabel: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
      fontSize: 11,
      fontWeight: "700",
    },
    modelDefault: {
      color: theme.colors.accent,
      fontSize: 9,
      fontWeight: "900",
      letterSpacing: 0.5,
    },
    modelDefaultAction: {
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      paddingHorizontal: 6,
      paddingVertical: 3,
    },
    modelDefaultActionText: {
      color: theme.colors.foregroundMuted,
      fontSize: 9,
      fontWeight: "700",
    },
    editorTitle: {
      color: theme.colors.foreground,
      fontSize: 17,
      fontWeight: "800",
    },
    proxyControl: {
      flexDirection: compact ? "column" : "row",
      alignItems: compact ? "stretch" : "center",
      justifyContent: "space-between",
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      padding: 12,
      gap: 12,
    },
    proxyControlCard: {
      flexDirection: "column",
      alignItems: "stretch",
    },
    proxyCopy: {
      flex: 1,
      minWidth: 0,
      gap: 3,
    },
    proxyTitle: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "800",
    },
    proxyToggle: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: compact ? "flex-start" : "center",
      gap: 8,
    },
    proxyToggleCard: {
      alignSelf: "flex-start",
    },
    proxyTrack: {
      width: 42,
      height: 24,
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      padding: 3,
      justifyContent: "center",
    },
    proxyTrackActive: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accent,
    },
    proxyThumb: {
      width: 16,
      height: 16,
      backgroundColor: theme.colors.foregroundMuted,
      alignSelf: "flex-start",
    },
    proxyThumbActive: {
      backgroundColor: theme.colors.accentForeground,
      alignSelf: "flex-end",
    },
    proxyStatus: {
      color: theme.colors.foreground,
      fontSize: 11,
      fontWeight: "700",
    },
    providerPicker: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 7,
    },
    providerOption: {
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      paddingHorizontal: 7,
      paddingVertical: 4,
    },
    providerOptionSelected: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    providerOptionText: {
      color: theme.colors.foreground,
      fontSize: 11,
      fontWeight: "700",
    },
    providerOptionTextSelected: {
      color: theme.colors.accentForeground,
    },
    fields: {
      flexDirection: compact ? "column" : "row",
      flexWrap: compact ? "nowrap" : "wrap",
      gap: 11,
    },
    fieldsCard: {
      flexDirection: "column",
      flexWrap: "nowrap",
    },
    field: {
      minWidth: compact ? 0 : 260,
      width: compact ? "100%" : undefined,
      flexGrow: compact ? 0 : 1,
      flexBasis: compact ? "auto" : "31%",
      gap: 5,
    },
    fieldWide: {
      width: compact ? "100%" : undefined,
      flexBasis: compact ? "auto" : "64%",
    },
    fieldConstrained: {
      minWidth: 0,
      width: "100%",
      flexGrow: 0,
      flexBasis: "auto",
    },
    fieldLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.7,
    },
    input: {
      color: theme.colors.foreground,
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      minHeight: 39,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 12,
    },
    inputMultiline: {
      minHeight: 180,
      fontFamily: "monospace",
    },
    empty: {
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: theme.colors.foregroundMuted,
      padding: 26,
      alignItems: "center",
      gap: 8,
    },
    emptyTitle: {
      color: theme.colors.foreground,
      fontSize: 15,
      fontWeight: "800",
    },
    footer: {
      borderTopWidth: 1,
      borderTopColor: theme.colors.foregroundMuted,
      paddingTop: 14,
      gap: 4,
    },
    footerText: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      lineHeight: 15,
    },
  });
}

type Styles = ReturnType<typeof createStyles>;

function Button({
  label,
  onPress,
  styles,
  primary = false,
  danger = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  styles: Styles;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary && styles.buttonPrimary,
        danger && styles.buttonDanger,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          primary && styles.buttonTextPrimary,
          danger && styles.buttonTextDanger,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// Lucide square-pen and trash-2 paths; licenses are recorded in THIRD_PARTY_NOTICES.md.
const LUCIDE_ICON_PATHS = {
  edit: [
    "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
    "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
  ],
  delete: [
    "M10 11v6",
    "M14 11v6",
    "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
    "M3 6h18",
    "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  ],
} as const;

function LucideCardIcon({ kind, color }: { kind: "edit" | "delete"; color: string }) {
  return React.createElement(
    "svg",
    {
      width: 12,
      height: 12,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: 1.1,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      style: { pointerEvents: "none" },
    },
    ...LUCIDE_ICON_PATHS[kind].map((d) => React.createElement("path", { key: d, d })),
  );
}

function CardIconButton({
  kind,
  label,
  onPress,
  styles,
  color,
  dangerColor,
  danger = false,
  disabled = false,
}: {
  kind: "edit" | "delete";
  label: string;
  onPress: () => void;
  styles: Styles;
  color: string;
  dangerColor: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={3}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed,
      ]}
    >
      <LucideCardIcon kind={kind} color={danger ? dangerColor : color} />
    </Pressable>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  styles,
  placeholderColor,
  secure = false,
  wide = false,
  disabled = false,
  multiline = false,
  constrained = false,
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  styles: Styles;
  placeholderColor: string;
  secure?: boolean;
  wide?: boolean;
  disabled?: boolean;
  multiline?: boolean;
  constrained?: boolean;
  maxLength?: number;
}) {
  return (
    <View style={[styles.field, wide && styles.fieldWide, constrained && styles.fieldConstrained]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={placeholderColor}
        secureTextEntry={secure}
        editable={!disabled}
        maxLength={maxLength}
        multiline={multiline}
        numberOfLines={multiline ? 10 : 1}
        textAlignVertical={multiline ? "top" : "center"}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, multiline && styles.inputMultiline, disabled && styles.buttonDisabled]}
      />
    </View>
  );
}

function Quota({ window, styles }: { window: UsageWindow; styles: Styles }) {
  const percent = Math.max(0, Math.min(100, window.usedPercent ?? 0));
  const width = `${percent}%` as `${number}%`;
  return (
    <View style={styles.quota}>
      <View style={styles.quotaHeader}>
        <Text style={styles.quotaLabel}>{window.label}</Text>
        <Text style={styles.quotaValue}>{usageDetail(window)}</Text>
      </View>
      {window.usedPercent !== undefined ? (
        <View style={styles.quotaTrack}>
          <View style={[styles.quotaFill, percent >= 90 && styles.quotaFillDanger, { width }]} />
        </View>
      ) : null}
      <Text style={styles.reset}>{resetLabel(window.resetAt)}</Text>
    </View>
  );
}

interface HistoryBarValue {
  key: string;
  value: number;
  label: string;
  axisLabel: string;
  reset?: boolean;
}

function HistoryBars({
  values,
  maxValue,
  styles,
}: {
  values: HistoryBarValue[];
  maxValue: number;
  styles: Styles;
}) {
  return (
    <View style={styles.historyBars}>
      {values.map((value) => {
        const height = value.value > 0 && maxValue > 0
          ? `${Math.max(4, Math.min(100, (value.value / maxValue) * 100))}%` as `${number}%`
          : 1;
        return (
          <View
            key={value.key}
            accessible
            accessibilityLabel={value.label}
            style={styles.historyBarSlot}
          >
            <View
              style={[
                styles.historyBar,
                value.value <= 0 && styles.historyBarEmpty,
                value.reset && styles.historyBarReset,
                { height },
              ]}
            />
          </View>
        );
      })}
    </View>
  );
}

function HistoryChart({
  values,
  maxValue,
  xTickCount,
  formatY,
  styles,
}: {
  values: HistoryBarValue[];
  maxValue: number;
  xTickCount: number;
  formatY: (value: number) => string;
  styles: Styles;
}) {
  const yTicks = [maxValue, maxValue / 2, 0];
  const xTicks = axisIndexes(values.length, xTickCount).map((index) => values[index]);
  return (
    <View style={styles.historyChart}>
      <View style={styles.historyChartBody}>
        <View style={styles.historyYAxis}>
          {yTicks.map((tick, index) => (
            <Text key={`${tick}-${index}`} style={styles.historyYAxisText}>{formatY(tick)}</Text>
          ))}
        </View>
        <View style={styles.historyPlot}>
          <View pointerEvents="none" style={styles.historyGrid}>
            {[0, 1, 2].map((line) => <View key={line} style={styles.historyGridLine} />)}
          </View>
          <HistoryBars values={values} maxValue={maxValue} styles={styles} />
        </View>
      </View>
      <View style={styles.historyAxis}>
        {xTicks.map((tick) => (
          <Text key={tick.key} style={styles.historyAxisText}>{tick.axisLabel}</Text>
        ))}
      </View>
    </View>
  );
}

function TokenActivityHistory({
  activity,
  stale,
  error,
  days,
  setDays,
  styles,
}: {
  activity?: TokenActivity;
  stale?: boolean;
  error?: string;
  days: 7 | 30;
  setDays: (days: 7 | 30) => void;
  styles: Styles;
}) {
  const points = activity ? activityRange(activity, days) : [];
  const knownDates = new Set(activity?.points.map((point) => point.date) ?? []);
  const hasRangeData = points.some((point) => knownDates.has(point.date));
  const totalTokens = points.reduce((total, point) => total + point.tokens, 0);
  const calls = points.reduce((total, point) => total + (point.calls ?? 0), 0);
  const hasCalls = points.some((point) => point.calls !== undefined);
  const maxTokens = Math.max(0, ...points.map((point) => point.tokens));
  return (
    <View style={styles.historySection}>
      <View style={styles.historyHeader}>
        <View style={styles.historyTitleRow}>
          <Text style={styles.historyTitle}>Token 活动</Text>
          <Text style={styles.historySource}>{stale ? "服务端缓存" : "服务端按日"}</Text>
        </View>
        <View style={styles.historyRange}>
          {([7, 30] as const).map((range) => (
            <Pressable
              key={range}
              accessibilityRole="button"
              accessibilityState={{ selected: days === range }}
              onPress={() => setDays(range)}
              style={({ pressed }) => [
                styles.historyRangeButton,
                days === range && styles.historyRangeButtonActive,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={[styles.historyRangeText, days === range && styles.historyRangeTextActive]}>
                {range} 天
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {activity && hasRangeData ? (
        <>
          <Text style={styles.historySummary}>
            {days} 天共 {compactNumber(totalTokens)} tokens{hasCalls ? ` · ${compactNumber(calls)} 次调用` : ""}
          </Text>
          <HistoryChart
            values={points.map((point) => ({
              key: point.date,
              value: point.tokens,
              axisLabel: shortDate(point.date),
              label: `${point.date}：${point.tokens.toLocaleString()} tokens${point.calls === undefined ? "" : `，${point.calls.toLocaleString()} 次调用`}`,
            }))}
            maxValue={maxTokens}
            xTickCount={days === 7 ? 4 : 5}
            formatY={compactNumber}
            styles={styles}
          />
        </>
      ) : (
        <Text style={styles.muted}>
          {activity ? `服务端暂无最近 ${days} 天的 Token 记录。` : "等待首次历史用量刷新。"}
        </Text>
      )}
      {error ? <Text style={styles.error}>历史用量：{error}</Text> : null}
    </View>
  );
}

function LocalQuotaHistory({
  history,
  currentWindows,
  styles,
}: {
  history?: QuotaHistory;
  currentWindows: UsageWindow[];
  styles: Styles;
}) {
  const latestWindows = history?.points[history.points.length - 1]?.windows ?? [];
  const candidates = (currentWindows.length ? currentWindows : latestWindows)
    .filter((window) => window.usedPercent !== undefined)
    .sort((left, right) => {
      const rank = (window: { id: string; label: string }) => (
        window.label === "5 小时" ? 0 : window.id === "weekly" || window.label === "每周" ? 1 : 2
      );
      return rank(left) - rank(right);
    })
    .slice(0, 3);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const historySeries = history
    ? candidates.flatMap((window) => {
        const series = history.points.flatMap((point) => {
          const sample = point.windows.find((candidate) => candidate.id === window.id);
          const sampledAt = Date.parse(point.sampledAt);
          return sample && Number.isFinite(sampledAt) && sampledAt >= cutoff
            ? [{ sampledAt: point.sampledAt, ...sample }]
            : [];
        });
        return series.length ? [{ window, series }] : [];
      })
    : [];
  return (
    <View style={styles.historySection}>
      <View style={styles.historyHeader}>
        <View style={styles.historyTitleRow}>
          <Text style={styles.historyTitle}>配额变化</Text>
          <Text style={styles.historySource}>本机 · 5 分钟</Text>
        </View>
        <Text style={styles.historyAxisText}>保留 7 天</Text>
      </View>
      {historySeries.length ? (
        <View style={styles.quotaHistoryList}>
          {historySeries.map(({ window, series }) => {
            let cycleStart = 0;
            for (let index = series.length - 1; index >= 0; index -= 1) {
              if (series[index].reset) {
                cycleStart = index;
                break;
              }
            }
            const currentCycle = series.slice(cycleStart);
            const delta = Math.max(
              0,
              currentCycle[currentCycle.length - 1].usedPercent - currentCycle[0].usedPercent,
            );
            const chart = downsample(series, 36);
            const resetCount = series.filter((sample) => sample.reset).length;
            const chartSpan = Date.parse(series[series.length - 1].sampledAt) - Date.parse(series[0].sampledAt);
            const includeTime = Number.isFinite(chartSpan) && chartSpan < 24 * 60 * 60 * 1000;
            return (
              <View key={window.id} style={styles.quotaHistoryItem}>
                <View style={styles.quotaHistoryHeader}>
                  <Text style={styles.quotaLabel}>{window.label}</Text>
                  <Text style={styles.quotaHistoryDelta}>
                    {currentCycle.length > 1 ? `本周期 +${delta.toFixed(delta >= 10 ? 0 : 1)} 个百分点` : "已记录周期起点"}
                    {resetCount ? ` · ${resetCount} 次重置` : ""}
                  </Text>
                </View>
                <HistoryChart
                  values={chart.map((sample, index) => ({
                    key: `${sample.sampledAt}-${index}`,
                    value: sample.usedPercent,
                    reset: sample.reset,
                    axisLabel: historyTimestamp(sample.sampledAt, includeTime),
                    label: `${shortTimestamp(sample.sampledAt)}：${Math.round(sample.usedPercent)}% 已使用${sample.reset ? "，窗口已重置" : ""}`,
                  }))}
                  maxValue={100}
                  xTickCount={4}
                  formatY={(value) => `${Math.round(value)}%`}
                  styles={styles}
                />
              </View>
            );
          })}
        </View>
      ) : (
        <Text style={styles.muted}>首次成功刷新后开始记录；每 5 分钟至多保存一个快照。</Text>
      )}
      <Text style={styles.muted}>这里记录套餐配额百分比，不是 Token 数量；关闭面板期间不会主动请求。</Text>
    </View>
  );
}

function PlanCard({
  plan,
  usage,
  dashboard,
  styles,
  applying,
  applyDraft,
  actionsDisabled,
  confirmDelete,
  placeholderColor,
  iconColor,
  dangerColor,
  onRequestApply,
  onChangeApplyDraft,
  onConfirmApply,
  onCancelApply,
  onEdit,
  onDelete,
}: {
  plan: Plan;
  usage?: UsageSnapshot;
  dashboard: Dashboard;
  styles: Styles;
  applying?: Target;
  applyDraft?: ApplyDraft;
  actionsDisabled: boolean;
  confirmDelete: boolean;
  placeholderColor: string;
  iconColor: string;
  dangerColor: string;
  onRequestApply: (target: Target) => void;
  onChangeApplyDraft: (draft: ApplyDraft) => void;
  onConfirmApply: () => void;
  onCancelApply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const activeTargets = (["opencode", "codex", "claude"] as const).filter(
    (target) => target === "opencode"
      ? dashboard.activeTargets.opencode[plan.provider] === plan.id
      : dashboard.activeTargets[target] === plan.id,
  );
  const [targetError, setTargetError] = useState<string | null>(null);
  const [activityDays, setActivityDays] = useState<7 | 30>(7);
  const modelCandidates = applyDraft
    ? [...new Set([...modelCandidatesFor(plan.provider, applyDraft.target), ...applyDraft.models])]
    : [];
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.providerMark}>
          <Text style={styles.providerMarkText}>{PROVIDER_MARKS[plan.provider]}</Text>
        </View>
        <View style={styles.cardHeading}>
          <View style={styles.cardHeadingTop}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>{plan.label}</Text>
              <Text style={styles.cardProvider}>{PROVIDER_LABELS[plan.provider]}</Text>
              {usage?.planTier ? <Text style={styles.tier}>{usage.planTier}</Text> : null}
            </View>
            <View style={styles.cardActions}>
              {usage?.stale ? <Text style={styles.cardStale}>STALE</Text> : null}
              <CardIconButton
                kind="edit"
                label={`编辑 ${plan.label}`}
                onPress={onEdit}
                styles={styles}
                color={iconColor}
                dangerColor={dangerColor}
                disabled={actionsDisabled}
              />
              <CardIconButton
                kind="delete"
                label={confirmDelete ? `再次点击确认删除 ${plan.label}` : `删除 ${plan.label}`}
                onPress={onDelete}
                styles={styles}
                color={iconColor}
                dangerColor={dangerColor}
                danger={confirmDelete}
                disabled={actionsDisabled}
              />
            </View>
          </View>
          <Text style={styles.cardMeta}>
            {plan.credentialHint} · {plan.useProxy ? "PROXY" : "DIRECT"}
          </Text>
        </View>
      </View>

      <View style={styles.row}>
        {(["opencode", "codex", "claude"] as const).map((target) => {
          const active = activeTargets.includes(target);
          const supported = isTargetSupported(plan, target);
          return (
            <Pressable
              key={target}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled: actionsDisabled }}
              disabled={actionsDisabled}
              onPress={() => {
                if (!supported) {
                  setTargetError(unsupportedTargetReason(plan, target));
                  return;
                }
                setTargetError(null);
                onRequestApply(target);
              }}
              style={({ pressed }) => [
                styles.targetBadge,
                active && styles.targetBadgeActive,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={[styles.targetBadgeText, active && styles.targetBadgeTextActive]}>
                {applying === target
                  ? "接入中..."
                  : TARGET_LABELS[target]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {targetError ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${targetError} 点击关闭提示`}
          onPress={() => setTargetError(null)}
          style={[styles.notice, styles.noticeError]}
        >
          <Text style={styles.noticeText}>{targetError}</Text>
          <Text style={styles.noticeDetail}>点击关闭</Text>
        </Pressable>
      ) : null}

      {usage?.windows.length ? (
        <View style={styles.quotaList}>
          {usage.windows.map((window) => <Quota key={window.id} window={window} styles={styles} />)}
        </View>
      ) : (
        <Text style={styles.muted}>{usage?.status === "error" ? "没有可显示的缓存用量。" : "等待首次用量刷新。"}</Text>
      )}
      {usage?.parallelLimit ? <Text style={styles.muted}>并发上限 {usage.parallelLimit}</Text> : null}
      {usage?.balance ? <Text style={styles.muted}>Credits 余额 {usage.balance}</Text> : null}
      {plan.provider === "kimi" ? (
        <LocalQuotaHistory
          history={usage?.quotaHistory}
          currentWindows={usage?.windows ?? []}
          styles={styles}
        />
      ) : (
        <TokenActivityHistory
          activity={usage?.tokenActivity}
          stale={usage?.tokenActivityStale}
          error={usage?.tokenActivityError}
          days={activityDays}
          setDays={setActivityDays}
          styles={styles}
        />
      )}
      {usage?.error ? <Text style={styles.error}>{usage.error}</Text> : null}

      {applyDraft ? (
        <View style={styles.applyConfigurator}>
          <View>
            <Text style={styles.sectionTitle}>接入到 {TARGET_LABELS[applyDraft.target]}</Text>
            <Text style={styles.muted}>模型仅用于本次配置写入，不会保存到 Coding Plan。</Text>
          </View>
          <View style={styles.modelSelector}>
            <Text style={styles.fieldLabel}>候选模型</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: applyDraft.pickerOpen, disabled: Boolean(applying) }}
              aria-expanded={applyDraft.pickerOpen}
              disabled={Boolean(applying)}
              onPress={() => onChangeApplyDraft({ ...applyDraft, pickerOpen: !applyDraft.pickerOpen })}
              style={({ pressed }) => [styles.modelSelectorTrigger, pressed && styles.buttonPressed]}
            >
              <View style={styles.modelSelectorSummary}>
                <Text style={styles.modelSelectorTitle}>
                  {applyDraft.models.length ? `已选择 ${applyDraft.models.length} 个模型` : "尚未选择模型"}
                </Text>
                <Text style={styles.modelSelectorMeta} numberOfLines={1}>
                  {applyDraft.models.length ? `默认：${applyDraft.models[0]}` : "展开并勾选至少一个模型"}
                </Text>
              </View>
              <Text style={styles.modelSelectorToggle}>{applyDraft.pickerOpen ? "收起" : "展开"}</Text>
            </Pressable>
            {applyDraft.pickerOpen ? (
              <View style={styles.modelMenu}>
                {modelCandidates.map((model) => {
                  const selectedIndex = applyDraft.models.indexOf(model);
                  const selected = selectedIndex >= 0;
                  const selectionDisabled = Boolean(applying) || (!selected && applyDraft.models.length >= 16);
                  return (
                    <View key={model} style={styles.modelOption}>
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selected, disabled: selectionDisabled }}
                        aria-checked={selected}
                        disabled={selectionDisabled}
                        onPress={() => {
                          const models = selected
                            ? applyDraft.models.filter((candidate) => candidate !== model)
                            : [...applyDraft.models, model];
                          onChangeApplyDraft({ ...applyDraft, models });
                        }}
                        style={({ pressed }) => [
                          styles.modelOptionToggle,
                          selectionDisabled && styles.buttonDisabled,
                          pressed && !selectionDisabled && styles.buttonPressed,
                        ]}
                      >
                        <View style={[styles.modelCheckbox, selected && styles.modelCheckboxSelected]}>
                          {selected ? <Text style={styles.modelCheckboxText}>✓</Text> : null}
                        </View>
                        <Text style={styles.modelOptionLabel}>{model}</Text>
                        {selectedIndex === 0 ? <Text style={styles.modelDefault}>默认</Text> : null}
                      </Pressable>
                      {selectedIndex > 0 ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`将 ${model} 设为默认模型`}
                          disabled={Boolean(applying)}
                          onPress={() => onChangeApplyDraft({
                            ...applyDraft,
                            models: [model, ...applyDraft.models.filter((candidate) => candidate !== model)],
                          })}
                          style={({ pressed }) => [styles.modelDefaultAction, pressed && styles.buttonPressed]}
                        >
                          <Text style={styles.modelDefaultActionText}>设为默认</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })}
                <Field
                  label="添加自定义模型 ID"
                  value={applyDraft.customModel}
                  onChangeText={(customModel) => onChangeApplyDraft({ ...applyDraft, customModel })}
                  placeholder="输入候选列表之外的模型 ID"
                  styles={styles}
                  placeholderColor={placeholderColor}
                  wide
                  constrained
                  maxLength={256}
                  disabled={Boolean(applying)}
                />
                <Button
                  label="添加模型"
                  onPress={() => {
                    const model = applyDraft.customModel.trim();
                    if (!model || applyDraft.models.includes(model) || applyDraft.models.length >= 16) return;
                    onChangeApplyDraft({ ...applyDraft, models: [...applyDraft.models, model], customModel: "" });
                  }}
                  styles={styles}
                  disabled={
                    Boolean(applying) ||
                    !applyDraft.customModel.trim() ||
                    applyDraft.models.includes(applyDraft.customModel.trim()) ||
                    applyDraft.models.length >= 16
                  }
                />
                <Text style={styles.muted}>最多选择 16 个模型；首个模型作为默认模型。</Text>
                {applyDraft.target === "claude" && applyDraft.models.length > 1 ? (
                  <Text style={styles.muted}>Claude Code 多模型候选列表需要 2.1.242 或更高版本。</Text>
                ) : null}
              </View>
            ) : null}
          </View>
          <View style={styles.row}>
            <Button
              label="取消"
              onPress={onCancelApply}
              styles={styles}
              disabled={actionsDisabled}
            />
            <Button
              label={applying === applyDraft.target
                ? "接入中..."
                : `确认接入 ${TARGET_LABELS[applyDraft.target]}（${applyDraft.models.length} 个模型）`}
              onPress={onConfirmApply}
              styles={styles}
              primary
              disabled={actionsDisabled || applyDraft.models.length === 0}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function PlanEditor({
  editor,
  setEditor,
  saving,
  styles,
  placeholderColor,
  onSave,
  onCancel,
  embedded = false,
}: {
  editor: EditorState;
  setEditor: (next: EditorState) => void;
  saving: boolean;
  styles: Styles;
  placeholderColor: string;
  onSave: () => void;
  onCancel: () => void;
  embedded?: boolean;
}) {
  function selectProvider(provider: Provider) {
    if (editor.id) return;
    setEditor({ ...emptyEditor(provider), label: editor.label });
  }
  return (
    <View style={[styles.editor, embedded && styles.editorCard]}>
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.eyebrow}>{editor.id ? "EDIT PLAN" : "NEW PLAN"}</Text>
          <Text style={styles.editorTitle}>{editor.id ? `编辑 ${editor.label}` : "添加 Coding Plan"}</Text>
        </View>
        <Button label="取消" onPress={onCancel} styles={styles} disabled={saving} />
      </View>

      <View style={styles.providerPicker}>
        {(["codex", "zhipu", "kimi"] as const).map((provider) => {
          const selected = editor.provider === provider;
          return (
            <Pressable
              key={provider}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: Boolean(editor.id) || saving }}
              disabled={Boolean(editor.id) || saving}
              onPress={() => selectProvider(provider)}
              style={({ pressed }) => [
                styles.providerOption,
                selected && styles.providerOptionSelected,
                (saving || (editor.id && !selected)) && styles.buttonDisabled,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={[styles.providerOptionText, selected && styles.providerOptionTextSelected]}>
                {PROVIDER_LABELS[provider]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.proxyControl, embedded && styles.proxyControlCard]}>
        <View style={styles.proxyCopy}>
          <Text style={styles.proxyTitle}>用量查询代理</Text>
          <Text style={styles.muted}>
            开启后使用 Paseo daemon 的 HTTPS_PROXY / HTTP_PROXY，并遵守 NO_PROXY。
          </Text>
        </View>
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="用量查询代理"
          accessibilityState={{ checked: editor.useProxy, disabled: saving }}
          disabled={saving}
          onPress={() => setEditor({ ...editor, useProxy: !editor.useProxy })}
          style={({ pressed }) => [
            styles.proxyToggle,
            embedded && styles.proxyToggleCard,
            saving && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}
        >
          <View style={[styles.proxyTrack, editor.useProxy && styles.proxyTrackActive]}>
            <View style={[styles.proxyThumb, editor.useProxy && styles.proxyThumbActive]} />
          </View>
          <Text style={styles.proxyStatus}>{editor.useProxy ? "使用代理" : "直连"}</Text>
        </Pressable>
      </View>

      <View style={[styles.fields, embedded && styles.fieldsCard]}>
        <Field
          label="显示名称"
          value={editor.label}
          onChangeText={(label) => setEditor({ ...editor, label })}
          placeholder="例如：工作账号 Pro"
          styles={styles}
          placeholderColor={placeholderColor}
          constrained={embedded}
          disabled={saving}
        />
        {editor.provider === "codex" ? (
          <>
            <View style={[styles.field, styles.fieldWide, embedded && styles.fieldConstrained]}>
              <Text style={styles.fieldLabel}>auth.json 导入方式</Text>
              <View style={styles.providerPicker}>
                {([
                  ["path", "从路径读取"],
                  ["content", "直接输入 JSON"],
                ] as const).map(([mode, label]) => {
                  const selected = editor.codexAuthMode === mode;
                  return (
                    <Pressable
                      key={mode}
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled: saving }}
                      disabled={saving}
                      onPress={() => setEditor({
                        ...editor,
                        codexAuthMode: mode,
                        ...(mode === "path" ? { authJsonContent: "" } : {}),
                      })}
                      style={({ pressed }) => [
                        styles.providerOption,
                        selected && styles.providerOptionSelected,
                        saving && styles.buttonDisabled,
                        pressed && styles.buttonPressed,
                      ]}
                    >
                      <Text style={[styles.providerOptionText, selected && styles.providerOptionTextSelected]}>
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            {editor.codexAuthMode === "path" ? (
              <Field
                label="Codex auth.json 路径"
                value={editor.authFilePath}
                onChangeText={(authFilePath) => setEditor({ ...editor, authFilePath })}
                placeholder="~/.codex/auth.json"
                styles={styles}
                placeholderColor={placeholderColor}
                wide
                constrained={embedded}
                disabled={saving}
              />
            ) : (
              <Field
                label={editor.id ? "auth.json 内容（留空表示保留现有凭据）" : "auth.json 内容"}
                value={editor.authJsonContent}
                onChangeText={(authJsonContent) => setEditor({ ...editor, authJsonContent })}
                placeholder={'{\n  "tokens": { ... }\n}'}
                styles={styles}
                placeholderColor={placeholderColor}
                wide
                multiline
                constrained={embedded}
                disabled={saving}
              />
            )}
            <Field
              label="ChatGPT Account ID（可选）"
              value={editor.accountId}
              onChangeText={(accountId) => setEditor({ ...editor, accountId })}
              placeholder="留空则从 token 读取"
              styles={styles}
              placeholderColor={placeholderColor}
              constrained={embedded}
              disabled={saving}
            />
          </>
        ) : (
          <Field
            label={editor.id ? "API Key（留空表示不修改）" : "API Key"}
            value={editor.apiKey}
            onChangeText={(apiKey) => setEditor({ ...editor, apiKey })}
            placeholder="仅保存在 Paseo daemon 主机"
            styles={styles}
            placeholderColor={placeholderColor}
            secure
            wide
            constrained={embedded}
            disabled={saving}
          />
        )}
      </View>

      {editor.provider === "zhipu" ? (
        <View style={[styles.field, embedded && styles.fieldConstrained]}>
          <Text style={styles.fieldLabel}>区域</Text>
          <View style={styles.providerPicker}>
            {([
              ["cn", "中国区"],
              ["global", "Global / Z.AI"],
              ["cn-dev", "中国区 Dev"],
            ] as const).map(([region, label]) => {
              const selected = editor.region === region;
              return (
                <Pressable
                  key={region}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: saving }}
                  disabled={saving}
                  onPress={() => setEditor({ ...editor, region })}
                  style={({ pressed }) => [
                    styles.providerOption,
                    selected && styles.providerOptionSelected,
                    saving && styles.buttonDisabled,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={[styles.providerOptionText, selected && styles.providerOptionTextSelected]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      <View style={styles.row}>
        <Button
          label={saving ? "保存中..." : editor.id ? "保存并重新导入凭据" : "保存 Plan"}
          onPress={onSave}
          styles={styles}
          primary
          disabled={
            saving ||
            !editor.label.trim() ||
            (editor.provider === "codex" &&
              ((editor.codexAuthMode === "path" && !editor.authFilePath.trim()) ||
                (editor.codexAuthMode === "content" &&
                  !editor.id &&
                  !editor.authJsonContent.trim())))
          }
        />
      </View>
    </View>
  );
}

export function CodingPlansWorkspacePanel({ theme, host, layout }: PluginWorkspacePanelProps) {
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const compact = layout.compact || (panelWidth !== null && panelWidth < 800);
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const queryClient = useQueryClient();
  const dashboardRpc = useRpc(getDashboard) as (_input: Record<string, never>) => Promise<Dashboard>;
  const saveRpc = useRpc(savePlan) as (input: SavePlanInput) => Promise<Plan>;
  const deleteRpc = useRpc(deletePlan) as (input: { planId: string }) => Promise<{ deleted: boolean }>;
  const refreshRpc = useRpc(refreshUsage) as (input: { planId?: string }) => Promise<{ usage: UsageSnapshot[] }>;
  const applyRpc = useRpc(applyPlan) as (input: ApplyPlanInput) => Promise<ApplyPlanResult>;
  const queryKey = ["coding-plan-manager", host.id, "dashboard"] as const;
  const usageKey = ["coding-plan-manager", host.id, "usage"] as const;
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [applyDraft, setApplyDraft] = useState<ApplyDraft | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dashboardQuery = useQuery({
    queryKey,
    queryFn: () => dashboardRpc({}),
  });
  const usageQuery = useQuery({
    queryKey: usageKey,
    queryFn: () => refreshRpc({}),
    enabled: Boolean((dashboardQuery.data as Dashboard | undefined)?.plans.length),
    refetchInterval: 60_000,
    retry: false,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteRpc,
    async onSuccess(result: { deleted: boolean }) {
      setConfirmDeleteId(null);
      setNotice({
        kind: result.deleted ? "success" : "error",
        message: result.deleted
          ? "Coding Plan 已从插件中删除；已写入的工具配置不会自动回滚。"
          : "Coding Plan 已不存在。",
      });
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: usageKey });
    },
    onError(error: unknown) {
      setNotice({ kind: "error", message: errorMessage(error) });
    },
  });
  const applyMutation = useMutation({
    mutationFn: applyRpc,
    async onSuccess(result: ApplyPlanResult) {
      setApplyDraft(null);
      setNotice({
        kind: result.applied ? "success" : "error",
        message: result.message,
        details: result.warnings,
      });
      await queryClient.invalidateQueries({ queryKey });
    },
    onError(error: unknown) {
      setNotice({ kind: "error", message: errorMessage(error) });
    },
  });

  const dashboard = dashboardQuery.data as Dashboard | undefined;
  const refreshedUsage = (usageQuery.data as { usage: UsageSnapshot[] } | undefined)?.usage;
  const usageError = usageQuery.error ? errorMessage(usageQuery.error) : undefined;
  const usage: UsageSnapshot[] = (refreshedUsage ?? dashboard?.usage ?? []).map((snapshot) =>
    usageError ? { ...snapshot, stale: true } : snapshot,
  );
  const usageByPlan = new Map<string, UsageSnapshot>(
    usage.map((snapshot: UsageSnapshot) => [snapshot.planId, snapshot]),
  );
  const toolsInstalled = dashboard
    ? Object.values(dashboard.tools).filter((tool) => tool.installed).length
    : 0;
  const activeCount = dashboard
    ? new Set([
        ...Object.values(dashboard.activeTargets.opencode),
        dashboard.activeTargets.codex,
        dashboard.activeTargets.claude,
      ].filter((planId): planId is string => typeof planId === "string")).size
    : 0;
  const actionsBusy = saving || deleteMutation.isPending || applyMutation.isPending;

  async function submitEditor() {
    if (!editor) return;
    const input: SavePlanInput = {
      ...(editor.id ? { id: editor.id } : {}),
      label: editor.label,
      provider: editor.provider,
      useProxy: editor.useProxy,
      ...(editor.provider === "zhipu" ? { region: editor.region } : {}),
      ...(editor.provider === "codex"
        ? {
            codexAuthMode: editor.codexAuthMode,
            ...(editor.codexAuthMode === "path"
              ? { authFilePath: editor.authFilePath }
              : { authJsonContent: editor.authJsonContent || undefined }),
            accountId: editor.accountId || undefined,
          }
        : { apiKey: editor.apiKey || undefined }),
    };
    if (editor.provider !== "codex") setEditor({ ...editor, apiKey: "" });
    setSaving(true);
    try {
      const saved = await saveRpc(input);
      setEditor(null);
      setNotice({ kind: "success", message: `已保存 ${saved.label}` });
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: usageKey });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  function requestDelete(planId: string) {
    if (confirmDeleteId !== planId) {
      setConfirmDeleteId(planId);
      return;
    }
    if (applyDraft?.planId === planId) setApplyDraft(null);
    deleteMutation.mutate({ planId });
  }

  const loading = dashboardQuery.isPending;
  return (
    <View
      style={styles.screen}
      onLayout={({ nativeEvent }) => {
        const width = Math.round(nativeEvent.layout.width);
        setPanelWidth((current) => current === width ? current : width);
      }}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>PLAN CONTROL · {host.label}</Text>
            <Text style={styles.title}>Coding Plans</Text>
          </View>
          <View style={styles.headerActions}>
            <Button
              label={usageQuery.isFetching ? "刷新中..." : "刷新用量"}
              onPress={() => void usageQuery.refetch()}
              styles={styles}
              disabled={usageQuery.isFetching || !dashboard?.plans.length}
            />
            <Button
              label="添加 Plan"
              onPress={() => {
                setConfirmDeleteId(null);
                setApplyDraft(null);
                setEditor(emptyEditor("codex", dashboard));
              }}
              styles={styles}
              primary
              disabled={actionsBusy}
            />
          </View>
        </View>

        {dashboard ? (
          <View style={styles.stats}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{dashboard.plans.length}</Text>
              <Text style={styles.statLabel}>已管理 Plan</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{activeCount}</Text>
              <Text style={styles.statLabel}>当前已投影 Plan</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{toolsInstalled}/3</Text>
              <Text style={styles.statLabel}>检测到的编码工具</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>60s</Text>
              <Text style={styles.statLabel}>自动刷新间隔</Text>
            </View>
          </View>
        ) : null}

        {notice ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${notice.message}。点击关闭通知`}
            onPress={() => setNotice(null)}
            style={[styles.notice, notice.kind === "error" && styles.noticeError]}
          >
            <Text style={styles.noticeText}>{notice.message}</Text>
            {notice.details?.map((detail) => <Text key={detail} style={styles.noticeDetail}>{detail}</Text>)}
          </Pressable>
        ) : null}

        {usageError ? (
          <View style={[styles.notice, styles.noticeError]}>
            <Text style={styles.noticeText}>用量轮询失败，当前显示缓存数据。</Text>
            <Text style={styles.noticeDetail}>{usageError}</Text>
          </View>
        ) : null}

        {editor && !editor.id ? (
          <PlanEditor
            editor={editor}
            setEditor={setEditor}
            saving={saving}
            styles={styles}
            placeholderColor={theme.colors.foregroundMuted}
            onSave={submitEditor}
            onCancel={() => setEditor(null)}
          />
        ) : null}

        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.sectionTitle}>额度总览</Text>
            <Text style={styles.sectionMeta}>
              {usageQuery.dataUpdatedAt
                ? `最近轮询 ${new Date(usageQuery.dataUpdatedAt).toLocaleTimeString("zh-CN")}`
                : "尚未轮询"}
            </Text>
          </View>
          {usageQuery.isFetching ? <ActivityIndicator color={theme.colors.accent} /> : null}
        </View>

        {loading ? (
          <View style={styles.empty}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text style={styles.muted}>正在读取 daemon 上的 Coding Plans...</Text>
          </View>
        ) : dashboardQuery.error ? (
          <View style={styles.empty}>
            <Text style={styles.error}>{errorMessage(dashboardQuery.error)}</Text>
          </View>
        ) : dashboard?.plans.length ? (
          <View style={styles.cards}>
            {dashboard.plans.map((plan) => {
              if (editor?.id === plan.id) {
                return (
                  <PlanEditor
                    key={plan.id}
                    editor={editor}
                    setEditor={setEditor}
                    saving={saving}
                    styles={styles}
                    placeholderColor={theme.colors.foregroundMuted}
                    onSave={submitEditor}
                    onCancel={() => setEditor(null)}
                    embedded
                  />
                );
              }
              const applying = applyMutation.isPending && applyMutation.variables?.planId === plan.id
                ? applyMutation.variables.target
                : undefined;
              return (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  usage={usageByPlan.get(plan.id)}
                  dashboard={dashboard}
                  styles={styles}
                  applying={applying}
                  applyDraft={applyDraft?.planId === plan.id ? applyDraft : undefined}
                  actionsDisabled={actionsBusy}
                  confirmDelete={confirmDeleteId === plan.id}
                  placeholderColor={theme.colors.foregroundMuted}
                  iconColor={theme.colors.foreground}
                  dangerColor={theme.colors.statusDanger}
                  onRequestApply={(target) => {
                    setEditor(null);
                    setConfirmDeleteId(null);
                    setApplyDraft({
                      planId: plan.id,
                      target,
                      models: [defaultModelFor(plan.provider, target)],
                      customModel: "",
                      pickerOpen: true,
                    });
                  }}
                  onChangeApplyDraft={setApplyDraft}
                  onConfirmApply={() => {
                    if (applyDraft?.planId === plan.id) {
                      applyMutation.mutate({
                        planId: applyDraft.planId,
                        target: applyDraft.target,
                        models: applyDraft.models,
                      });
                    }
                  }}
                  onCancelApply={() => setApplyDraft(null)}
                  onEdit={() => {
                    setConfirmDeleteId(null);
                    setApplyDraft(null);
                    setEditor(editorFor(plan, dashboard));
                  }}
                  onDelete={() => requestDelete(plan.id)}
                />
              );
            })}
          </View>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>还没有 Coding Plan</Text>
            <Text style={styles.muted}>导入 Codex auth.json，或添加智谱 / Kimi Coding API Key。</Text>
            <View style={styles.row}>
              <Button label="导入 Codex" onPress={() => setEditor(emptyEditor("codex", dashboard))} styles={styles} primary disabled={actionsBusy} />
              <Button label="添加智谱" onPress={() => setEditor(emptyEditor("zhipu", dashboard))} styles={styles} disabled={actionsBusy} />
              <Button label="添加 Kimi" onPress={() => setEditor(emptyEditor("kimi", dashboard))} styles={styles} disabled={actionsBusy} />
            </View>
          </View>
        )}

        {dashboard ? (
          <View style={styles.footer}>
            <Text style={styles.footerText}>插件数据：{dashboard.storagePath}</Text>
            <Text style={styles.footerText}>
              Codex / Claude Code 配置功能已实现但未经本机端到端测试。插件不会安装任何 CLI；未检测到工具时只会按你的按钮操作写入配置。
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
