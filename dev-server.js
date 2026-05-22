const http = require("http");
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const port = 4173;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

http
  .createServer((request, response) => {
    let filePath = decodeURIComponent(request.url.split("?")[0]);
    if (filePath === "/") filePath = "/index.html";

    const fullPath = path.resolve(root, `.${filePath}`);
    if (!fullPath.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    fs.readFile(fullPath, (error, data) => {
      if (error) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      response.writeHead(200, { "Content-Type": types[path.extname(fullPath)] || "application/octet-stream" });
      response.end(data);
    });
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`Huevos camperos de gallinas felices: http://127.0.0.1:${port}`);
  });
