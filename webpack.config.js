const path = require("path");

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

