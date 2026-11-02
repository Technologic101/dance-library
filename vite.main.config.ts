import { defineConfig, type Plugin } from 'vite';

// Native and binary packages must be required at runtime from node_modules
// (and unpacked from the asar), not folded into the main-process bundle.
const runtimePackages = ['better-sqlite3', 'ffmpeg-static', 'ffprobe-static'];

function pinBundleName(fileName: string): Plugin {
  return {
    name: 'dance-library-pin-bundle-name',
    configResolved(config) {
      if (config.build.lib) config.build.lib.fileName = () => fileName;
    },
  };
}

export default defineConfig({
  plugins: [pinBundleName('main.js')],
  build: {
    rollupOptions: {
      external: runtimePackages,
    },
  },
});
