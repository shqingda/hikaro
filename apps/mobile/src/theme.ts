import { Platform } from "react-native";
import { Color } from "expo-router";
export const colors = {
  background: Platform.select({
    ios: Color.ios.systemBackground,
    android: Color.android.dynamic.surface,
    default: "#f7f7f6",
  })!,
  label: Platform.select({
    ios: Color.ios.label,
    android: Color.android.dynamic.onSurface,
    default: "#12120f",
  })!,
  secondary: Platform.select({
    ios: Color.ios.secondaryLabel,
    android: Color.android.dynamic.onSurfaceVariant,
    default: "#64645d",
  })!,
  panel: Platform.select({
    ios: Color.ios.secondarySystemBackground,
    android: Color.android.dynamic.surfaceContainer,
    default: "#efefed",
  })!,
  separator: Platform.select({
    ios: Color.ios.separator,
    android: Color.android.dynamic.outlineVariant,
    default: "#d5d5cf",
  })!,
  beam: "#f2b500",
  ink: "#12120f",
  paper: "#f7f7f6",
};
export const readable = (text: string) =>
  text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
