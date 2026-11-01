// Import the pinned TUI modules directly: its root also initializes Markdown.
export { TuiAltScreen } from "@earendil-works/pi-tui/dist/tui-alt-screen.js";
export { ProcessTerminal } from "@earendil-works/pi-tui/dist/terminal.js";
export { Container, CURSOR_MARKER } from "@earendil-works/pi-tui/dist/tui.js";
// The Pi package root does not export these markers, and the Pi extension
// build rewrites every pi-tui import to that root. Keep the literal values.
export const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
export const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";
export { Text } from "@earendil-works/pi-tui/dist/components/text.js";
export { Editor } from "@earendil-works/pi-tui/dist/components/editor.js";
export { Input } from "@earendil-works/pi-tui/dist/components/input.js";
export { ScrollView } from "@earendil-works/pi-tui/dist/components/scroll-view.js";
export { VStack } from "@earendil-works/pi-tui/dist/components/v-stack.js";
export { HStack } from "@earendil-works/pi-tui/dist/components/h-stack.js";
export { matchesKey, isKeyRelease } from "@earendil-works/pi-tui/dist/keys.js";
export { getKeybindings } from "@earendil-works/pi-tui/dist/keybindings.js";
export {
  allocateImageId,
  getCapabilities,
  getPngDimensions,
  renderImage,
} from "@earendil-works/pi-tui/dist/terminal-image.js";
export {
  visibleWidth,
  truncateToWidth,
} from "@earendil-works/pi-tui/dist/utils.js";
export { CombinedAutocompleteProvider } from "@earendil-works/pi-tui/dist/autocomplete.js";
export { fuzzyFilter } from "@earendil-works/pi-tui/dist/fuzzy.js";
export type {
  Component,
  MarkdownTheme,
  SelectItem,
  AutocompleteSuggestions,
  TUI,
  TuiMouseEvent,
} from "@earendil-works/pi-tui";
