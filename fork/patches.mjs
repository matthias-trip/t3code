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
              ...(process.env.FORK_MAC_IDENTITY ? { identity: process.env.FORK_MAC_IDENTITY } : {}),
              ...(process.env.FORK_MAC_SIGN_TYPE === "development" ? { type: "development" } : {}),
              ...(process.env.FORK_MAC_NOTARIZE === "true" ? {} : { notarize: false }),
            }
          : {}),
    };`;

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
    find: ': { current: "t3code-v2", legacy:',
    // The override lets the launch check run while the installed app is open;
    // one profile admits one running instance.
    replace: `: { current: process.env.FORK_PROFILE_DIR?.trim() || "${PROFILE_DIR}", legacy:`,
    done: `process.env.FORK_PROFILE_DIR?.trim() || "${PROFILE_DIR}"`,
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
      '  buildConfig.publish = null;\n  const forkUpdateUrl = process.env.FORK_UPDATE_URL?.trim();\n  if (forkUpdateUrl) buildConfig.publish = [{ provider: "generic", url: forkUpdateUrl }];\n',
    done: "forkUpdateUrl",
  },
  {
    why: "an unofficial build must not report usage to upstream unless asked to",
    file: "apps/server/src/telemetry/AnalyticsService.ts",
    find: 'enabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),',
    replace:
      'enabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(false)),',
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
