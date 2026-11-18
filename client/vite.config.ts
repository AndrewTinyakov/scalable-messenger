import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'messenger-runtime-config',
      apply: 'build',
      transformIndexHtml: () => [
        { tag: 'script', attrs: { src: '/runtime-config.js' }, injectTo: 'head-prepend' },
      ],
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'runtime-config.js',
          source:
            "window.__MESSENGER_CONFIG__={apiBaseUrl:location.origin+'/api',wsUrl:(location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws'};\n",
        })
      },
    },
  ],
})
