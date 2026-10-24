/** Load synchronously on first use so restored messages render fully on frame 1.
 * Node 26 supports require(esm); esbuild preserves the on-demand initialization.
 * https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require
 */
exports.createMarkdown = function createMarkdown(...args) {
  const {
    Markdown,
  } = require("@earendil-works/pi-tui/dist/components/markdown.js");
  return new Markdown(...args);
};
