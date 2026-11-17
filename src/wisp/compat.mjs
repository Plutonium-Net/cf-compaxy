// Workers compatibility for the vendored wisp-js server.
//
// Upstream ships two of these: `compat.mjs` (Node) and `compat_browser.mjs`
// (browser). Workers are neither - `process` exists under nodejs_compat, but
// node:net/dgram/dns do not - so this file pins the parts the server actually
// uses to what workerd provides, and leaves the rest null. The one consumer is
// websocket.mjs, which needs `crypto.randomUUID` only.

export const global_this = globalThis;

export const WebSocket = globalThis.WebSocket;
export const crypto = globalThis.crypto;

// Node-only pieces: unused here, and null so an accidental import path that
// touches them fails loudly instead of silently doing something wrong.
export const WebSocketServer = null;
export const net = null;
export const dgram = null;
export const dns = null;
export const http = null;
