// WebSocket relay for the base engine.
//
// The shim rewrites page WebSocket URLs to /proxy/ws/... or /proxy/wss/... .
// The Node server opened a raw socket and piped bytes; Workers cannot, so this
// opens an upstream WebSocket with fetch and relays messages between the two
// sockets. Workerd unwraps the framing for us, so no WebSocket framing is
// parsed or produced here either.

import { assertPublicDestination } from "./urls.js";
import { blockedMessageForUrl } from "./blocklist.js";

/** True when this request is a WebSocket upgrade. */
export function isUpgradeRequest(request) {
  return String(request.headers.get("upgrade") || "").toLowerCase() === "websocket";
}

/**
 * Relay an upgrade to the target. Returns a 101 response on success, or a
 * plain response the browser will surface as a failed connection.
 */
export async function handleUpgrade(request, targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
    await assertPublicDestination(parsed);
  } catch {
    return new Response("Bad WebSocket target.\n", { status: 400 });
  }

  // A raw Upgrade carries no response body to explain itself, so a blocked
  // domain is simply refused here; the page that opened it sees the socket close.
  if (blockedMessageForUrl(parsed)) {
    return new Response("That domain is blocked.\n", { status: 403 });
  }

  if (!["ws:", "wss:"].includes(parsed.protocol)) {
    return new Response("Only ws and wss can be relayed.\n", { status: 400 });
  }

  const upstreamUrl = new URL(parsed.href);
  upstreamUrl.protocol = parsed.protocol === "wss:" ? "https:" : "http:";

  // The client's own headers, minus the ones that describe this request
  // rather than the destination. The shim already pointed Origin at the real
  // site, and the cookie header is scoped by the browser to this origin.
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower.startsWith("cf-")) continue;
    headers.set(key, value);
  }
  headers.set("upgrade", "websocket");

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, { headers });
  } catch (error) {
    return new Response(`Upstream WebSocket failed: ${error.message}\n`, { status: 502 });
  }

  const upstreamSocket = upstream.webSocket;
  if (upstream.status !== 101 || !upstreamSocket) {
    return new Response("Upstream refused the WebSocket upgrade.\n", { status: 502 });
  }

  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  upstreamSocket.accept();

  // Both ends can vanish at any moment - a page navigating away closes its
  // socket mid-relay - so teardown is symmetric and every handler is guarded.
  const shutdown = () => {
    try {
      server.close();
    } catch {
      /* already closed */
    }
    try {
      upstreamSocket.close();
    } catch {
      /* already closed */
    }
  };

  server.addEventListener("message", (event) => {
    try {
      upstreamSocket.send(event.data);
    } catch {
      shutdown();
    }
  });
  upstreamSocket.addEventListener("message", (event) => {
    try {
      server.send(event.data);
    } catch {
      shutdown();
    }
  });
  server.addEventListener("close", shutdown);
  server.addEventListener("error", shutdown);
  upstreamSocket.addEventListener("close", shutdown);
  upstreamSocket.addEventListener("error", shutdown);

  const responseHeaders = new Headers();
  if (upstreamSocket.protocol) {
    responseHeaders.set("sec-websocket-protocol", upstreamSocket.protocol);
  }
  return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
}
