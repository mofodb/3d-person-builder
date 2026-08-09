import { createReadStream, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

/**
 * The base mesh and its manifest are build artifacts produced by
 * `pipeline/blender/build_basemesh.py`, so they live in `assets/dist` rather
 * than in the app's `public/` folder. Copying them in would mean two copies
 * drifting apart, so they are served straight from where the pipeline wrote them
 * and copied only for a production build.
 */
const GENERATED_DIR = fileURLToPath(new URL("../../assets/dist", import.meta.url));
const GENERATED_ROUTE = "/generated/";

const MIME: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".json": "application/json",
  ".ktx2": "image/ktx2",
  ".bin": "application/octet-stream",
};

function serveGeneratedAssets(): Plugin {
  return {
    name: "serve-generated-assets",

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(GENERATED_ROUTE)) return next();

        const name = decodeURIComponent(req.url.slice(GENERATED_ROUTE.length).split("?")[0]!);
        // Refuse traversal outside the generated directory.
        if (name.includes("..") || name.includes("/") || name.includes("\\")) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        const path = join(GENERATED_DIR, name);
        if (!existsSync(path)) {
          res.statusCode = 404;
          res.end(
            `${name} not found. Run: blender --background --python pipeline/blender/build_basemesh.py`,
          );
          return;
        }

        res.setHeader("Content-Type", MIME[extname(name).toLowerCase()] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(path).pipe(res);
      });
    },

    closeBundle() {
      if (!existsSync(GENERATED_DIR)) return;
      const target = fileURLToPath(new URL("./dist/generated", import.meta.url));
      mkdirSync(target, { recursive: true });
      for (const name of readdirSync(GENERATED_DIR)) {
        copyFileSync(join(GENERATED_DIR, name), join(target, name));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), serveGeneratedAssets()],
  server: { port: 5173 },
  build: { target: "es2022" },
});
