import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { runtimePackagePrefixes, shouldPackagerIgnore } from './src/packaging/ignore';

const projectRoot = process.cwd();
const runtimePrefixes = runtimePackagePrefixes(projectRoot);

// Unsigned on purpose. Do not add code signing or a publisher.
const config: ForgeConfig = {
  packagerConfig: {
    executableName: 'dance-library',
    appBundleId: 'org.dance-library.app',
    // The ignore function below selects runtime packages. Leave pruning off so
    // it does not drop those packages before the ignore rules run.
    prune: false,
    asar: {
      // Comma-separated so the auto-unpack plugin can wrap this in one brace group.
      unpack: '**/ffmpeg-static/**,**/@ffprobe-installer/**,**/*.node',
    },
    // The Vite plugin would otherwise keep only .vite and drop native modules.
    ignore: (file) => shouldPackagerIgnore(file, runtimePrefixes),
  },
  rebuildConfig: {
    // The catalog uses better-sqlite3's N-API prebuilds. Rebuilding them needs
    // a C++ toolchain and fails on GitHub's current Windows image.
    ignoreModules: ['better-sqlite3'],
  },
  makers: [new MakerSquirrel({}), new MakerDMG({}), new MakerZIP({}, ['darwin']), new MakerDeb({})],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new AutoUnpackNativesPlugin({}),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
