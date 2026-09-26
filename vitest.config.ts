import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['apps/**/*.test.ts','apps/**/*.test.tsx'],testTimeout:20000,hookTimeout:30000,fileParallelism:false}});
