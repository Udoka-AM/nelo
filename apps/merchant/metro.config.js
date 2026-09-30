// Monorepo Metro config. Without this, Metro only watches apps/payer and
// cannot resolve workspace packages such as @nelo/voucher.
// https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// Privy's SDK depends on `jose`, whose package exports send Metro to its Node
// build (which imports `crypto`). Resolve it with the browser condition, as
// Privy's Expo setup guide does.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "jose") {
    return context.resolveRequest({ ...context, unstable_conditionNames: ["browser"] }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
