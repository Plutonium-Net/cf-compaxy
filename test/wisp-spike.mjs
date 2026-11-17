// Wisp transport smoke test.
//
// Connects to a running `wrangler dev` with the real wisp-js client, opens one
// TCP stream to example.com:80, sends a raw HTTP/1.1 request and checks that the
// response bytes come back through the Worker's cloudflare:sockets bridge.
//
//     node test/wisp-spike.mjs [ws://127.0.0.1:8787/wisp/test/]

import { ClientConnection } from "@mercuryworkshop/wisp-js/client";

const endpoint = process.argv[2] || "ws://127.0.0.1:8787/wisp/test/";
const target = process.argv[3] || "example.com";
const port = Number(process.argv[4] || 80);

const REQUEST = `GET / HTTP/1.1\r\nHost: ${target}\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
const TIMEOUT_MS = 20000;

let opened = 0;
let bytes = 0;
let text = "";

function finish(code, message) {
  console.log(`${code === 0 ? "PASS" : "FAIL"}: ${message}`);
  process.exit(code);
}

const timer = setTimeout(() => {
  finish(1, `timed out after ${TIMEOUT_MS}ms (${bytes} bytes received)`);
}, TIMEOUT_MS);

const connection = new ClientConnection(endpoint);

connection.onerror = () => {
  clearTimeout(timer);
  finish(1, "the Wisp WebSocket reported an error before the stream opened");
};

connection.onclose = () => {
  clearTimeout(timer);
  finish(1, `the Wisp session closed unexpectedly (${bytes} bytes received)`);
};

connection.onopen = () => {
  console.log(`session open: ${endpoint} (wisp v${connection.wisp_version})`);
  opened = 1;

  const stream = connection.create_stream(target, port);
  stream.onmessage = (data) => {
    bytes += data.byteLength ?? data.length;
    text += new TextDecoder().decode(data);
  };
  stream.onclose = (reason) => {
    clearTimeout(timer);
    const status = /^HTTP\/1\.[01] \d{3}/.exec(text);
    if (!status) {
      finish(1, `stream closed (reason ${reason}) without an HTTP status line; got ${JSON.stringify(text.slice(0, 80))}`);
    }
    if (bytes < 200) {
      finish(1, `stream closed (reason ${reason}) after only ${bytes} bytes`);
    }
    finish(
      0,
      `${bytes} bytes through the Worker (${status[0]}), stream closed with reason ${reason}`
    );
  };

  console.log(`stream opened to ${target}:${port}, sending ${REQUEST.length} bytes`);
  stream.send(new TextEncoder().encode(REQUEST));
};

if (!opened) {
  console.log(`connecting to ${endpoint} ...`);
}
