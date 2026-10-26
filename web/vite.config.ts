import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Read server settings only; never expose the root .env to browser code.
  const env = loadEnv(mode, "..", "");
  const port = process.env.PORT ?? env.PORT ?? "8791";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return {
    plugins: [react()],
    server: {
      fs: { allow: [".."] },
      proxy: { "/api": `http://127.0.0.1:${port}` },
    },
  };
});
