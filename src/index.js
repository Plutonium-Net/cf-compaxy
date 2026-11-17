// Compaxy on Cloudflare Workers: base, Scramjet v2 and Ultraviolet behind one
// origin, with the Wisp transport served from this same Worker.
//
// The routing table in sites.json decides which engine serves which site. Ask
// it for a site and it redirects to the engine that owns it:
//
//     https://<worker>/?url=https://example.com/
//
// Engine surfaces, all on this origin:
//
//     base         fetch, rewrite and re-emit here    /proxy/<scheme>/<host>/<path>
//     scramjet     Scramjet v2 in a service worker    /scram/... (+ /sj/ assets)
//     ultraviolet  Ultraviolet in a service worker    /uv/service/... (+ /uv/ assets)
//     wisp         Wisp v1/v2 over WebSocket          /wisp/<engine>/

import { normalizeTargetUrl, toProxyUrl, fromProxyRequest, PROXY_PREFIX } from "./urls.js";
import { handleProxy } from "./proxy.js";
import { handleUpgrade, isUpgradeRequest } from "./websocket.js";
import { stats as cacheStats } from "./cache.js";
import {
  blockedMessageForUrl,
  renderBlockedPage,
  blockedHostRules,
  blockedHostPatterns,
  configureBlocklist
} from "./blocklist.js";
import {
  ENGINES,
  ENGINE_IDS,
  engineForUrl,
  defaultEngine,
  routingSummary,
  tableProblem
} from "./engines.js";
import {
  NEEDS_ISOLATION,
  embedCapableEngine,
  isFramedRequest
} from "./embed.js";
import {
  scramjetPage,
  ultravioletPage,
  SCRAMJET_SW,
  UV_CONFIG,
  UV_SW
} from "./pages.js";
import { entryPage } from "./entry.js";
import { handleWispUpgrade, options as wispOptions } from "./wisp/index.js";

// Wisp defaults. The stream caps follow the platform: Workers allow six
// simultaneous outbound connections per request, and a Wisp session is one
// request. UDP is refused because connect() is TCP only, and the private and
// loopback ranges stay refused exactly as the Node server refused them.
wispOptions.stream_limit_total = 6;
wispOptions.stream_limit_per_host = 6;
wispOptions.allow_udp_streams = false;
wispOptions.allow_private_ips = false;
wispOptions.allow_loopback_ips = false;
wispOptions.send_buffer_size = 128;

// Isolate-wide setup, run before the first request is answered: the blocklist
// from the Worker's BLOCKLIST variable also becomes the Wisp host filter, so a
// blocked site is refused at the transport instead of only in the engines.
let configuredBlocklist = null;
function configure(env) {
  const raw = env?.BLOCKLIST == null ? "" : String(env.BLOCKLIST);
  if (configuredBlocklist === raw) return;
  configuredBlocklist = raw;
  configureBlocklist(raw);
  const patterns = blockedHostPatterns();
  wispOptions.hostname_blacklist = patterns.length ? patterns : null;
}

function textResponse(body, status = 200, type = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: { "content-type": type, "cache-control": "no-store" }
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function htmlResponse(body) {
  return textResponse(body, 200, "text/html; charset=utf-8");
}

function scriptResponse(body) {
  return textResponse(body, 200, "text/javascript; charset=utf-8");
}

function blockedResponse(message) {
  return textResponse(renderBlockedPage(message), 403, "text/html; charset=utf-8");
}

// Service-worker engines need SharedArrayBuffer for their Wisp transport, so
// their own surfaces are cross-origin isolated. `credentialless` (rather than
// require-corp) keeps third-party subresources and frames working, which matters
// because this proxy is meant to be embeddable.
function isolated(response) {
  const headers = new Headers(response.headers);
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-embedder-policy", "credentialless");
  headers.set("cross-origin-resource-policy", "cross-origin");
  return new Response(response.body, { status: response.status, headers });
}

const bootstrappers = new Map([
  ["/go/scramjet", { engine: ENGINES.scramjet, page: scramjetPage }],
  ["/go/ultraviolet", { engine: ENGINES.ultraviolet, page: ultravioletPage }]
]);

export default {
  async fetch(request, env, ctx) {
    configure(env);

    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;

    // What the entry screen's status card asks: the proxy answering this very
    // request, the response cache still inside its budget, and the transport the
    // worker engines run over.
    if (path === "/healthz") {
      const cacheStatsNow = cacheStats();
      return jsonResponse({
        status: "ok",
        components: [
          { name: "proxy", ok: true },
          { name: "cache", ok: cacheStatsNow.bytes <= cacheStatsNow.budget },
          { name: "wisp", ok: true }
        ],
        runtime: "cloudflare-workers",
        engines: ENGINE_IDS,
        defaultEngine: defaultEngine().id,
        cache: cacheStatsNow
      });
    }

    // The engine service workers fetch this to refuse a blocked site with the
    // configured message rather than a transport error.
    if (path === "/blocked-hosts.json") {
      return jsonResponse(blockedHostRules());
    }

    // ---- Wisp ---------------------------------------------------------------

    const wisp = handleWispUpgrade(request, path, ctx);
    if (wisp) return wisp;
    if (path.startsWith("/wisp/")) {
      return textResponse("Wisp is a WebSocket endpoint; upgrade to connect.\n", 426);
    }

    // ---- engine surfaces ----------------------------------------------------

    // Worker and config scripts are generated here so their prefixes always
    // match the routes this Worker actually serves. The engine bundles
    // themselves are static assets (/sj/, /uv/, /baremux/, /epoxy/, /epoxy3/).
    if (path === "/scram/sw.js") return isolated(scriptResponse(SCRAMJET_SW));
    if (path === "/uv/sw.js") return isolated(scriptResponse(UV_SW));
    if (path === "/uv/uv.config.js") return isolated(scriptResponse(UV_CONFIG));

    if (path === "/scram/") return isolated(htmlResponse(scramjetPage()));

    // A request arriving under an engine's prefix means that engine's worker was
    // not in control of it. Send the visitor back through the bootstrapper
    // instead of guessing what the engine's URL format means.
    if (path.startsWith(ENGINES.scramjet.route)) {
      const encoded = path.slice(ENGINES.scramjet.route.length);
      return new Response(null, {
        status: 302,
        headers: { location: `/go/scramjet#${encoded}`, "cache-control": "no-store" }
      });
    }

    // Same contract for Ultraviolet: its encoded path cannot be decoded here
    // (the codec lives in its client bundle), so say what happened instead of
    // answering a bare 404.
    if (path.startsWith(ENGINES.ultraviolet.route)) {
      return textResponse(
        "Ultraviolet is not controlling this request. Open the site again from /.\n",
        404
      );
    }

    const bootstrapper = bootstrappers.get(path);
    if (bootstrapper) {
      // The entry point already refuses a blocked site, but a bootstrapper is
      // reachable directly, so it checks too.
      const requested = requestUrl.searchParams.get("url");
      const message = requested ? blockedMessageForUrl(requested) : null;
      if (message) return blockedResponse(message);

      // A frame cannot be cross-origin isolated, so this engine could never start
      // in one (see embed.js). Send the frame to the engine that can serve the
      // site there, rather than a screen it can never get past.
      if (
        requested &&
        isFramedRequest(Object.fromEntries(request.headers)) &&
        NEEDS_ISOLATION.has(bootstrapper.engine.id)
      ) {
        let embedTarget = null;
        try {
          embedTarget = normalizeTargetUrl(requested);
        } catch {
          embedTarget = null;
        }
        if (embedTarget) {
          return new Response(null, {
            status: 302,
            headers: { location: toProxyUrl(embedTarget), "cache-control": "no-store" }
          });
        }
      }

      return isolated(htmlResponse(bootstrapper.page()));
    }

    // ---- upgrades -----------------------------------------------------------

    if (isUpgradeRequest(request)) {
      if (!path.startsWith(PROXY_PREFIX)) {
        return textResponse("Not a WebSocket endpoint.\n", 404);
      }
      let target;
      try {
        target = fromProxyRequest(path, requestUrl.search);
      } catch {
        return textResponse("Malformed proxy URL.\n", 400);
      }
      return await handleUpgrade(request, target);
    }

    // ---- entry point --------------------------------------------------------

    // /?url=<address>. Resolve it, then serve the site from its own mirrored
    // path so the browser's URL stays meaningful.
    if (path === "/") {
      if (!requestUrl.search) {
        return htmlResponse(
          entryPage(requestUrl.host, {
            rows: routingSummary(),
            fallback: defaultEngine(),
            problem: tableProblem()
          })
        );
      }
      const raw = requestUrl.searchParams.get("url");
      if (raw === null) return textResponse("Missing ?url=<address>.\n", 400);

      let target;
      try {
        target = normalizeTargetUrl(raw);
      } catch (error) {
        return textResponse(`Cannot proxy that: ${error.message}\n`, 400);
      }
      const blocked = blockedMessageForUrl(target);
      if (blocked) return blockedResponse(blocked);

      // The routing table decides, once, which engine serves this site. There is
      // no fallback: a site that does not work on its engine is a table edit. The
      // one thing that overrides it is where the request came from - a frame can
      // never be cross-origin isolated, so a worker engine would never boot there
      // and the server-side engine serves the site instead (see embed.js).
      const { engine } = engineForUrl(target);
      const served = embedCapableEngine(
        engine,
        isFramedRequest(Object.fromEntries(request.headers))
      );
      let location;
      if (served.id === "base") {
        location = toProxyUrl(target);
      } else if (served.id === "ultraviolet") {
        location = `/go/ultraviolet?url=${encodeURIComponent(target)}`;
      } else {
        // The target travels in the query so the bootstrapper's own request can
        // be checked against the blocklist before the engine starts.
        location = `/go/scramjet?url=${encodeURIComponent(target)}`;
      }
      return new Response(null, {
        status: 302,
        headers: { location, "cache-control": "no-store" }
      });
    }

    // ---- base engine --------------------------------------------------------

    if (path.startsWith(PROXY_PREFIX)) {
      let target;
      try {
        target = fromProxyRequest(path, requestUrl.search);
      } catch (error) {
        return textResponse(error.message, 400);
      }
      return handleProxy(request, target, { stripCorsHeaders: false });
    }

    // ---- static engine bundles and brand artwork ----------------------------
    // Everything above is generated; everything below is a file: /sj/, /uv/,
    // /baremux/, /epoxy/, /epoxy3/ and the brand PNGs.

    if (env?.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }

    return textResponse("Not found. Use /?url=<address> to proxy a site.\n", 404);
  }
};
