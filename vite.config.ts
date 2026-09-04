import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const mediaRoot = path.resolve(appRoot, "../generated/library");
const mediaRoutePrefix = "/640/media/";

function isInsideOrEqual(child: string, parent: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentTypeFor(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webp": "image/webp"
  };

  return types[extension] || null;
}

function createMediaMiddleware(): Connect.NextHandleFunction {
  return (request, response, next) => {
    const requestUrl = request.url || "";
    const pathname = requestUrl.split(/[?#]/, 1)[0];

    if (!pathname.startsWith(mediaRoutePrefix)) {
      next();
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.end("Method not allowed");
      return;
    }

    if (!fs.existsSync(mediaRoot)) {
      response.statusCode = 500;
      response.end(`Local generated media directory is missing: ${path.relative(appRoot, mediaRoot)}`);
      return;
    }

    let assetKey: string;
    try {
      assetKey = decodeURIComponent(pathname.slice(mediaRoutePrefix.length));
    } catch {
      response.statusCode = 400;
      response.end("Invalid media path");
      return;
    }

    const filePath = path.resolve(mediaRoot, assetKey);
    if (!assetKey || !isInsideOrEqual(filePath, mediaRoot) || filePath === mediaRoot) {
      response.statusCode = 403;
      response.end("Forbidden media path");
      return;
    }

    fs.stat(filePath, (statError, stat) => {
      if (statError || !stat.isFile()) {
        response.statusCode = 404;
        response.end("Media not found");
        return;
      }

      const contentType = contentTypeFor(filePath);
      if (!contentType) {
        response.statusCode = 415;
        response.end("Unsupported media type");
        return;
      }

      response.statusCode = 200;
      response.setHeader("Content-Type", contentType);
      response.setHeader("Content-Length", stat.size);
      response.setHeader("Cache-Control", "no-cache");

      if (request.method === "HEAD") {
        response.end();
        return;
      }

      fs.createReadStream(filePath)
        .on("error", () => {
          if (!response.headersSent) {
            response.statusCode = 500;
          }
          response.end("Media read failed");
        })
        .pipe(response);
    });
  };
}

function localGeneratedMedia(): Plugin {
  const middleware = createMediaMiddleware();

  return {
    name: "local-generated-media",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    }
  };
}

export default defineConfig({
  base: "/640/",
  plugins: [react(), localGeneratedMedia()],
  server: {
    port: 5173,
    strictPort: false
  },
  preview: {
    port: 4173,
    strictPort: false
  }
});
