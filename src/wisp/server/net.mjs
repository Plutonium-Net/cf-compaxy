// Socket layer for the vendored Wisp server, on `cloudflare:sockets`.
//
// Upstream's net.mjs wraps node:net and node:dgram. Workers have neither; what
// they have is connect(), which gives a TCP stream as a pair of web streams.
// This file keeps the exact surface the rest of the server uses - `lookup_ip`,
// `NodeTCPSocket` with connect/recv/send/close/pause/resume - so connection.mjs
// and filter.mjs are unmodified upstream code.
//
// DNS is not resolved here: connect() takes the hostname and resolves it at the
// edge, and Workers has no resolver API to run the private-range check against.
// filter.mjs still refuses literal private/loopback addresses and every blocked
// hostname, and Cloudflare will not reach private space on our behalf.

import { connect } from "cloudflare:sockets";
import * as logging from "../logging.mjs";
import { AsyncQueue } from "../websocket.mjs";

// `is_node` drives upstream's Node-only paths. The socket classes below are the
// real implementation, so the flag is false.
export const is_node = false;

export function assert_on_node() {}

// Enough of net.isIP for hostname classification; ipaddr.js does the real work
// in filter.mjs.
export function isIP(value) {
  const text = String(value);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    return text.split(".").every((part) => Number(part) <= 255) ? 4 : 0;
  }
  if (text.includes(":")) return /^[0-9a-f:.%]+$/i.test(text) ? 6 : 0;
  return 0;
}

// connect() resolves hostnames itself, so the destination passes through
// unchanged. A literal IP also passes through, and filter.mjs has already
// refused the private ranges.
export async function lookup_ip(hostname) {
  return hostname;
}

// ---- concurrency -----------------------------------------------------------
//
// A Worker may hold six simultaneous outbound connections per request, and one
// Wisp session is one request. Refusing the seventh stream (what the stream
// limit options do) reaches the browser as a TLS failure in the middle of a
// handshake - a page with 200 subresources loses almost all of them. So streams
// wait for a slot instead: the page loads six-at-a-time rather than failing.
//
// The slot is held for the life of the TCP socket and returned when it closes,
// on any path - finished, refused, errored or timed out.

const MAX_CONCURRENT_STREAMS = 6;
const SLOT_TIMEOUT_MS = 30_000;

let activeSlots = 0;
const slotWaiters = [];

function acquireSlot() {
  if (activeSlots < MAX_CONCURRENT_STREAMS) {
    activeSlots++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const index = slotWaiters.indexOf(waiter);
      if (index >= 0) slotWaiters.splice(index, 1);
      resolve(false);
    }, SLOT_TIMEOUT_MS);
    slotWaiters.push(waiter);
  });
}

function releaseSlot() {
  const waiter = slotWaiters.shift();
  if (waiter) {
    // Hand the slot straight over: the count does not change.
    clearTimeout(waiter.timer);
    waiter.resolve(true);
    return;
  }
  if (activeSlots > 0) activeSlots--;
}

/** Occupancy, for /healthz. */
export function transportStats() {
  return {
    active: activeSlots,
    waiting: slotWaiters.length,
    limit: MAX_CONCURRENT_STREAMS
  };
}

/**
 * A TCP destination, addressed the way upstream expects: `connect(ip)`, then
 * `recv()`, `send(data)`, `close()`, and pause/resume for backpressure.
 *
 * Backpressure has two halves. `data_queue` bounds what we hand upstream, and
 * not reading the socket's reader is what actually pushes back on TCP.
 */
export class NodeTCPSocket {
  constructor(hostname, port) {
    this.hostname = hostname;
    this.port = port;
    this.recv_buffer_size = 128;

    this.socket = null;
    this.reader = null;
    this.writer = null;
    this.paused = false;
    this.connected = false;
    this.closed = false;
    this.wake = null;
    this.hasSlot = false;
    this.data_queue = new AsyncQueue(this.recv_buffer_size);
  }

  async connect(ip_override = null) {
    const granted = await acquireSlot();
    if (!granted) {
      throw new Error(
        `timed out after ${SLOT_TIMEOUT_MS}ms waiting for a transport slot`
      );
    }
    this.hasSlot = true;

    try {
      const hostname = ip_override || this.hostname;
      this.socket = connect({ hostname, port: this.port });
      await this.socket.opened;
      this.connected = true;

      this.writer = this.socket.writable.getWriter();
      this.reader = this.socket.readable.getReader();
      // The read loop outlives the connect() call, so it is not awaited here.
      this.pump().catch((error) => {
        logging.debug(`tcp read loop for ${this.hostname} ended: ${error}`);
      });
    } catch (error) {
      this.release();
      throw error;
    }
  }

  /** Return the concurrency slot. Idempotent. */
  release() {
    if (!this.hasSlot) return;
    this.hasSlot = false;
    releaseSlot();
  }

  async pump() {
    try {
      while (!this.closed) {
        if (this.paused) {
          await new Promise((resolve) => {
            this.wake = resolve;
          });
          continue;
        }
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) await this.data_queue.put(new Uint8Array(value));
      }
    } catch (error) {
      logging.debug(`tcp stream to ${this.hostname} ended with error - ${error}`);
    } finally {
      this.closed = true;
      this.data_queue.close();
      this.release();
    }
  }

  async recv() {
    return await this.data_queue.get();
  }

  async send(data) {
    if (!this.writer) throw new Error("tcp socket is not connected");
    await this.writer.ready;
    await this.writer.write(data);
  }

  async close() {
    if (this.closed && !this.writer && !this.socket) {
      this.release();
      return;
    }
    this.closed = true;
    this.data_queue.close();
    try {
      await this.reader?.cancel();
    } catch {
      /* already torn down */
    }
    try {
      await this.writer?.close();
    } catch {
      /* already torn down */
    }
    try {
      await this.socket?.close();
    } catch {
      /* already torn down */
    }
    this.reader = null;
    this.writer = null;
    this.socket = null;
    this.release();
  }

  pause() {
    if (this.data_queue.size >= this.recv_buffer_size) {
      this.paused = true;
    }
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    const wake = this.wake;
    this.wake = null;
    if (wake) wake();
  }
}

/**
 * Workers' connect() is TCP only, so UDP streams are refused. The refusal is
 * what the client sees as a closed stream: upstream advertises UDP support only
 * when a UDP extension is configured, and we do not configure one, so this class
 * should only be reached by a client that ignores the capabilities.
 */
export class NodeUDPSocket {
  constructor(hostname, port) {
    this.hostname = hostname;
    this.port = port;
  }

  async connect() {
    throw new Error("UDP streams are not available on Cloudflare Workers");
  }

  async recv() {
    return null;
  }

  async send() {}

  async close() {}

  pause() {}

  resume() {}
}
