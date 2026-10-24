import type { StepEvidence } from "../../../packages/core/src/change-evidence.ts";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { router, useNavigation } from "expo-router";
import { useMobile } from "@/provider";
import { Action, Note } from "@/ui";
import { colors, readable } from "@/theme";

const labels = {
  pending: "未开始",
  in_progress: "进行中",
  completed: "已完成",
  blocked: "受阻",
  skipped: "已跳过",
} as const;

export default function Plan() {
  const { controller, state } = useMobile();
  const navigation = useNavigation();
  const plan = state.plan;
  const online = state.phase === "connected";
  useEffect(() => {
    const release = navigation.addListener("removed", () =>
      controller.closePlan(),
    );
    // Router emits removed after unmount, so retain the listener through cleanup.
    return () => queueMicrotask(release);
  }, [navigation, controller]);
  useEffect(() => {
    if (["unpaired", "revoked", "review"].includes(state.phase))
      router.replace("/");
    else if (online && !plan) router.dismissTo("/task");
  }, [state.phase, online, plan]);
  const progress = plan?.status === "ready" ? plan.progress : undefined;
  const done =
    progress?.steps.filter((step) => step.status === "completed").length ?? 0;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: 48 }}
      style={{ backgroundColor: colors.background }}
    >
      <Note>
        状态由模型在执行中报告，不代表已经验证。实际结果请查看文件修改和测试输出。此页只读。
      </Note>
      {!online && <Note>连接已变化，请恢复连接后重新打开。</Note>}
      {plan?.status === "loading" && (
        <ActivityIndicator accessibilityLabel="正在读取计划进度" />
      )}
      {plan?.status === "none" && (
        <Note>这个任务目前没有正在执行的已批准计划。</Note>
      )}
      {plan?.status === "unsupported" && (
        <Note>电脑端版本较旧，不提供计划进度。升级电脑端后重试。</Note>
      )}
      {plan?.status === "error" && (
        <Note error>无法读取计划进度。请检查查看授权或重试。</Note>
      )}
      {progress && (
        <>
          <Text
            selectable
            accessibilityRole="header"
            style={{ color: colors.label, fontSize: 23 }}
          >
            {readable(progress.title)}
          </Text>
          <Note>{`模型报告已完成 ${done}/${progress.steps.length} 步`}</Note>
          {progress.recordedEdits !== undefined && (
            <Note>{`批准后实际记录到 ${progress.recordedEdits} 次文件修改，可在“查看文件修改”核对。`}</Note>
          )}
          {progress.evidenceIncomplete && (
            <Note>执行证据列表不完整，请结合文件修改和会话历史核对。</Note>
          )}
          {progress.steps.map((step, index) => (
            <View
              key={index}
              style={{
                padding: 16,
                gap: 6,
                borderRadius: 14,
                backgroundColor: colors.panel,
              }}
            >
              <Text style={{ color: colors.secondary }}>
                {`第 ${index + 1} 步 · ${labels[step.status]}`}
              </Text>
              <Text selectable style={{ color: colors.label, fontSize: 16 }}>
                {readable(step.text)}
              </Text>
              {step.evidence && (
                <Evidence
                  evidence={step.evidence}
                  step={index + 1}
                  planId={progress.planId}
                  online={online}
                />
              )}
              {step.note && (
                <Text selectable style={{ color: colors.secondary }}>
                  {readable(step.note)}
                </Text>
              )}
            </View>
          ))}
          {progress.unassigned && (
            <View style={{ gap: 8 }}>
              <Note>未关联步骤（没有唯一进行中步骤）</Note>
              <Evidence
                evidence={progress.unassigned}
                step={0}
                planId={progress.planId}
                online={online}
              />
            </View>
          )}
        </>
      )}
      <Action
        title="刷新"
        quiet
        disabled={!online || plan?.status === "loading"}
        onPress={() => void controller.readPlanProgress().catch(() => {})}
      />
    </ScrollView>
  );
}

function Evidence({
  evidence,
  step,
  planId,
  online,
}: {
  evidence: StepEvidence;
  step: number;
  planId: string;
  online: boolean;
}) {
  const { controller } = useMobile();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Note>{`执行证据：${evidence.reliable} 次可靠修改，${evidence.observed} 次观察差异，${evidence.tools.length} 项工具结果。零修改不代表失败。`}</Note>
      <Action
        title="查看这一步的文件修改"
        quiet
        disabled={!online}
        onPress={() => {
          void controller.inspection
            .listChanges(0, { planId, step })
            .catch(() => {});
          router.push("/changes");
        }}
      />
      {!!evidence.tools.length && (
        <Action
          title={expanded ? "收起工具结果" : "查看工具结果"}
          quiet
          onPress={() => setExpanded(!expanded)}
        />
      )}
      {expanded &&
        evidence.tools.map((tool) => (
          <View key={`${tool.sessionId}:${tool.seq}`} style={{ gap: 6 }}>
            <Note>{`${tool.name} · ${tool.status} · ${tool.sessionId.slice(0, 8)}\n${readable(tool.preview)}`}</Note>
            {tool.status !== "unknown" && (
              <Action
                title={`阅读 ${tool.name} 输出`}
                quiet
                disabled={!online}
                onPress={() => {
                  void controller
                    .readMessage(tool.seq, 0, "text", {
                      owner: tool.sessionId,
                      planId,
                    })
                    .catch(() => {});
                  router.push("/message");
                }}
              />
            )}
          </View>
        ))}
    </View>
  );
}
