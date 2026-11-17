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
// Two guards keep the queue itself from becoming the problem:
//
//   - QUIET waiters are pruned. A queued stream that has carried no byte for
//     QUIET_WAIT_MS is a request the browser has abandoned, so it leaves the
//     queue instead of taking a slot later for nobody. A sweep runs while the
//     queue is non-empty.
//   - The queue is CAPPED at MAX_WAITING. Past that, a new stream is told so
//     immediately rather than parked; the page has more outstanding requests
//     than it could ever satisfy over six sockets anyway.
//
// The wait ends one of four ways, and a slot is held only for the life of the
// socket: it frees and the socket connects; the browser abandons the stream and
// `cancel` drops it; the sweep prunes it as quiet; or the session's `dispose`
// releases everyone still waiting.

const DEFAULT_SESSION_SLOTS = 6;
const MAX_WAITING = 128;
const QUIET_WAIT_MS = 90_000;
const SWEEP_MS = 15_000;

// Live pools, so /healthz can report the whole isolate without reaching into a
// session that has already ended.
const livePools = new Set();

export class StreamSlots {
  constructor(
    limit = DEFAULT_SESSION_SLOTS,
    { maxWaiting = MAX_WAITING, register = true } = {}
  ) {
    this.limit = limit;
    this.maxWaiting = maxWaiting;
    this.active = 0;
    this.waiters = [];
    this.disposed = false;
    this.sweepTimer = null;
    if (register) livePools.add(this);
  }

  /**
   * Resolve with the reason this socket has (or has not) a slot:
   * `granted`, `full`, `closed`, `quiet` or `session-ended`.
   */
  acquire(socket) {
    if (this.disposed) return Promise.resolve("session-ended");
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve("granted");
    }
    if (this.waiters.length >= this.maxWaiting) return Promise.resolve("full");

    return new Promise((resolve) => {
      this.waiters.push({ socket, resolve });
      this.scheduleSweep();
    });
  }

  /** Drop a waiter whose stream closed before it reached the front. */
  cancel(socket, reason = "closed") {
    const index = this.waiters.findIndex((waiter) => waiter.socket === socket);
    if (index === -1) return false;
    const [waiter] = this.waiters.splice(index, 1);
    waiter.resolve(reason);
    return true;
  }

  /** Prune waiters that have carried no byte for QUIET_WAIT_MS. */
  pruneQuiet(now = Date.now()) {
    let pruned = 0;
    for (const waiter of [...this.waiters]) {
      const quietFor = now - (waiter.socket.lastActivity || 0);
      if (quietFor >= QUIET_WAIT_MS && this.cancel(waiter.socket, "quiet")) {
        pruned++;
      }
    }
    if (pruned) {
      logging.debug(`(${pruned}) quiet queued streams pruned`);
    }
    return pruned;
  }

  scheduleSweep() {
    if (this.sweepTimer || this.disposed || this.waiters.length === 0) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      this.pruneQuiet();
      this.scheduleSweep();
    }, SWEEP_MS);
  }

  release() {
    if (this.disposed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      // Hand the slot straight over: the count does not change.
      waiter.resolve("granted");
      return;
    }
    if (this.active > 0) this.active--;
  }

  stats() {
    return {
      limit: this.limit,
      active: this.active,
      waiting: this.waiters.length,
      maxWaiting: this.maxWaiting
    };
  }

  /** End of session: nothing may wait on a budget that no longer exists. */
  dispose() {
    this.disposed = true;
    livePools.delete(this);
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const waiter of this.waiters.splice(0)) waiter.resolve("session-ended");
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
    maxWaitingPerSession: MAX_WAITING,
    quietWaitMs: QUIET_WAIT_MS,
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
    // Read by the queue sweep: a stream with traffic is not abandoned.
    this.lastActivity = Date.now();
    this.data_queue = new AsyncQueue(this.recv_buffer_size);
  }

  get pool() {
    return this.slots || fallbackPool;
  }

  async connect(ip_override = null) {
    this.queued = true;
    const outcome = await this.pool.acquire(this);
    this.queued = false;
    if (outcome !== "granted") {
      throw new Error(`no connection slot for ${this.hostname}: ${outcome}`);
    }
    this.hasSlot = true;

    try {
      const hostname = ip_override || this.hostname;
      this.socket = connect({ hostname, port: this.port });
      await this.socket.opened;
      this.connected = true;
      this.lastActivity = Date.now();

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
        if (value) {
          this.lastActivity = Date.now();
          await this.data_queue.put(new Uint8Array(value));
        }
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
    this.lastActivity = Date.now();
    await this.writer.ready;
    await this.writer.write(data);
  }

  async close() {
    // A stream the browser abandoned while it was still queued must leave the
    // queue, or it would later take a slot for a request nobody is waiting for.
    if (this.queued) this.pool.cancel(this, "closed");

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
