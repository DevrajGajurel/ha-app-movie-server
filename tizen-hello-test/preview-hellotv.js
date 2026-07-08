#!/usr/bin/env node
// Ad hoc static server for previewing tizen-hello-test/HelloTV in a desktop
// browser while iterating, before spending a TV install cycle.
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "HelloTV");
const PORT = Number(process.env.PORT) || 4601;

const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Previewing HelloTV at http://localhost:${PORT}/`);
});
