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
// A Worker may hold six simultaneous outbound connections in one request, and
// one Wisp session is one request. The cap is therefore per session, not per
// isolate: `StreamSlots` is one visitor's budget of six sockets, handed to the
// session's socket class below, so a page hammering its own six slots cannot
// starve anyone else's session.
//
// The seventh stream waits for a slot rather than being refused, and it waits
// for as long as it takes: a refusal reaches the browser as a TLS failure in the
// middle of a handshake, and a deadline only converts waiting into that same
// failure later. A page with 20 origins therefore loads six-at-a-time instead
// of losing the ones that did not arrive first.
//
// The wait ends one of three ways, and the slot is held only for the life of the
// socket:
//   - a slot frees, the socket connects, and the slot returns when it closes;
//   - the browser abandons the request, and the queued waiter is dropped (see
//     `cancel`, called from `close()`) so nothing leaks or connects for a dead
//     stream;
//   - the session ends and `dispose()` releases everyone still waiting.

const DEFAULT_SESSION_SLOTS = 6;

// Live pools, so /healthz can report the whole isolate without reaching into a
// session that has already ended.
const livePools = new Set();

export class StreamSlots {
  constructor(limit = DEFAULT_SESSION_SLOTS, { register = true } = {}) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
    this.disposed = false;
    if (register) livePools.add(this);
  }

  /**
   * Resolve true with a slot, false when this wait was cancelled (the stream
   * closed) or the session ended. There is deliberately no time limit.
   */
  acquire(socket) {
    if (this.disposed) return Promise.resolve(false);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.waiters.push({ socket, resolve });
    });
  }

  /** Drop a waiter whose stream closed before it reached the front. */
  cancel(socket) {
    const index = this.waiters.findIndex((waiter) => waiter.socket === socket);
    if (index === -1) return false;
    const [waiter] = this.waiters.splice(index, 1);
    waiter.resolve(false);
    return true;
  }

  release() {
    if (this.disposed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      // Hand the slot straight over: the count does not change.
      waiter.resolve(true);
      return;
    }
    if (this.active > 0) this.active--;
  }

  stats() {
    return {
      limit: this.limit,
      active: this.active,
      waiting: this.waiters.length
    };
  }

  /** End of session: nothing may wait on a budget that no longer exists. */
  dispose() {
    this.disposed = true;
    livePools.delete(this);
    for (const waiter of this.waiters.splice(0)) waiter.resolve(false);
  }
}

// Sockets built without a session pool (the spike test, a future non-Wisp user)
// still need a bound, so they share one budget rather than running unbounded.
const fallbackPool = new StreamSlots(DEFAULT_SESSION_SLOTS, { register: false });

/** Population of the isolate, for /healthz. */
export function transportStats() {
  let active = 0;
  let waiting = 0;
  for (const pool of livePools) {
    active += pool.active;
    waiting += pool.waiters.length;
  }
  return {
    scope: "session",
    limitPerSession: DEFAULT_SESSION_SLOTS,
    sessions: livePools.size,
    active,
    waiting
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

    this.slots = fallbackPool;
    this.socket = null;
    this.reader = null;
    this.writer = null;
    this.paused = false;
    this.connected = false;
    this.closed = false;
    this.wake = null;
    this.hasSlot = false;
    this.queued = false;
    this.data_queue = new AsyncQueue(this.recv_buffer_size);
  }

  get pool() {
    return this.slots || fallbackPool;
  }

  async connect(ip_override = null) {
    this.queued = true;
    const granted = await this.pool.acquire(this);
    this.queued = false;
    if (!granted) {
      // Either the browser gave up on this stream or the session ended; either
      // way there is nothing left to connect for.
      throw new Error("stream closed while queued for a connection slot");
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

  /** Return the concurrency slot to this session. Idempotent. */
  release() {
    if (!this.hasSlot) return;
    this.hasSlot = false;
    this.pool.release();
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
    // A stream the browser abandoned while it was still queued must leave the
    // queue, or it would later take a slot for a request nobody is waiting for.
    if (this.queued) this.pool.cancel(this);

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
 * The socket class a session's `ServerConnection` should build its streams
 * with. `connection.mjs` takes it from the constructor options (its own
 * `TCPSocket` hook), so the pool travels with the session without that file
 * being patched.
 */
export function sessionSocketClass(pool) {
  return class SessionTCPSocket extends NodeTCPSocket {
    constructor(hostname, port) {
      super(hostname, port);
      this.slots = pool;
    }
  };
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
