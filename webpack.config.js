const path = require("path");

// Minimal webpack setup:
// - Bundles src/renderer/renderer.js (and its imports, e.g. d3)
// - Writes the bundle to src/renderer/bundle.js
// - Adds a source map so DevTools can show the original source (src/renderer/bundle.js.map)

module.exports = {
  mode: "development",
  entry: "./src/renderer/renderer.js",
  output: {
    filename: "bundle.js",
    path: path.resolve(__dirname, "src/renderer")
  },
  target: "web",
  devtool: "source-map",
  module: {
    rules: []
  }
};

