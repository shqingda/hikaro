import { useColorScheme } from "react-native";
import { router } from "expo-router";
import { useMobileSelector } from "@/provider";
import { Page, Section, Note, Action, confirmConnectionRemoval } from "@/ui";
import { NotificationSettings } from "@/notification-settings";

export default function Settings() {
  useColorScheme();
  const { controller, state } = useMobileSelector((s) => ({
    phase: s.phase,
    relay: s.relay,
    deviceId: s.deviceId,
    cacheClear: s.cacheClear,
  }));
  return (
    <Page>
      <Section title="这台电脑">
        <Note>{state.phase === "connected" ? "已连接" : "尚未连接"}</Note>
        {state.relay && <Note>{state.relay}</Note>}
        {state.deviceId && <Note>设备 ID：{state.deviceId}</Note>}
        <Action
          title={state.phase === "connected" ? "查看任务" : "连接电脑"}
          quiet
          onPress={() =>
            router.push(state.phase === "connected" ? "/tasks" : "/")
          }
        />
        {state.deviceId && (
          <Action
            title="移除这台电脑的连接"
            quiet
            onPress={() => confirmConnectionRemoval(controller)}
          />
        )}
      </Section>
      <Section title="本机存储">
        <Note>
          缓存最近查看的一页消息。图片和完整附件不缓存；清理保留未发送草稿和电脑记录。
        </Note>
        <Action
          title={
            state.cacheClear === "clearing"
              ? "正在清除…"
              : state.cacheClear === "failed"
                ? "重试清除缓存"
                : "清除本机历史缓存"
          }
          quiet
          disabled={state.cacheClear === "clearing"}
          onPress={() => {
            void controller.clearHistoryCache().catch(() => {});
          }}
        />
        {state.cacheClear === "cleared" && <Note>已清除本机历史缓存。</Note>}
        {state.cacheClear === "failed" && <Note error>清除失败，请重试。</Note>}
      </Section>
      <Section title="任务通知">
        <Note>
          推送配置与真机收件验收暂缓，当前尚未确认可用。已有通知设置可在下方管理。
        </Note>
        <NotificationSettings />
      </Section>
    </Page>
  );
}
