import { Appearance } from "react-native";
const dark = () => Appearance.getColorScheme() === "dark";
export const colors = {
  get background() {
    return dark() ? "#141513" : "#f7f7f6";
  },
  get label() {
    return dark() ? "#f2f2ed" : "#12120f";
  },
  get secondary() {
    return dark() ? "#aeafa6" : "#62655b";
  },
  get panel() {
    return dark() ? "#22241f" : "#ffffff";
  },
  get separator() {
    return dark() ? "#3b3d35" : "#dddfd6";
  },
  get error() {
    return dark() ? "#ffb4a9" : "#a52a20";
  },
  beam: "#f2b500",
  ink: "#12120f",
  paper: "#f7f7f6",
};
export const readable = (text: string) =>
  text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
