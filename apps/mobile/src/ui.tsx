import {
  Alert,
  Text,
  View,
  Pressable,
  ScrollView,
  useColorScheme,
  type ScrollViewProps,
} from "react-native";
import { colors } from "./theme";
import { connectionRemoval } from "./connection-removal";

export function confirmConnectionRemoval(
  controller: Parameters<typeof connectionRemoval>[0],
) {
  const confirmation = connectionRemoval(controller);
  Alert.alert(
    "移除这台电脑的连接？",
    "这会清除本机配对、未发送草稿和历史缓存。电脑上的任务与记录仍保留；再次连接需要重新配对。",
    [
      { text: "保留连接", style: "cancel", onPress: confirmation.cancel },
      {
        text: "移除连接与本机草稿",
        style: "destructive",
        onPress: () => {
          void confirmation
            .confirm()
            .then((result) => {
              if (result === "changed")
                Alert.alert("连接已变化", "请重新查看当前连接，再选择移除。");
            })
            .catch(() => {
              Alert.alert("未能完成移除", "请查看连接状态并重试。");
            });
        },
      },
    ],
    { cancelable: true, onDismiss: confirmation.cancel },
  );
}

export function Action({
  title,
  onPress,
  disabled = false,
  quiet = false,
  testID,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  quiet?: boolean;
  testID?: string;
}) {
  useColorScheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: quiet ? "transparent" : colors.beam,
        opacity: disabled ? 0.4 : pressed ? 0.65 : 1,
      })}
    >
      <Text
        style={{
          fontSize: 15,
          lineHeight: 22,
          fontWeight: "600",
          color: quiet ? colors.label : colors.ink,
          textAlign: "center",
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function Note({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  useColorScheme();
  return (
    <Text
      selectable
      accessibilityRole={error ? "alert" : undefined}
      accessibilityLiveRegion={error ? "polite" : undefined}
      style={{
        color: error ? colors.error : colors.secondary,
        fontSize: 13,
        lineHeight: 20,
      }}
    >
      {children}
    </Text>
  );
}
export function SunMark() {
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      style={{ width: 64, height: 48, justifyContent: "flex-end", gap: 8 }}
    >
      <View
        style={{
          width: 25,
          height: 25,
          borderRadius: 20,
          backgroundColor: colors.beam,
          alignSelf: "flex-end",
          marginRight: 8,
        }}
      />
      <View style={{ height: 2, backgroundColor: colors.label }} />
    </View>
  );
}

export function Page({
  children,
  contentContainerStyle,
  style,
  ...props
}: ScrollViewProps) {
  useColorScheme();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      {...props}
      style={[{ flex: 1, backgroundColor: colors.background }, style]}
      contentContainerStyle={[
        { padding: 20, gap: 20, paddingBottom: 40 },
        contentContainerStyle,
      ]}
    >
      {children}
    </ScrollView>
  );
}
export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  useColorScheme();
  return (
    <View style={{ gap: 12 }}>
      <Text
        accessibilityRole="header"
        style={{
          color: colors.secondary,
          fontSize: 13,
          lineHeight: 20,
          fontWeight: "600",
        }}
      >
        {title}
      </Text>
      <View
        style={{
          backgroundColor: colors.panel,
          borderRadius: 16,
          padding: 16,
          gap: 12,
        }}
      >
        {children}
      </View>
    </View>
  );
}
export function NavRow({
  title,
  detail,
  disabled = false,
  onPress,
}: {
  title: string;
  detail?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  useColorScheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        minHeight: 56,
        paddingVertical: 12,
        flexDirection: "row",
        gap: 12,
        alignItems: "center",
        opacity: disabled ? 0.4 : pressed ? 0.65 : 1,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.separator,
      })}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: colors.label, fontSize: 16, lineHeight: 24 }}>
          {title}
        </Text>
        {detail && <Note>{detail}</Note>}
      </View>
      <Text
        accessible={false}
        style={{ color: colors.secondary, fontSize: 24 }}
      >
        ›
      </Text>
    </Pressable>
  );
}
export function EmptyState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  useColorScheme();
  return (
    <View style={{ paddingVertical: 32, gap: 8 }}>
      <View
        style={{
          width: 28,
          height: 4,
          borderRadius: 2,
          backgroundColor: colors.beam,
          marginBottom: 8,
        }}
      />
      <Text
        accessibilityRole="header"
        style={{
          color: colors.label,
          fontSize: 20,
          lineHeight: 28,
          fontWeight: "600",
        }}
      >
        {title}
      </Text>
      <Note>{detail}</Note>
    </View>
  );
}
