// Wisp endpoint, baked into this Worker.
//
// Upstream wisp-js ships a Node HTTP glue module (`server/http.mjs`) that wraps
// `ws` and turns an Upgrade request into a `ServerConnection`. Workers have no
// `ws`, but they do have WebSocketPair, so this is the replacement glue: accept
// the socket, hand it to the unchanged `ServerConnection`, and keep it running
// with `ctx.waitUntil`.
//
// The client offers `wisp-v2` as a WebSocket subprotocol and falls back to v1 if
// the server does not echo it, so the 101 response selects it explicitly.

import { ServerConnection } from "./server/connection.mjs";
import { options } from "./server/options.mjs";
import { StreamSlots, sessionSocketClass } from "./server/net.mjs";

export { options };

const WISP_V2 = "wisp-v2";

/** True for a path this Worker serves Wisp sessions on: /wisp/<engine>/. */
export function isWispPath(pathname) {
  return pathname.startsWith("/wisp/") && pathname.endsWith("/");
}

function wispVersionFor(request) {
  const offered = String(request.headers.get("sec-websocket-protocol") || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase());
  return offered.includes(WISP_V2) ? 2 : 1;
}

/**
 * Answer a WebSocket upgrade with a Wisp session, or return null when the
 * request is not one. `pathname` is passed through because wisp-js keys the
 * session on it, and rejects paths that do not end in a slash.
 */
export function handleWispUpgrade(request, pathname, ctx, wispOptions = {}) {
  if (!isWispPath(pathname)) return null;
  if (String(request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return null;
  }

  const version = wispVersionFor(request);
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  // One budget of six sockets per session: the platform's per-request cap,
  // scoped so a busy visitor cannot consume another visitor's connections.
  const slots = new StreamSlots();

  const connection = new ServerConnection(server, pathname, {
    ...wispOptions,
    wisp_version: version,
    TCPSocket: sessionSocketClass(slots)
  });

  // setup() performs the handshake (and, for v2, the INFO exchange); run()
  // pumps packets until the socket closes. Neither can block the response.
  ctx.waitUntil(
    (async () => {
      try {
        await connection.setup();
        await connection.run();
      } catch (error) {
        console.warn(`wisp session ${connection.conn_id} failed: ${error}`);
        try {
          server.close();
        } catch {
          /* already closed */
        }
      } finally {
        // Nothing may wait on a budget whose session is gone.
        slots.dispose();
      }
    })()
  );

  const headers = new Headers();
  if (version === 2) headers.set("sec-websocket-protocol", WISP_V2);

  return new Response(null, { status: 101, webSocket: client, headers });
}
