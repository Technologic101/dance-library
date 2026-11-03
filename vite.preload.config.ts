import { defineConfig, type Plugin } from 'vite';

function pinPreloadName(fileName: string): Plugin {
  return {
    name: 'dance-library-pin-preload-name',
    configResolved(config) {
      const output = config.build.rollupOptions.output;
      if (output && !Array.isArray(output)) output.entryFileNames = fileName;
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [pinPreloadName('preload.js')],
});
