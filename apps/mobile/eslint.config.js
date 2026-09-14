const expoConfig = require("eslint-config-expo/flat");
const { defineConfig, globalIgnores } = require("eslint/config");

module.exports = defineConfig([
  expoConfig,
  globalIgnores(["dist/**", ".expo/**", "coverage/**"]),
]);
