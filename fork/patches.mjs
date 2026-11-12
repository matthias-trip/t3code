// Edits applied after the text pass, so anchors use the already renamed text.
// `find` must match or the rebrand fails; `done` marks an already patched file.

const BUILD = "scripts/build-desktop-artifact.ts";
const BUNDLE_ID = "com.mytek.claudecode";
// Own data directory, browser profile and keychain entry: sharing T3 Code's
// makes the two apps lock each other out.
const HOME_DIR = ".claude-code-app";
const PROFILE_DIR = "claude-code-app";

const WORDMARK = `import type { SVGProps } from "react";

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 94 57" xmlns="http://www.w3.org/2000/svg">
      <text
        x="0"
        y="56"
        fill="currentColor"
        fontFamily="system-ui, sans-serif"
        fontSize="78"
        fontWeight="800"
        lengthAdjust="spacingAndGlyphs"
        textLength="94"
      >
        CC
      </text>
    </svg>
  );
}
`;

const SIGNING = `            provisioningProfile: macPasskeySigning.provisioningProfilePath,
          }
        : signed
          ? {
              hardenedRuntime: true,
              entitlements: path.join(repoRoot, "fork/entitlements.mac.plist"),
              entitlementsInherit: path.join(repoRoot, "fork/entitlements.mac.plist"),
              // @effect-diagnostics-next-line processEnvInEffect:off -- fork build switches, read once per build
              ...(process.env.FORK_MAC_IDENTITY ? { identity: process.env.FORK_MAC_IDENTITY } : {}),
              // @effect-diagnostics-next-line processEnvInEffect:off -- fork build switches, read once per build
              ...(process.env.FORK_MAC_SIGN_TYPE === "development" ? { type: "development" } : {}),
              // @effect-diagnostics-next-line processEnvInEffect:off -- fork build switches, read once per build
              ...(process.env.FORK_MAC_NOTARIZE === "true" ? {} : { notarize: false }),
            }
          : {}),
    };`;

// Seams: the only edits the fork overlay (packages/fork-*, */src/fork/**)
// makes to upstream files. Keep each one a line or two on a stable anchor.
const forkDependency = (file) => ({
  why: "the fork overlay package is a workspace dependency",
  file,
  find: '    "@t3tools/contracts": "workspace:*",\n',
  replace: '    "@t3tools/contracts": "workspace:*",\n    "@t3tools/fork-spaces": "workspace:*",\n',
  done: '"@t3tools/fork-spaces": "workspace:*"',
});

const SEAMS = [
  forkDependency("apps/server/package.json"),
  forkDependency("packages/client-runtime/package.json"),
  {
    why: "knip checks the fork overlay's exports like upstream's packages",
    file: "package.json",
    find: "--workspace packages/source-control-testing",
    replace: "--workspace packages/source-control-testing --workspace packages/fork-spaces",
    done: "--workspace packages/fork-spaces",
  },
  {
    why: "the fork layer runs fork migrations after upstream's on the same database",
    file: "apps/server/src/server.ts",
    find: 'import * as ServerActivation from "./serverActivation.ts";\n',
    replace:
      'import * as ServerActivation from "./serverActivation.ts";\nimport * as ForkLayer from "./fork/ForkLayer.ts"; // fork-seam\n',
    done: 'import * as ForkLayer from "./fork/ForkLayer.ts";',
  },
  {
    why: "the fork layer runs fork migrations after upstream's on the same database",
    file: "apps/server/src/server.ts",
    find: "const layerPersistence = Layer.empty.pipe(Layer.provideMerge(SqlitePersistence.layerConfig));",
    replace: [
      "// fork-seam: fork migrations run after upstream's; the fork event store shares the database.",
      "const layerPersistence = ForkLayer.layer.pipe(Layer.provideMerge(SqlitePersistence.layerConfig));",
    ].join("\n"),
    done: "const layerPersistence = ForkLayer.layer.pipe(",
  },
  {
    why: "client-runtime exposes the fork client modules to web and mobile",
    file: "packages/client-runtime/package.json",
    find: [
      '    "./environment": {',
      '      "types": "./src/environment/index.ts",',
      '      "default": "./src/environment/index.ts"',
      "    },",
      "",
    ].join("\n"),
    replace: [
      '    "./environment": {',
      '      "types": "./src/environment/index.ts",',
      '      "default": "./src/environment/index.ts"',
      "    },",
      '    "./fork/*": {',
      '      "types": "./src/fork/*.ts",',
      '      "default": "./src/fork/*.ts"',
      "    },",
      "",
    ].join("\n"),
    done: '"./fork/*": {',
  },
  {
    why: "the server serves the fork RPC group on the environment socket",
    file: "apps/server/src/ws.ts",
    find: 'import * as RpcAuthorization from "./auth/RpcAuthorization.ts";\n',
    replace:
      'import * as RpcAuthorization from "./auth/RpcAuthorization.ts";\nimport { ForkRpcHandlers, withForkRpcGroup } from "./fork/rpc/ForkRpcHandlers.ts"; // fork-seam\n',
    done: 'from "./fork/rpc/ForkRpcHandlers.ts"; // fork-seam',
  },
  {
    why: "the server serves the fork RPC group on the environment socket",
    file: "apps/server/src/ws.ts",
    find: "yield* RpcServer.make(ServerWsRpcGroup, WS_RPC_SERVER_OPTIONS).pipe(",
    replace:
      "yield* RpcServer.make(withForkRpcGroup(ServerWsRpcGroup), WS_RPC_SERVER_OPTIONS).pipe(",
    done: "withForkRpcGroup(ServerWsRpcGroup)",
  },
  {
    why: "the server serves the fork RPC group on the environment socket",
    file: "apps/server/src/ws.ts",
    find: "              readSettingsClient(url.value),\n            ).pipe(\n",
    replace:
      "              readSettingsClient(url.value),\n            ).pipe(\n              Layer.merge(ForkRpcHandlers), // fork-seam\n",
    done: "Layer.merge(ForkRpcHandlers), // fork-seam",
  },
  {
    why: "fork RPCs declare their own scopes; upstream methods keep theirs",
    file: "apps/server/src/auth/RpcAuthorization.ts",
    find: '} from "@t3tools/contracts";\n',
    replace:
      '} from "@t3tools/contracts";\nimport { FORK_RPC_REQUIRED_SCOPES, type ForkRpcMethod } from "@t3tools/fork-spaces/contracts/rpc"; // fork-seam\n',
    done: 'from "@t3tools/fork-spaces/contracts/rpc"; // fork-seam',
  },
  {
    why: "fork RPCs declare their own scopes; upstream methods keep theirs",
    file: "apps/server/src/auth/RpcAuthorization.ts",
    find: "): ReadonlyArray<AuthEnvironmentScope> => {\n  if (method === WS_METHODS.serverRetryResourceTelemetry) {",
    replace: [
      "): ReadonlyArray<AuthEnvironmentScope> => {",
      "  // fork-seam: fork RPCs share this socket and declare their scopes in @t3tools/fork-spaces.",
      "  if (Object.hasOwn(FORK_RPC_REQUIRED_SCOPES, method)) {",
      "    return [FORK_RPC_REQUIRED_SCOPES[method as ForkRpcMethod]];",
      "  }",
      "  if (method === WS_METHODS.serverRetryResourceTelemetry) {",
    ].join("\n"),
    done: "Object.hasOwn(FORK_RPC_REQUIRED_SCOPES, method)",
  },
  {
    why: "clients speak the fork RPC group on the same socket; upstream servers reject its tags",
    file: "packages/client-runtime/src/rpc/protocol.ts",
    find: 'import { WsRpcGroup } from "@t3tools/contracts";\n',
    replace:
      'import { WsRpcGroup } from "@t3tools/contracts";\nimport { ForkRpcGroup } from "@t3tools/fork-spaces/contracts/rpc"; // fork-seam\n',
    done: 'import { ForkRpcGroup } from "@t3tools/fork-spaces/contracts/rpc";',
  },
  {
    why: "clients speak the fork RPC group on the same socket; upstream servers reject its tags",
    file: "packages/client-runtime/src/rpc/protocol.ts",
    find: "export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);",
    replace: [
      "// fork-seam: the fork RPC group shares the environment socket; upstream servers reject its tags.",
      "export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup.merge(ForkRpcGroup));",
    ].join("\n"),
    done: "RpcClient.make(WsRpcGroup.merge(ForkRpcGroup))",
  },
];

// Upstream tests that follow a rename above. Their assertions stay as they are.
const TESTS = [
  {
    why: "the passkey signing test expects this fork's bundle ID",
    file: "scripts/build-desktop-artifact.test.ts",
    find: '      appId: "com.t3tools.t3code",\n      teamId: "ABC1234567",\n      rpDomains:',
    replace: `      appId: "${BUNDLE_ID}",\n      teamId: "ABC1234567",\n      rpDomains:`,
    done: `      appId: "${BUNDLE_ID}",`,
  },
  {
    why: "the passkey entitlements test expects this fork's bundle ID",
    file: "scripts/build-desktop-artifact.test.ts",
    find: '"<string>ABC1234567.com.t3tools.t3code</string>"',
    replace: `"<string>ABC1234567.${BUNDLE_ID}</string>"`,
    done: `"<string>ABC1234567.${BUNDLE_ID}</string>"`,
  },
  {
    why: "the browser profile test expects this fork's profile directory",
    file: "apps/desktop/src/app/DesktopUserData.test.ts",
    find: 'const destination = path.join(directory, "t3code-v2");',
    replace: `const destination = path.join(directory, "${PROFILE_DIR}");`,
    done: `const destination = path.join(directory, "${PROFILE_DIR}");`,
  },
  {
    why: "the command test leaves a launcher under the fork's command name",
    file: "apps/desktop/src/app/DesktopCliCommand.test.ts",
    find: '"userdata/desktop-settings.json", "bin/t3"]',
    replace: '"userdata/desktop-settings.json", "bin/claude-code-app"]',
    done: '"bin/claude-code-app"]',
  },
  {
    why: "the command test strips the fork's Windows launcher name",
    file: "apps/desktop/src/app/DesktopCliCommand.test.ts",
    find: '.replace(/[\\\\/]t3\\.cmd$/, "")',
    replace: '.replace(/[\\\\/]claude-code-app\\.cmd$/, "")',
    done: "claude-code-app\\.cmd$/",
  },
  {
    why: "peer tests find the sessions linking creates by this fork's label",
    file: "apps/server/src/peer/PeerLinks.testkit.ts",
    find: 'session.client.label?.startsWith("T3 Code · ")',
    replace: 'session.client.label?.startsWith("Claude Code · ")',
    done: 'session.client.label?.startsWith("Claude Code · ")',
  },
  {
    // Not a rename: macOS temp directories sit behind the /var symlink, and
    // the code under test resolves real paths.
    why: "npm ownership tests compare real paths on macOS",
    file: "apps/server/src/cli/invocation.test.ts",
    find: "const root = yield* fs.makeTempDirectoryScoped();",
    replace: "const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());",
    done: "fs.realPath(yield* fs.makeTempDirectoryScoped())",
  },
];

export const PATCHES = [
  {
    why: "the bundle ID belongs to this fork",
    file: BUILD,
    find: 'const DESKTOP_APP_ID = "com.t3tools.t3code";',
    replace: `const DESKTOP_APP_ID = "${BUNDLE_ID}";`,
    done: `const DESKTOP_APP_ID = "${BUNDLE_ID}";`,
  },
  {
    why: "the desktop app keeps its data apart from a T3 Code install",
    file: "apps/desktop/src/app/DesktopStatePaths.ts",
    find: 'input.joinPath(input.homeDirectory, ".t3"),',
    replace: `input.joinPath(input.homeDirectory, "${HOME_DIR}"),`,
    done: `input.joinPath(input.homeDirectory, "${HOME_DIR}"),`,
  },
  {
    why: "the bundled server and CLI default to the same data directory",
    file: "apps/server/src/os-jank.ts",
    find: 'return join(yield* HostProcess.HomeDirectory, ".t3");',
    replace: `return join(yield* HostProcess.HomeDirectory, "${HOME_DIR}");`,
    done: `HostProcess.HomeDirectory, "${HOME_DIR}");`,
  },
  {
    why: "the bundled CLI's browser setup uses the same data directory",
    file: "apps/server/src/cli/browser.ts",
    find: 'return home ? path.join(home, ".t3") :',
    replace: `return home ? path.join(home, "${HOME_DIR}") :`,
    done: `path.join(home, "${HOME_DIR}") :`,
  },
  {
    why: "the browser profile is not shared with T3 Code's desktop app",
    file: "apps/desktop/src/app/DesktopUserData.ts",
    find: '      : { current: "t3code-v2", legacy: "T3 Code (Alpha)" };',
    // The override lets the launch check run while the installed app is open;
    // one profile admits one running instance. Written multi-line so the
    // formatter keeps the suppression on the line it applies to.
    replace: [
      "      : {",
      "          // @effect-diagnostics-next-line processEnvInEffect:off -- read once at launch, before any Config layer exists",
      `          current: process.env.FORK_PROFILE_DIR?.trim() || "${PROFILE_DIR}",`,
      '          legacy: "T3 Code (Alpha)",',
      "        };",
    ].join("\n"),
    done: `process.env.FORK_PROFILE_DIR?.trim() || "${PROFILE_DIR}"`,
  },
  {
    why: "a launch check under a throwaway profile must not link its command into ~/.local/bin",
    file: "apps/desktop/src/app/DesktopCliCommand.ts",
    find: "if (!environment.isPackaged || (yield* exists(firstLaunchMarker))) return;",
    replace:
      "// @effect-diagnostics-next-line processEnvInEffect:off -- same launch-check override as DesktopUserData\n      if (process.env.FORK_PROFILE_DIR?.trim()) return;\n      if (!environment.isPackaged || (yield* exists(firstLaunchMarker))) return;",
    done: "if (process.env.FORK_PROFILE_DIR?.trim()) return;",
  },
  {
    why: "the keychain entry for encrypted storage is named after this app, not T3 Code's",
    file: BUILD,
    find: '    name: "t3code",\n    version: appVersion,',
    replace: '    name: "claude-code-app",\n    version: appVersion,',
    done: '    name: "claude-code-app",\n    version: appVersion,',
  },
  {
    why: "the app is named Claude Code, without a stage suffix",
    file: "apps/desktop/package.json",
    find: '"productName": "Claude Code (Beta)"',
    replace: '"productName": "Claude Code"',
    done: '"productName": "Claude Code"',
  },
  {
    why: "window title and About panel say Claude Code, not Claude Code (Beta)",
    file: "apps/desktop/src/app/DesktopEnvironment.ts",
    find: "displayName: `${APP_BASE_NAME} (${stageLabel})`,",
    replace:
      'displayName: stageLabel === "Beta" ? APP_BASE_NAME : `${APP_BASE_NAME} (${stageLabel})`,',
    done: 'displayName: stageLabel === "Beta" ? APP_BASE_NAME',
  },
  {
    why: "menus say Claude Code, not Claude Code Beta",
    file: "apps/desktop/src/app/DesktopAppIdentity.ts",
    find: "`${environment.branding.baseName} ${environment.branding.stageLabel}`,",
    replace:
      'environment.branding.stageLabel === "Beta"\n        ? environment.branding.baseName\n        : `${environment.branding.baseName} ${environment.branding.stageLabel}`,',
    done: 'environment.branding.stageLabel === "Beta"',
  },
  {
    why: "sign without the passkey provisioning profile only the official team has",
    file: BUILD,
    find: 'options.platform === "mac" && options.signed\n      ? yield* Effect.try({',
    replace:
      'options.platform === "mac" &&\n    options.signed &&\n    Boolean(loadRepoEnv({ repoRoot }).T3CODE_MACOS_PROVISIONING_PROFILE?.trim())\n      ? yield* Effect.try({',
    done: "T3CODE_MACOS_PROVISIONING_PROFILE?.trim())",
  },
  {
    why: "hardened-runtime entitlements and signing identity for profile-less signing",
    file: BUILD,
    find: "            provisioningProfile: macPasskeySigning.provisioningProfilePath,\n          }\n        : {}),\n    };",
    replace: SIGNING,
    done: "fork/entitlements.mac.plist",
  },
  {
    why: "updates come from this fork's download page, never from upstream releases",
    file: BUILD,
    find: "  buildConfig.publish = null;\n",
    replace:
      '  buildConfig.publish = null;\n  // @effect-diagnostics-next-line processEnvInEffect:off -- fork build switch\n  const forkUpdateUrl = process.env.FORK_UPDATE_URL?.trim();\n  if (forkUpdateUrl) buildConfig.publish = [{ provider: "generic", url: forkUpdateUrl }];\n',
    done: "forkUpdateUrl",
  },
  {
    why: "an unofficial build must not report usage to upstream unless asked to",
    file: "apps/server/src/telemetry/AnalyticsService.ts",
    find: 'enabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),',
    replace: 'enabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(false)),',
    done: 'enabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(false)),',
  },
  {
    why: "the installer window does not show the T3 mark",
    file: "apps/desktop/resources/dmg/dmg-background-latest.svg",
    find: /  <!-- Official mark[\s\S]*?<\/svg>\n/,
    replace: "  <!-- Upstream's mark is left out of this fork's installer. -->\n",
    done: "left out of this fork's installer",
  },
  {
    why: "the T3 logo glyph becomes a CC monogram",
    file: "apps/web/src/components/T3Wordmark.tsx",
    find: /^[\s\S]*export function T3Wordmark[\s\S]*$/,
    replace: WORDMARK,
    done: 'textLength="94"',
  },
  {
    why: "the sidebar reads Claude Code instead of the T3 glyph plus Code",
    file: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    find: '<T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />',
    replace: '<span className="shrink-0 font-semibold">Claude</span>',
    done: '<span className="shrink-0 font-semibold">Claude</span>',
  },
  {
    // Removing .github/workflows leaves these scripts without a caller.
    why: "knip must not flag scripts only upstream's removed workflows run",
    file: "knip.jsonc",
    find: "  // These executables are supplied by the OS",
    replace: [
      "  // fork: run only by upstream workflows, which the fork removes.",
      '  "ignoreFiles": [',
      '    ".github/scripts/mirror-play-apk.cjs",',
      '    "apps/web/scripts/verify-built-boot.ts",',
      '    "scripts/resolve-nightly-release.ts",',
      '    "scripts/smoke-cli-archive.ts",',
      "  ],",
      "  // These executables are supplied by the OS",
    ].join("\n"),
    done: "// fork: run only by upstream workflows, which the fork removes.",
  },
  ...TESTS,
  ...SEAMS,
];

// The desktop app's terminal command. Upstream calls it `t3`, which would
// collide with a T3 Code install on the same Mac. Not `claude`: that is the
// real Claude Code CLI, which this app starts as a provider.
export const CLI = {
  name: "claude-code-app",
  // The launcher the app writes and links, and the screens that name it.
  // Instructions for installing T3 Code's own CLI on another computer keep `t3`.
  files: [
    "apps/desktop/src/app/DesktopCliCommand.ts",
    "apps/desktop/src/app/DesktopCliCommand.test.ts",
    "apps/desktop/src/app/DesktopCliShim.ts",
    "apps/web/src/components/settings/CliCommandSettingsRow.tsx",
    "apps/web/src/components/settings/settingsSearch.ts",
    "apps/web/src/components/onboarding/WelcomePage.tsx",
    "apps/web/src/state/desktopCliCommand.ts",
  ],
};

// Icon files replaced outright: upstream path, then the file in fork/assets
// that takes its place. Regenerate those with fork/assets/make-icons.mjs.
export const ASSETS = {
  "assets/prod/black-macos-1024.png": "macos-1024.png",
  "assets/prod/t3-black-web-favicon.ico": "favicon.ico",
  "assets/prod/t3-black-web-favicon-16x16.png": "web-16.png",
  "assets/prod/t3-black-web-favicon-32x32.png": "web-32.png",
  "assets/prod/t3-black-web-apple-touch-180.png": "web-180.png",
  "assets/prod/t3-black-web-icon-192x192.png": "web-192.png",
  "assets/prod/t3-black-web-icon-512x512.png": "web-512.png",
};

// Upstream CI and release automation must not run from this fork.
export const REMOVE = [".github/workflows"];
