import { useEffect } from "react";
import { View, Text, Alert } from "react-native";
import { Host, TextInput, useNativeState } from "@expo/ui";
import { useMobile } from "./provider";
import { Action, Note } from "./ui";
import { colors } from "./theme";

export function Composer() {
  const { controller, state } = useMobile();
  const draft = state.composer;
  const record = draft.record;
  const input = useNativeState(record?.text ?? "");
  useEffect(() => {
    if (input.value !== (record?.text ?? "")) input.value = record?.text ?? "";
  }, [input, record?.text]);
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
      <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
        <TextInput
          key={record.session.id}
          testID="task-composer"
          value={input}
          multiline
          numberOfLines={5}
          editable={editable}
          maxLength={100000}
          placeholder="输入要求，回车换行"
          onChangeText={(text) => {
            if (!editable) return;
            try {
              controller.editDraft(record.session.id, text);
            } catch {
              input.value = record.text;
            }
          }}
          style={{
            padding: 16,
            borderRadius: 14,
            backgroundColor: colors.panel,
            height: 160,
          }}
        />
      </Host>
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
          {state.phase === "connected" && !state.canSend && (
            <Note>发送需要当前任务的控制权限及支持发送回执的电脑版本。</Note>
          )}
        </>
      )}
    </View>
  );
}
