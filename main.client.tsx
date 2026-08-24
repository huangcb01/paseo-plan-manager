import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin";
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
  type ApplyPlanResult,
  type Dashboard,
  type Plan,
  type Provider,
  type SavePlanInput,
  type Target,
  type TargetModels,
  type UsageSnapshot,
  type UsageWindow,
  type ZhipuRegion,
} from "./plans.shared";

interface EditorState {
  id?: string;
  provider: Provider;
  label: string;
  region: ZhipuRegion;
  authFilePath: string;
  accountId: string;
  apiKey: string;
  models: TargetModels;
}

interface NoticeState {
  kind: "success" | "error";
  message: string;
  details?: string[];
}

const PROVIDER_LABELS: Record<Provider, string> = {
  codex: "Codex / ChatGPT",
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

function modelsFor(provider: Provider): TargetModels {
  if (provider === "codex") {
    return { opencode: "gpt-5.6-sol", codex: "gpt-5.6-sol", claude: "gpt-5.6-sol" };
  }
  if (provider === "zhipu") {
    return { opencode: "glm-5.1", codex: "glm-5.3", claude: "glm-5.1" };
  }
  return { opencode: "kimi-for-coding", codex: "kimi-for-coding", claude: "kimi-for-coding" };
}

function emptyEditor(provider: Provider, dashboard?: Dashboard): EditorState {
  return {
    provider,
    label: "",
    region: "cn",
    authFilePath: provider === "codex" ? dashboard?.defaultPaths.codexAuth ?? "~/.codex/auth.json" : "",
    accountId: "",
    apiKey: "",
    models: modelsFor(provider),
  };
}

function editorFor(plan: Plan): EditorState {
  return {
    id: plan.id,
    provider: plan.provider,
    label: plan.label,
    region: plan.region ?? "cn",
    authFilePath: plan.authFilePath ?? "",
    accountId: plan.accountId ?? "",
    apiKey: "",
    models: plan.models,
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

function createStyles(theme: PluginSurfaceProps["theme"], compact: boolean) {
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
      flexDirection: compact ? "column" : "row",
      alignItems: compact ? "stretch" : "flex-end",
      justifyContent: "space-between",
      gap: 14,
      paddingBottom: 18,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.foregroundMuted,
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
    subtitle: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      marginTop: 5,
      maxWidth: 680,
      lineHeight: 19,
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
      gap: 8,
    },
    button: {
      minHeight: 44,
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      paddingHorizontal: 13,
      paddingVertical: 8,
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
      minWidth: compact ? "47%" : 150,
      flexGrow: 1,
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
    callout: {
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      padding: 12,
      gap: 4,
    },
    calloutTitle: {
      color: theme.colors.foreground,
      fontWeight: "700",
      fontSize: 12,
    },
    calloutText: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      lineHeight: 17,
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
      width: compact ? "100%" : "49%",
      minWidth: compact ? 0 : 390,
      flexGrow: 1,
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
      gap: 2,
    },
    cardTitle: {
      color: theme.colors.foreground,
      fontSize: 16,
      fontWeight: "800",
    },
    cardMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
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
    editorTitle: {
      color: theme.colors.foreground,
      fontSize: 17,
      fontWeight: "800",
    },
    providerPicker: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 7,
    },
    providerOption: {
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted,
      paddingHorizontal: 11,
      paddingVertical: 8,
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
      flexWrap: "wrap",
      gap: 11,
    },
    field: {
      minWidth: compact ? "100%" : 260,
      flexGrow: 1,
      flexBasis: compact ? "100%" : "31%",
      gap: 5,
    },
    fieldWide: {
      flexBasis: compact ? "100%" : "64%",
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

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  styles,
  placeholderColor,
  secure = false,
  wide = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  styles: Styles;
  placeholderColor: string;
  secure?: boolean;
  wide?: boolean;
}) {
  return (
    <View style={[styles.field, wide && styles.fieldWide]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={placeholderColor}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
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

function PlanCard({
  plan,
  usage,
  dashboard,
  styles,
  applying,
  actionsDisabled,
  confirmDelete,
  onApply,
  onEdit,
  onDelete,
}: {
  plan: Plan;
  usage?: UsageSnapshot;
  dashboard: Dashboard;
  styles: Styles;
  applying?: Target;
  actionsDisabled: boolean;
  confirmDelete: boolean;
  onApply: (target: Target) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const activeTargets = (["opencode", "codex", "claude"] as const).filter(
    (target) => dashboard.activeTargets[target] === plan.id,
  );
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.providerMark}>
          <Text style={styles.providerMarkText}>{PROVIDER_MARKS[plan.provider]}</Text>
        </View>
        <View style={styles.cardHeading}>
          <Text style={styles.cardTitle}>{plan.label}</Text>
          <Text style={styles.cardMeta}>{PROVIDER_LABELS[plan.provider]} · {plan.credentialHint}</Text>
          {usage?.planTier ? <Text style={styles.tier}>{usage.planTier}</Text> : null}
        </View>
        {usage?.stale ? <Text style={styles.cardMeta}>STALE</Text> : null}
      </View>

      <View style={styles.row}>
        {(["opencode", "codex", "claude"] as const).map((target) => {
          const active = activeTargets.includes(target);
          return (
            <View key={target} style={[styles.targetBadge, active && styles.targetBadgeActive]}>
              <Text style={[styles.targetBadgeText, active && styles.targetBadgeTextActive]}>
                {active ? "ACTIVE · " : ""}{TARGET_LABELS[target]}
              </Text>
            </View>
          );
        })}
      </View>

      {usage?.windows.length ? (
        <View style={styles.quotaList}>
          {usage.windows.map((window) => <Quota key={window.id} window={window} styles={styles} />)}
        </View>
      ) : (
        <Text style={styles.muted}>{usage?.status === "error" ? "没有可显示的缓存用量。" : "等待首次用量刷新。"}</Text>
      )}
      {usage?.parallelLimit ? <Text style={styles.muted}>并发上限 {usage.parallelLimit}</Text> : null}
      {usage?.balance ? <Text style={styles.muted}>Credits 余额 {usage.balance}</Text> : null}
      {usage?.error ? <Text style={styles.error}>{usage.error}</Text> : null}

      <View style={styles.row}>
        {(["opencode", "codex", "claude"] as const).map((target) => {
          const supported = isTargetSupported(plan, target);
          return (
            <Button
              key={target}
              label={applying === target
                ? "写入中..."
                : supported
                  ? `配置到 ${TARGET_LABELS[target]}`
                  : `${TARGET_LABELS[target]}（需代理）`}
              onPress={() => onApply(target)}
              styles={styles}
              primary={target === "opencode"}
              disabled={actionsDisabled || !supported}
            />
          );
        })}
      </View>
      <View style={styles.row}>
        <Button label="编辑 / 重新导入" onPress={onEdit} styles={styles} disabled={actionsDisabled} />
        <Button
          label={confirmDelete ? "再次点击确认删除" : "删除"}
          onPress={onDelete}
          styles={styles}
          danger={confirmDelete}
          disabled={actionsDisabled}
        />
      </View>
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
}: {
  editor: EditorState;
  setEditor: (next: EditorState) => void;
  saving: boolean;
  styles: Styles;
  placeholderColor: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  function selectProvider(provider: Provider) {
    if (editor.id) return;
    setEditor({ ...emptyEditor(provider), label: editor.label });
  }
  function setModel(target: Target, value: string) {
    setEditor({ ...editor, models: { ...editor.models, [target]: value } });
  }
  return (
    <View style={styles.editor}>
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
              accessibilityState={{ selected, disabled: Boolean(editor.id) }}
              disabled={Boolean(editor.id)}
              onPress={() => selectProvider(provider)}
              style={({ pressed }) => [
                styles.providerOption,
                selected && styles.providerOptionSelected,
                editor.id && !selected && styles.buttonDisabled,
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

      <View style={styles.fields}>
        <Field
          label="显示名称"
          value={editor.label}
          onChangeText={(label) => setEditor({ ...editor, label })}
          placeholder="例如：工作账号 Pro"
          styles={styles}
          placeholderColor={placeholderColor}
        />
        {editor.provider === "codex" ? (
          <>
            <Field
              label="Codex auth.json 路径"
              value={editor.authFilePath}
              onChangeText={(authFilePath) => setEditor({ ...editor, authFilePath })}
              placeholder="~/.codex/auth.json"
              styles={styles}
              placeholderColor={placeholderColor}
              wide
            />
            <Field
              label="ChatGPT Account ID（可选）"
              value={editor.accountId}
              onChangeText={(accountId) => setEditor({ ...editor, accountId })}
              placeholder="留空则从 token 读取"
              styles={styles}
              placeholderColor={placeholderColor}
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
          />
        )}
      </View>

      {editor.provider === "zhipu" ? (
        <View style={styles.field}>
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
                  accessibilityState={{ selected }}
                  onPress={() => setEditor({ ...editor, region })}
                  style={({ pressed }) => [
                    styles.providerOption,
                    selected && styles.providerOptionSelected,
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

      <View>
        <Text style={styles.sectionTitle}>目标模型</Text>
        <Text style={styles.muted}>每个工具可使用不同模型 ID；切换时覆盖该 provider 当前选择。</Text>
      </View>
      <View style={styles.fields}>
        <Field
          label="OpenCode model"
          value={editor.models.opencode}
          onChangeText={(value) => setModel("opencode", value)}
          styles={styles}
          placeholderColor={placeholderColor}
        />
        <Field
          label="Codex model"
          value={editor.models.codex}
          onChangeText={(value) => setModel("codex", value)}
          styles={styles}
          placeholderColor={placeholderColor}
        />
        <Field
          label="Claude Code model"
          value={editor.models.claude}
          onChangeText={(value) => setModel("claude", value)}
          styles={styles}
          placeholderColor={placeholderColor}
        />
      </View>
      <View style={styles.row}>
        <Button
          label={saving ? "保存中..." : editor.id ? "保存并重新导入凭据" : "保存 Plan"}
          onPress={onSave}
          styles={styles}
          primary
          disabled={saving || !editor.label.trim()}
        />
      </View>
    </View>
  );
}

export function MainSurface({ theme, host, layout }: PluginSurfaceProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const queryClient = useQueryClient();
  const dashboardRpc = useRpc(getDashboard) as (_input: Record<string, never>) => Promise<Dashboard>;
  const saveRpc = useRpc(savePlan) as (input: SavePlanInput) => Promise<Plan>;
  const deleteRpc = useRpc(deletePlan) as (input: { planId: string }) => Promise<{ deleted: boolean }>;
  const refreshRpc = useRpc(refreshUsage) as (input: { planId?: string }) => Promise<{ usage: UsageSnapshot[] }>;
  const applyRpc = useRpc(applyPlan) as (input: { planId: string; target: Target }) => Promise<ApplyPlanResult>;
  const queryKey = ["coding-plan-manager", host.id, "dashboard"] as const;
  const usageKey = ["coding-plan-manager", host.id, "usage"] as const;
  const [editor, setEditor] = useState<EditorState | null>(null);
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
    ? new Set(Object.values(dashboard.activeTargets).filter(Boolean)).size
    : 0;
  const actionsBusy = saving || deleteMutation.isPending || applyMutation.isPending;

  async function submitEditor() {
    if (!editor) return;
    const input: SavePlanInput = {
      ...(editor.id ? { id: editor.id } : {}),
      label: editor.label,
      provider: editor.provider,
      models: editor.models,
      ...(editor.provider === "zhipu" ? { region: editor.region } : {}),
      ...(editor.provider === "codex"
        ? { authFilePath: editor.authFilePath, accountId: editor.accountId || undefined }
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
    deleteMutation.mutate({ planId });
  }

  const loading = dashboardQuery.isPending;
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>PLAN CONTROL · {host.label}</Text>
            <Text style={styles.title}>Coding Plans</Text>
            <Text style={styles.subtitle}>
              多账号额度在一个界面中轮询，并把选中的 Plan 投影到本机编码工具。保存后的凭据只存放在 Paseo daemon 主机。
            </Text>
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

        {dashboard ? (
          <View style={styles.callout}>
            <Text style={styles.calloutTitle}>侧栏位置受 Paseo 插件 API 限制</Text>
            <Text style={styles.calloutText}>{dashboard.sidebarPlacement.message}</Text>
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

        {editor ? (
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
                  actionsDisabled={actionsBusy}
                  confirmDelete={confirmDeleteId === plan.id}
                  onApply={(target) => applyMutation.mutate({ planId: plan.id, target })}
                  onEdit={() => {
                    setConfirmDeleteId(null);
                    setEditor(editorFor(plan));
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
