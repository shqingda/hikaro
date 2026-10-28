import { useColorScheme } from "react-native";
import { useEffect } from "react";
import { router } from "expo-router";
import { useMobileSelector } from "@/provider";
import { Page, Section, NavRow, Note } from "@/ui";
import { TaskActions } from "@/task-actions";
import { readable } from "@/theme";

export default function Tools() {
  useColorScheme();
  const { controller, state } = useMobileSelector((s) => ({
    phase: s.phase,
    session: s.session,
    inspection: s.inspection,
    steering: s.steering,
  }));
  const online = state.phase === "connected";
  useEffect(() => {
    if (["unpaired", "revoked", "review"].includes(state.phase))
      router.replace("/");
    else if (!state.session) router.replace("/tasks");
  }, [state.phase, state.session]);
  return (
    <Page>
      <Note>
        {readable(state.session?.title ?? "当前任务")}
        {!online ? " · 离线，恢复连接后可读取详情" : ""}
      </Note>
      <Section title="查看任务">
        <NavRow
          title="重新读取最新消息"
          detail="刷新电脑上的任务正文"
          disabled={!online}
          onPress={() => {
            void controller
              .history("latest")
              .then(() => router.dismissTo("/task"))
              .catch(() => {});
          }}
        />
        <NavRow
          title="搜索消息"
          detail="查找当前任务的完整消息"
          disabled={!online || !state.inspection.canSearch}
          onPress={() => router.push("/search")}
        />
        <NavRow
          title="计划进度"
          disabled={!online}
          onPress={() => {
            void controller.readPlanProgress().catch(() => {});
            router.push("/plan");
          }}
        />
        <NavRow
          title="文件修改"
          detail={
            !state.inspection.canChanges
              ? "需要支持差异阅读的电脑版本"
              : "阅读修改与执行证据"
          }
          disabled={!online || !state.inspection.canChanges}
          onPress={() => {
            void controller.inspection.listChanges().catch(() => {});
            router.push("/changes");
          }}
        />
        <NavRow
          title="后台任务"
          disabled={!online}
          onPress={() => {
            void controller.readBackground().catch(() => {});
            router.push("/background");
          }}
        />
        <NavRow
          title="补充指令队列"
          detail="查看、编辑与恢复待处理的补充指令"
          disabled={!online || !state.steering.available}
          onPress={() => {
            if (state.session) {
              void controller.steering.open(state.session.id).catch(() => {});
              router.push("/steering");
            }
          }}
        />
      </Section>
      <Section title="操作记录">
        <TaskActions receiptsOnly />
      </Section>
    </Page>
  );
}
