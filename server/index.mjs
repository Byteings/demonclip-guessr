import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadDemons, RoomRegistry } from "./rooms.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAX_BODY_BYTES = 16 * 1024;
const runFile = promisify(execFile);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

// Only public client files are reachable. The demon database, sync script and
// server code must never be served, otherwise players can map a video ID to a
// level name without watching the clip.
const PUBLIC_FILES = new Set(["/index.html", "/styles.css", "/app.js"]);

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

async function serveStatic(pathname, response) {
  let path = decodeURIComponent(pathname);
  if (path === "/" || path.endsWith("/")) path += "index.html";
  const isPublic = PUBLIC_FILES.has(path) || /^\/js\/[a-z-]+\.js$/.test(path);
  if (!isPublic) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  const target = resolve(join(ROOT, normalize(path)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Not a file");
    const body = await readFile(target);
    response.writeHead(200, {
      "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

export async function createAppServer() {
  const loaded = await loadDemons();
  const rooms = new RoomRegistry(loaded.demons, loaded.meta);
  let syncing = false;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const path = url.pathname;

      if (!path.startsWith("/api/")) {
        await serveStatic(path, response);
        return;
      }

      if (path === "/api/health" && request.method === "GET") {
        sendJson(response, 200, { ok: true, playableDemons: rooms.demons.length });
        return;
      }

      if (path === "/api/meta" && request.method === "GET") {
        sendJson(response, 200, rooms.meta);
        return;
      }

      if (path === "/api/sync" && request.method === "POST") {
        if (syncing) throw Object.assign(new Error("A sync is already running"), { status: 409 });
        syncing = true;
        try {
          await runFile(process.execPath, ["scripts/sync-demons.mjs"], { cwd: ROOT });
          sendJson(response, 200, await rooms.reloadDemons());
        } finally {
          syncing = false;
        }
        return;
      }

      const body = request.method === "GET" ? {} : await readBody(request);
      const playerId = request.headers["x-player-id"] || body.playerId;
      const token = request.headers["x-player-token"] || body.token;

      if (path === "/api/session" && request.method === "POST") {
        sendJson(response, 201, rooms.create(body.name, body.mode, body.seats));
        return;
      }

      if (path === "/api/collection" && request.method === "POST") {
        sendJson(response, 200, rooms.collection(body.code, playerId, token, body.ids));
        return;
      }

      const joinMatch = path.match(/^\/api\/rooms\/([^/]+)\/join$/);
      if (joinMatch && request.method === "POST") {
        sendJson(response, 200, rooms.join(joinMatch[1], body.name));
        return;
      }

      const roomMatch = path.match(/^\/api\/rooms\/([A-Z0-9]{5})$/);
      if (roomMatch) {
        const code = roomMatch[1];
        if (request.method === "GET") {
          sendJson(response, 200, rooms.state(code, playerId, token));
          return;
        }
        if (request.method === "DELETE") {
          sendJson(response, 200, rooms.leave(code, playerId, token));
          return;
        }
      }

      const actionMatch = path.match(/^\/api\/rooms\/([A-Z0-9]{5})\/(start|guess|next|settings)$/);
      if (actionMatch && request.method === "POST") {
        const [, code, action] = actionMatch;
        if (action === "start") sendJson(response, 200, rooms.start(code, playerId, token, body));
        if (action === "guess") sendJson(response, 200, rooms.guess(code, playerId, token, body.guess, Boolean(body.skip)));
        if (action === "next") sendJson(response, 200, rooms.next(code, playerId, token));
        if (action === "settings") sendJson(response, 200, rooms.settings(code, playerId, token, body));
        return;
      }

      sendJson(response, 404, { error: "Unknown endpoint" });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.message || "Internal error" });
    }
  });
}
