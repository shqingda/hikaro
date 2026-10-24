import { useEffect } from "react";
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
          {progress.steps.map((step, index) => (
            <View
              key={index}
              accessible
              accessibilityLabel={`第 ${index + 1} 步，${labels[step.status]}：${readable(step.text)}${step.note ? `。备注：${readable(step.note)}` : ""}`}
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
              {step.note && (
                <Text selectable style={{ color: colors.secondary }}>
                  {readable(step.note)}
                </Text>
              )}
            </View>
          ))}
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
