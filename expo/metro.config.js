// Metro config — exists solely so the app can reach `src/shared/`, the code the
// web app and the server-side HTML export share (narrative cost / activity-span
// wording). Without the watchFolder entry metro refuses to resolve a module
// outside the project root; without the alias the `@shared/*` tsconfig path has
// no bundler-side counterpart.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, "../src/shared");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), sharedRoot];
// NB: `@shared` is shaped exactly like an npm scope, and `extraNodeModules` is
// only consulted when normal resolution *fails* — so a real `node_modules/@shared`
// would silently win over this alias. No such package exists today; if one ever
// appears, rename the alias rather than debugging the imports.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "@shared": sharedRoot,
  // `src/shared/markdown-math.ts` imports katex — the first bare npm import in
  // shared code. Metro resolves a module's dependencies from *its own*
  // directory, and `src/shared` sits outside the project root, so the walk
  // stops at `src/node_modules` and never reaches either package's real one.
  // Point it at expo's copy explicitly, so the app bundles the same katex it
  // declares in its own package.json rather than the server's.
  katex: path.resolve(projectRoot, "node_modules/katex"),
};

// `src/shared` is NodeNext TypeScript, so a relative import between two files
// there is written `./markdown-refs.js` — the extension the *compiled* output
// will have. Metro only ever sees the `.ts` source and gives up. Try the
// specifier as written first (an expo-side `./foo.js` must keep meaning that
// file), and only on failure retry without the extension.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  try {
    return resolve(context, moduleName, platform);
  } catch (err) {
    if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
      return resolve(context, moduleName.slice(0, -3), platform);
    }
    throw err;
  }
};

module.exports = config;
