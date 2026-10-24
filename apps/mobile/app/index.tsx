import { useEffect, useState } from "react";
import {
  ScrollView,
  View,
  Text,
  Keyboard,
  Platform,
  useColorScheme,
  ActivityIndicator,
} from "react-native";
import { TextInput, Host, useNativeState } from "@expo/ui";
import { router } from "expo-router";
import { useMobile } from "@/provider";
import { Action, Note, SunMark, confirmConnectionRemoval } from "@/ui";
import { colors } from "@/theme";
export default function Connect() {
  useColorScheme();
  const { controller, state } = useMobile();
  const value = useNativeState("");
  const [draft, setDraft] = useState(""),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (state.phase === "connected") router.replace("/tasks");
  }, [state.phase]);
  const pending = ["connecting", "restoring"].includes(state.phase);
  const review = () => {
    try {
      controller.review(draft.trim());
      value.value = "";
      setDraft("");
      setError(null);
      Keyboard.dismiss();
    } catch {
      setError("配对码无效或已过期。请从电脑重新生成，再扫描或粘贴。");
    }
  };
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="interactive"
      contentContainerStyle={{ padding: 24, gap: 24, paddingBottom: 64 }}
      style={{ backgroundColor: colors.background }}
    >
      <View style={{ gap: 16, paddingVertical: 12 }}>
        <SunMark />
        {/* The wordmark is decorative branding; cap scaling so it stays one word. */}
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={1.5}
          numberOfLines={1}
          style={{
            fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
            fontSize: 48,
            letterSpacing: -2,
            color: colors.label,
          }}
        >
          hikaro
        </Text>
        <Text style={{ fontSize: 22, lineHeight: 31, color: colors.label }}>
          {"任务留在电脑，\n进展随你同行。"}
        </Text>
        <Note>
          连接你自己的电脑，查看任务与输出。获得控制权限后，可以发送要求、审批和停止运行；离线时保留草稿。
        </Note>
      </View>
      {pending && (
        <View style={{ gap: 12 }}>
          <ActivityIndicator accessibilityLabel="正在连接电脑" />
          <Note>
            正在连接。首次配对请在电脑上确认这台手机，然后授予任务查看权。
          </Note>
          {state.deviceId && (
            <Text selectable style={{ fontSize: 12, color: colors.secondary }}>
              设备 {state.deviceId}
            </Text>
          )}
          <Action
            title="移除连接"
            quiet
            onPress={() => confirmConnectionRemoval(controller)}
          />
        </View>
      )}
      {state.review && (
        <View
          style={{
            gap: 14,
            padding: 20,
            borderRadius: 20,
            borderCurve: "continuous",
            backgroundColor: colors.panel,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ fontSize: 20, fontWeight: "600", color: colors.label }}
          >
            核对你的电脑
          </Text>
          <Note>{state.review.relay}</Note>
          <Text selectable style={{ color: colors.label, fontSize: 13 }}>
            主机 {state.review.hostId}
          </Text>
          <Text selectable style={{ color: colors.secondary, fontSize: 12 }}>
            公钥 {state.review.hostKey}
          </Text>
          <Note>确认与你电脑上的配对信息一致，再保存连接。</Note>
          <Action
            title="保存并连接"
            testID="confirm-pairing"
            onPress={() => {
              void controller.confirm().catch(() => {});
            }}
          />
          <Action
            title="取消"
            quiet
            onPress={() => {
              void controller.forget().catch(() => {});
            }}
          />
        </View>
      )}
      {(error || state.error) && <Note error>{error ?? state.error}</Note>}
      {state.phase !== "connected" &&
        state.session &&
        state.composer.record && (
          <Action
            title={
              state.messages.length ? "查看上次任务与草稿" : "继续编辑本机草稿"
            }
            onPress={() => router.push("/task")}
          />
        )}
      {!pending && !state.review && (
        <View style={{ gap: 16 }}>
          {["offline", "error", "blocked"].includes(state.phase) && (
            <>
              <Note>
                重新连接不会自动发送草稿。移除连接会清除本机配对、未发送草稿和历史缓存。
              </Note>
              <Action
                title="重新连接"
                onPress={() => {
                  void controller.restore();
                }}
              />
              <Action
                title="移除连接"
                quiet
                onPress={() => confirmConnectionRemoval(controller)}
              />
            </>
          )}
          {!["offline", "error", "blocked"].includes(state.phase) && (
            <>
              <Action
                title="扫描电脑上的配对码"
                testID="scan-pairing"
                onPress={() => router.push("/scan")}
              />
              <Note>也可以粘贴配对码。它包含设备凭据，请不要发给他人。</Note>
              <Text style={{ color: colors.label, fontSize: 17 }}>配对码</Text>
              <Host
                matchContents={{ vertical: true }}
                style={{ width: "100%" }}
              >
                <TextInput
                  testID="pairing-code"
                  value={value}
                  onChangeText={setDraft}
                  secureTextEntry
                  maxLength={8192}
                  autoCorrect={false}
                  autoCapitalize="none"
                  placeholder="hikaro://pair#…"
                  style={{
                    padding: 16,
                    borderRadius: 14,
                    backgroundColor: colors.panel,
                  }}
                />
              </Host>
              <Action
                title="核对配对信息"
                testID="review-pairing"
                disabled={!draft.trim()}
                quiet
                onPress={review}
              />
            </>
          )}
        </View>
      )}
    </ScrollView>
  );
}
