// cf-compaxy - Worker entry point.
//
// Spike scope: the Wisp transport on cloudflare:sockets. Everything else the
// proxy does (base engine, Scramjet and Ultraviolet surfaces) is ported on top
// of this once the transport is proven.

import { handleWispUpgrade, options as wispOptions } from "./wisp/index.js";

// Wisp defaults for this deployment. The stream caps are the platform's real
// shape rather than a policy choice: Workers allow six simultaneous outbound
// connections per request, and a Wisp session is one request.
wispOptions.stream_limit_total = Number(globalThis.__wispStreamTotal ?? 6);
wispOptions.stream_limit_per_host = 6;
wispOptions.allow_udp_streams = false;
wispOptions.allow_private_ips = false;
wispOptions.allow_loopback_ips = false;
wispOptions.send_buffer_size = 128;

const HEALTH = `cf-compaxy wisp spike

endpoint:  wss://<host>/wisp/<name>/
protocol:  Wisp v1/v2 over WebSocket
transport: cloudflare:sockets (TCP only)
caps:      6 streams per session, 6 per host, UDP off
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const upgrade = handleWispUpgrade(request, url.pathname, ctx, {
      ping_interval: 30
    });
    if (upgrade) return upgrade;

    if (url.pathname.startsWith("/wisp/")) {
      return new Response("Wisp is a WebSocket endpoint; upgrade to connect.\n", {
        status: 426,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok", spike: "wisp" });
    }

    return new Response(HEALTH, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
};
