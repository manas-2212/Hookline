import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, the API runs on :8080; proxying keeps the session cookie same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/v1": { target: "http://localhost:8080", ws: true }, "/auth": "http://localhost:8080" },
  },
});
