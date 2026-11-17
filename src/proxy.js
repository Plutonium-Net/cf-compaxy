// Core proxy request handler: fetch upstream, translate headers/cookies,
// rewrite text responses and stream everything else.
//
// The Node server had an http.IncomingMessage and a ServerResponse to work with.
// A Worker has one Request and one Response, so the shape changed but the rules
// did not: text is buffered, decoded, rewritten and re-emitted as UTF-8;
// everything else streams through byte-for-byte; small cacheable GETs are kept
// in memory so a repeat load skips the network.

import { assertPublicDestination } from "./urls.js";
import { blockedMessageForUrl, renderBlockedPage } from "./blocklist.js";
import { upstreamRequestHeaders, downstreamResponseHeaders } from "./headers.js";
import { rewriteHtml, rewriteCss, decodeText } from "./rewrite.js";
import { cacheKey, get as cacheGet, set as cacheSet } from "./cache.js";

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
// Cap on a body we are willing to buffer purely to cache it.
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;

const TEXTUAL = (type) =>
  type.includes("text/html") ||
  type.includes("application/xhtml+xml") ||
  type.includes("text/css");

const MEDIA = (type) => /^(video|audio)\/|event-stream/.test(type);

/**
 * Cacheable freshness in seconds, from the upstream Cache-Control header.
 * Anything explicitly private or unshareable returns 0.
 */
function freshnessSeconds(headers) {
  const control = headers.get("cache-control") || "";
  if (/(?:^|,)\s*(?:no-store|private|no-cache)\b/i.test(control)) return 0;
  const shared = /s-maxage\s*=\s*(\d+)/i.exec(control);
  if (shared) return Number(shared[1]);
  const max = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(control);
  if (max) return Number(max[1]);
  return 0;
}

/**
 * Whether a response may be reused for another request: only unauthenticated,
 * uncookied, non-range GETs, with explicit freshness and no Set-Cookie, and
 * never media (which is large and often streamed once).
 */
function storableTtl(request, upstream, contentType) {
  if (upstream.status !== 200) return 0;
  if (request.headers.has("authorization") || request.headers.has("range")) return 0;
  if (upstream.headers.has("set-cookie")) return 0;
  // Only reuse a response whose Vary is limited to what the proxy itself
  // fixes per request, so a cached entry can never answer a request that
  // should have received something personalised (cookie, origin, language...).
  const vary = (upstream.headers.get("vary") || "").toLowerCase();
  if (vary) {
    const fields = vary.split(",").map((field) => field.trim()).filter(Boolean);
    if (!fields.every((field) => field === "accept-encoding")) return 0;
  }
  if (MEDIA(contentType)) return 0;
  return freshnessSeconds(upstream.headers);
}

/** Build a Headers object from the plain map headers.js returns. */
function toHeaders(map) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(map)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function blockedResponse(message) {
  return new Response(renderBlockedPage(message), {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function errorResponse(error) {
  const message = String(error?.message || error);
  const body = `<!doctype html><meta charset="utf-8">
<main style="font-family:system-ui;padding:32px;line-height:1.5;max-width:60ch">
  <h1>Proxy could not load this page</h1>
  <pre style="white-space:pre-wrap">${message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")}</pre>
</main>`;
  return new Response(body, {
    status: 502,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export async function handleProxy(request, targetUrl, options = {}) {
  // A blocked domain is answered here, before the cache or the network, because
  // this is the single gate every /proxy/... request passes through - direct
  // navigation, subresources and the entry redirect alike.
  const blocked = blockedMessageForUrl(targetUrl);
  if (blocked) return blockedResponse(blocked);

  // Fast path: a cache hit never touches the network.
  const cacheableRequest =
    request.method === "GET" &&
    !request.headers.has("authorization") &&
    !request.headers.has("range");
  const key = cacheableRequest ? cacheKey(request.method, targetUrl) : null;
  if (key) {
    const hit = cacheGet(key);
    if (hit) {
      return new Response(hit.body, {
        status: hit.status,
        headers: toHeaders(hit.headers)
      });
    }
  }

  try {
    await assertPublicDestination(targetUrl);

    const incoming = Object.fromEntries(request.headers);
    const init = {
      method: request.method,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: upstreamRequestHeaders(incoming, targetUrl, request.headers.get("cookie"))
    };

    if (!["GET", "HEAD"].includes(request.method) && request.body) {
      init.body = request.body;
      init.duplex = "half";
    }

    const upstream = await fetch(targetUrl, init);
    const { response, entry } = await sendResponse(request, upstream, targetUrl, options);
    if (key && entry) cacheSet(key, entry);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Turn the upstream response into the one sent downstream. Returns the response
 * plus a cache entry when it may be reused, otherwise null.
 */
async function sendResponse(request, upstream, targetUrl, options) {
  const headerMap = downstreamResponseHeaders(upstream.headers, targetUrl, options);
  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  const ttl = storableTtl(request, upstream, contentType);

  // Redirects: hand the rewritten Location back to the browser so the frame
  // follows it through the proxy.
  if (upstream.status >= 300 && upstream.status < 400 && headerMap.location) {
    return {
      response: new Response(null, { status: upstream.status, headers: toHeaders(headerMap) }),
      entry: null
    };
  }

  if (
    request.method === "HEAD" ||
    upstream.status === 204 ||
    upstream.status === 304
  ) {
    return {
      response: new Response(null, { status: upstream.status, headers: toHeaders(headerMap) }),
      entry: null
    };
  }

  // Textual content: buffer, decode with the declared charset, rewrite and
  // re-emit as UTF-8. Ranges are ignored for these.
  if (TEXTUAL(contentType)) {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      throw new Error("Response is too large to rewrite.");
    }

    let body;
    if (contentType.includes("text/css")) {
      body = rewriteCss(decodeText(buffer, contentType), targetUrl);
      headerMap["content-type"] = "text/css; charset=utf-8";
    } else {
      body = rewriteHtml(decodeText(buffer, contentType), targetUrl);
      headerMap["content-type"] = "text/html; charset=utf-8";
    }
    const out = Buffer.from(body);
    headerMap["content-length"] = out.length;
    // Rewritten HTML embeds the injected shim, so it is never left in the
    // *browser* cache - only in ours. Other assets keep the upstream freshness
    // so the browser can reuse them.
    if (!ttl || contentType.includes("text/html") || contentType.includes("xhtml")) {
      headerMap["cache-control"] = "no-store";
    }
    const entry =
      ttl && out.length <= MAX_CACHE_BYTES
        ? {
            status: upstream.status,
            headers: headerMap,
            body: out,
            expires: Date.now() + ttl * 1000
          }
        : null;
    return {
      response: new Response(out, {
        status: upstream.status,
        headers: toHeaders(headerMap)
      }),
      entry
    };
  }

  // Everything else (JS, JSON, images, fonts, wasm, media) streams through
  // byte-for-byte. Small cacheable bodies are buffered once so later requests
  // skip the network entirely; everything else is streamed without buffering.
  // content-length is the compressed size for encoded responses, so cap it
  // lower there: decompression can expand text several-fold.
  const declared = Number(upstream.headers.get("content-length") || 0);
  const bufferLimit = upstream.headers.has("content-encoding")
    ? MAX_CACHE_BYTES / 16
    : MAX_CACHE_BYTES;
  if (ttl && upstream.body && declared && declared <= bufferLimit) {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    headerMap["content-length"] = buffer.length;
    const entry =
      buffer.length <= MAX_CACHE_BYTES
        ? {
            status: upstream.status,
            headers: headerMap,
            body: buffer,
            expires: Date.now() + ttl * 1000
          }
        : null;
    return {
      response: new Response(buffer, {
        status: upstream.status,
        headers: toHeaders(headerMap)
      }),
      entry
    };
  }

  return {
    response: new Response(upstream.body, {
      status: upstream.status,
      headers: toHeaders(headerMap)
    }),
    entry: null
  };
}
