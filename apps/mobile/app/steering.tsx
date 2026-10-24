import { useEffect, useState } from "react";
import { Alert, ScrollView, View, Text, TextInput } from "react-native";
import { router, useNavigation, usePreventRemove } from "expo-router";
import { useMobile } from "@/provider";
import { Action, Note } from "@/ui";
import { colors, readable } from "@/theme";
import type { SteeringAction } from "@/steering";

const labels: Record<SteeringAction, string> = {
  edit: "保存修改",
  first: "移到最前",
  remove: "删除这条指令",
  resume: "确认恢复这条指令",
};
export default function Steering() {
  const { controller, state } = useMobile();
  const manager = controller.steering,
    queue = state.steering,
    item = queue.detail;
  const navigation = useNavigation();
  const [checkingReceipts, setCheckingReceipts] = useState(false);
  useEffect(() => {
    setCheckingReceipts(false);
  }, [item?.id, queue.error]);
  const dirty = !!item && queue.editText !== (item.editText ?? "");
  useEffect(() => {
    const release = navigation.addListener("removed", () => {
      void manager.close();
    });
    return () => queueMicrotask(release);
  }, [navigation, manager]);
  usePreventRemove(dirty && state.phase === "connected", ({ repeat }) => {
    Alert.alert("放弃尚未保存的修改？", "电脑上的原指令保持原样。", [
      { text: "继续编辑", style: "cancel" },
      {
        text: "放弃修改",
        style: "destructive",
        onPress: () => {
          manager.dismissDetail();
          repeat();
        },
      },
    ]);
  });
  useEffect(() => {
    if (["unpaired", "revoked", "review"].includes(state.phase))
      router.replace("/");
  }, [state.phase]);
  const confirmDiscard = (run: () => void) => {
    if (!dirty) return run();
    Alert.alert("放弃尚未保存的修改？", "电脑上的原指令保持原样。", [
      { text: "继续编辑", style: "cancel" },
      { text: "放弃修改", style: "destructive", onPress: run },
    ]);
  };
  const act = (action: SteeringAction) => {
    if (!item) return;
    const run = () => {
      void manager.act(item.id, action).catch(() => {});
    };
    if (action === "remove" || action === "resume")
      Alert.alert(
        labels[action],
        action === "remove"
          ? "删除后不会应用这条指令。"
          : "只能由最初提交的设备身份确认。指令将用于下一模型轮，不会启动新任务。",
        [
          { text: "返回", style: "cancel" },
          {
            text: "确认",
            style: action === "remove" ? "destructive" : "default",
            onPress: run,
          },
        ],
      );
    else run();
  };
  const busy = queue.loading || queue.pending;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 24, gap: 18, paddingBottom: 48 }}
      style={{ backgroundColor: colors.background }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: colors.label, fontSize: 23 }}
      >
        {readable(state.session?.title ?? "补充指令")}
      </Text>
      <Note>
        {queue.holding
          ? "管理期间暂停待发消息与补充指令的处理，关闭后继续。"
          : "管理锁已释放或失效，请恢复连接后重新打开。"}
      </Note>
      <Note>
        断线后电脑最多在 15 秒内释放管理锁。未确认的恢复项仍不会自动应用。
      </Note>
      {queue.error && <Note error>{queue.error}</Note>}
      {queue.notice && <Note>{queue.notice}</Note>}
      {busy && (
        <Note>{queue.pending ? "正在等待电脑确认…" : "正在读取队列…"}</Note>
      )}
      {!queue.holding ? (
        <Action
          title="重新打开队列"
          disabled={!queue.available || busy}
          onPress={() =>
            confirmDiscard(() => {
              void manager
                .close()
                .then(() => {
                  if (state.session) return manager.open(state.session.id);
                })
                .catch(() => {});
            })
          }
        />
      ) : item ? (
        <View style={{ gap: 16 }}>
          <Note>
            {item.actions.some((a) => a.value === "resume")
              ? "中断后恢复 · 需要原设备确认"
              : "等待下一模型轮"}
          </Note>
          {/* Expo UI currently wraps a SwiftUI TextField whose Return ends editing. */}
          <TextInput
            key={item.id}
            testID="steering-editor"
            accessibilityLabel="补充指令正文"
            accessibilityHint="回车换行。点击保存修改后才更新电脑队列。"
            value={queue.editText}
            multiline
            submitBehavior="newline"
            textAlignVertical="top"
            placeholderTextColor={colors.secondary}
            numberOfLines={6}
            maxLength={100000}
            editable={!busy}
            onChangeText={(text) => {
              try {
                manager.edit(text);
              } catch {
                // Keep the controller value when editing is no longer allowed.
              }
            }}
            style={{
              height: 220,
              padding: 16,
              borderRadius: 14,
              backgroundColor: colors.panel,
              color: colors.label,
              fontSize: 17,
            }}
          />
          <Note>编辑尚未自动保存，点击“保存修改”后才更新电脑队列。</Note>
          {(["edit", "first", "remove", "resume"] as const)
            .filter((action) => item.actions.some((a) => a.value === action))
            .map((action) => (
              <Action
                key={action}
                title={labels[action]}
                quiet={action !== "edit"}
                disabled={
                  busy ||
                  !!queue.error ||
                  (action === "edit" && !queue.editText.trim()) ||
                  (dirty && action !== "edit" && action !== "remove")
                }
                onPress={() => act(action)}
              />
            ))}
          {queue.error && (
            <Action
              title="核对回执"
              quiet
              disabled={state.phase !== "connected" || !!state.actionPending}
              onPress={() => {
                setCheckingReceipts(true);
                void controller.reconcileActions().catch(() => {});
              }}
            />
          )}
          {queue.error && checkingReceipts && state.actionNotice && (
            <Note>{state.actionNotice}</Note>
          )}
          {queue.error && (
            <Action
              title="重新读取这条指令"
              quiet
              disabled={busy}
              onPress={() =>
                confirmDiscard(() => {
                  void manager.inspect(item.id).catch(() => {});
                })
              }
            />
          )}
          <Action
            title="返回队列"
            quiet
            disabled={busy}
            onPress={() => confirmDiscard(() => manager.dismissDetail())}
          />
        </View>
      ) : (
        <>
          {!queue.loading && !queue.items.length && (
            <Note>没有待处理的补充指令。</Note>
          )}
          {queue.items.map((entry) => (
            <View key={entry.id} style={{ gap: 6 }}>
              <Note>
                {entry.actions.some((a) => a.value === "resume")
                  ? "等待恢复确认"
                  : "等待下一模型轮"}
              </Note>
              <Action
                title={readable(entry.title)}
                quiet
                disabled={busy}
                onPress={() => {
                  void manager.inspect(entry.id).catch(() => {});
                }}
              />
            </View>
          ))}
          <Action
            title="刷新队列"
            quiet
            disabled={busy}
            onPress={() => {
              void manager.refresh().catch(() => {});
            }}
          />
        </>
      )}
      <Action
        title="关闭并返回任务"
        quiet
        onPress={() => router.dismissTo("/task")}
      />
    </ScrollView>
  );
}
