import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { imagetools } from 'vite-imagetools';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    imagetools({
      defaultDirectives: () => {
        return new URLSearchParams({
          format: 'webp',
          quality: '80',
        });
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'aws-vendor': ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
})
