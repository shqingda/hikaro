import { useEffect } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { router, useNavigation } from "expo-router";
import { useMobile } from "@/provider";
import { Action, Note } from "@/ui";
import { colors, readable } from "@/theme";
import type { MobileBackgroundItem } from "@/controller";

function Section({
  title,
  items,
  empty,
}: {
  title: string;
  items: MobileBackgroundItem[];
  empty: string;
}) {
  return (
    <View style={{ gap: 10 }}>
      <Text
        accessibilityRole="header"
        style={{ color: colors.label, fontSize: 20 }}
      >
        {title}
      </Text>
      {items.length === 0 && <Note>{empty}</Note>}
      {items.map((item) => (
        <View
          key={item.id}
          accessible
          accessibilityLabel={`${readable(item.title.trim())}，${item.state}`}
          style={{
            padding: 16,
            gap: 6,
            borderRadius: 14,
            backgroundColor: colors.panel,
          }}
        >
          <Text selectable style={{ color: colors.label, fontSize: 16 }}>
            {readable(item.title)}
          </Text>
          <Text style={{ color: colors.secondary }}>{item.state}</Text>
        </View>
      ))}
    </View>
  );
}

export default function Background() {
  const { controller, state } = useMobile();
  const navigation = useNavigation();
  const background = state.background;
  const online = state.phase === "connected";
  useEffect(() => {
    const release = navigation.addListener("removed", () =>
      controller.closeBackground(),
    );
    // Router emits removed after unmount, so retain the listener through cleanup.
    return () => queueMicrotask(release);
  }, [navigation, controller]);
  useEffect(() => {
    if (["unpaired", "revoked", "review"].includes(state.phase))
      router.replace("/");
    else if (online && !background) router.dismissTo("/task");
  }, [state.phase, online, background]);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 48 }}
      style={{ backgroundColor: colors.background }}
    >
      <Note>
        只读查看电脑上的子 agent 与后台终端。停止或输入请在电脑端 /tasks
        操作。电脑重启后，未确认结束的记录显示为中断或状态未知。
      </Note>
      {!online && <Note>连接已变化，请恢复连接后重新打开。</Note>}
      {background?.status === "loading" && (
        <ActivityIndicator accessibilityLabel="正在读取后台任务" />
      )}
      {background?.status === "error" && (
        <Note error>无法读取后台任务。请检查查看授权或重试。</Note>
      )}
      {background?.status === "ready" && (
        <>
          <Section
            title="子 agent"
            items={background.children}
            empty="没有子 agent 记录。"
          />
          <Section
            title="后台终端"
            items={background.terminals}
            empty="没有后台终端记录。"
          />
        </>
      )}
      <Action
        title="刷新"
        quiet
        disabled={!online || background?.status === "loading"}
        onPress={() => void controller.readBackground().catch(() => {})}
      />
    </ScrollView>
  );
}
