import { View, Text, Alert, TextInput } from "react-native";
import { useMobileSelector } from "./provider";
import { Action, Note } from "./ui";
import { colors } from "./theme";
import { router } from "expo-router";

export function Composer() {
  const { controller, state } = useMobileSelector((s) => ({
    phase: s.phase,
    canSend: s.canSend,
    canSteer: s.canSteer,
    busy: s.busy,
    steering: s.steering,
    session: s.session,
    composer: s.composer,
  }));
  const draft = state.composer;
  const record = draft.record;
  if (!record) return draft.loading ? <Note>正在读取草稿…</Note> : null;
  const matches = record.session.id === state.session?.id;
  const editable = matches && !draft.loading && !record.submission;
  return (
    <View style={{ gap: 12 }}>
      <Text
        accessibilityRole="header"
        style={{ color: colors.label, fontSize: 18 }}
      >
        你的要求
      </Text>
      {!matches && <Note>下方是切换前尚未保存的草稿，请先重试保存。</Note>}
      {/* Expo UI currently wraps a SwiftUI TextField whose Return ends editing.
          The native field owns typed text; echoing each saved value back while
          typing fast can overwrite keys. Remount only when the draft is replaced. */}
      <TextInput
        key={`${record.session.id}:${record.submission?.id ?? ""}`}
        testID="task-composer"
        accessibilityLabel="任务要求"
        accessibilityHint="回车换行。点击发送、加入待发队列或补充到下一模型轮才会提交。"
        defaultValue={record.text}
        multiline
        submitBehavior="newline"
        textAlignVertical="top"
        placeholderTextColor={colors.secondary}
        numberOfLines={5}
        editable={editable}
        maxLength={100000}
        placeholder="输入要求，回车换行"
        onChangeText={(text) => {
          if (!editable) return;
          try {
            controller.editDraft(record.session.id, text);
          } catch {
            // Keep the controller value when editing is no longer allowed.
          }
        }}
        style={{
          padding: 16,
          borderRadius: 14,
          backgroundColor: colors.panel,
          color: colors.label,
          fontSize: 17,
          height: 160,
        }}
      />
      <Note>
        {draft.saving
          ? "正在保存草稿…"
          : draft.error
            ? "草稿尚未保存"
            : "草稿已保存在本机"}
        {state.phase !== "connected" ? " · 离线编辑，重连不会自动发送" : ""}
      </Note>
      {draft.error && (
        <>
          <Note error>{draft.error}</Note>
          <Action
            title="重试保存草稿"
            quiet
            onPress={() => {
              void controller.saveDraft().catch(() => {});
            }}
          />
        </>
      )}
      {record.submission ? (
        <>
          <Note>
            {draft.sending
              ? "正在发送，原文保留至电脑确认接收。"
              : "这次发送的结果待核对，原文已保留。不会自动重发；失败也可能已经执行了部分操作。"}
          </Note>
          <Action
            title="核对发送结果"
            quiet
            disabled={draft.sending || state.phase !== "connected"}
            onPress={() => {
              void controller.reconcileDraft().catch(() => {});
            }}
          />
          <Action
            title="恢复为可编辑草稿"
            quiet
            disabled={draft.sending || draft.loading}
            onPress={() => {
              Alert.alert(
                "确认已检查电脑记录？",
                "之前的要求可能已经执行。恢复后再次点击发送可能重复执行，请先检查任务记录。",
                [
                  { text: "返回", style: "cancel" },
                  {
                    text: "已核对，恢复草稿",
                    onPress: () => {
                      void controller
                        .restoreDraft(record.session.id)
                        .catch(() => {});
                    },
                  },
                ],
              );
            }}
          />
        </>
      ) : (
        <>
          <Action
            title={state.busy ? "加入待发队列" : "发送"}
            testID="send-prompt"
            disabled={
              !state.canSend ||
              !matches ||
              !record.text.trim() ||
              draft.loading ||
              !!draft.error
            }
            onPress={() => {
              void controller.sendDraft(record.session.id).catch(() => {});
            }}
          />
          {state.busy && <Note>这条要求将在当前运行结束后执行。</Note>}
          {state.canSteer && (
            <>
              <Action
                title="补充到下一模型轮"
                quiet
                disabled={
                  !matches ||
                  !record.text.trim() ||
                  draft.loading ||
                  !!draft.error
                }
                onPress={() => {
                  void controller
                    .sendDraft(record.session.id, "steer")
                    .catch(() => {});
                }}
              />
              <Note>补充指令用于下一次模型推理，本身不会启动新任务。</Note>
            </>
          )}
          {state.phase === "connected" && !state.canSend && (
            <Note>发送需要当前任务的控制权限及支持发送回执的电脑版本。</Note>
          )}
        </>
      )}
      {state.steering.available && (
        <Action
          title="补充指令队列"
          quiet
          onPress={() => {
            void controller.steering.open(record.session.id).catch(() => {});
            router.push("/steering");
          }}
        />
      )}
    </View>
  );
}
