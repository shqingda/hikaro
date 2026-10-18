import { Host, Button } from "@expo/ui";
import { Text, View, useColorScheme } from "react-native";
import { colors } from "./theme";
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
        style={{ height: 48, paddingVertical: 6 }}
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
