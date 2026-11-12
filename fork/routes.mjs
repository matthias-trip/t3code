#!/usr/bin/env node
// Regenerates apps/web/src/routeTree.gen.ts as the Vite router plugin does,
// without starting Vite. Run after a merge that kept our copy (fork-ours).
// Usage: node fork/routes.mjs [tree-root]
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(process.argv[2] ?? NodePath.join(import.meta.dirname, ".."));
const web = NodePath.join(root, "apps/web");

// The packages are dependencies of apps/web, not of this directory.
const pluginEntry = NodeModule.createRequire(NodePath.join(web, "package.json")).resolve(
  "@tanstack/router-plugin",
);
const generatorEntry = NodeModule.createRequire(pluginEntry).resolve("@tanstack/router-generator");
const { getConfig } = await import(NodeURL.pathToFileURL(pluginEntry).href);
const { Generator } = await import(NodeURL.pathToFileURL(generatorEntry).href);

// Must match the tanstackRouter() options in apps/web/vite.config.ts.
const config = getConfig({ autoCodeSplitting: true }, web);
await new Generator({ config, root: web }).run();
console.log(
  `routes: ${NodePath.relative(root, NodePath.resolve(web, config.generatedRouteTree))} regenerated`,
);
