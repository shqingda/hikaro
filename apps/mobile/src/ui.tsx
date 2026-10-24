import { Host, Button } from "@expo/ui";
import { Alert, Text, View, useColorScheme } from "react-native";
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
    <Host matchContents={{ vertical: true }} style={{ minHeight: 48 }}>
      <Button
        testID={testID}
        label={title}
        onPress={onPress}
        disabled={disabled}
        variant={quiet ? "text" : "filled"}
        // No fixed height: it truncates labels at large Dynamic Type sizes.
        // Host keeps the 48 pt minimum touch target.
        style={{ paddingVertical: 6 }}
      />
    </Host>
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
      style={{ color: colors.secondary, fontSize: 15, lineHeight: 23 }}
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
