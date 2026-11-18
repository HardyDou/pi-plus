import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Minimal, dependency-free client for the local remote-pi mesh broker.
 *
 * The broker speaks JSON lines over a UNIX socket
 * (`~/.pi/remote/sessions/local/broker.sock`). Three frames are enough for a
 * CLI: an unregistered `list_peers` probe (read-only — no registration, no
 * peer_joined/peer_left broadcast), a `register` handshake, and routed
 * envelopes. Cross-PC delivery rides the leader's relay bridge, so a local
 * peer can address `macbook:/path@name` without pairing anything itself.
 */

export const DEFAULT_ACK_TIMEOUT_MS = 5000;
export const BROADCAST_TARGET = "broadcast";

export class MeshError extends Error {
  constructor(message, code = "mesh") {
    super(message);
    this.name = "MeshError";
    this.code = code;
  }
}

/** Absolute path of the local broker socket (`REMOTE_PI_HOME` aware). */
export function brokerSockPath(env = process.env) {
  const home = env.REMOTE_PI_HOME || homedir();
  return join(home, ".pi", "remote", "sessions", "local", "broker.sock");
}

/** `<pc>:` prefix of a cross-PC address, or null for a local one. */
export function peerPc(address) {
  if (typeof address !== "string") return null;
  const match = /^([A-Za-z0-9._-]+):\//.exec(address);
  return match ? match[1] : null;
}

/** The address a configured session registers as (`<cwd>@<name>`), or null. */
export function sessionMeshAddress(session) {
  if (!session || !session.remotePiName) return null;
  if (session.remotePiMode === "off") return null;
  return `${session.cwd}@${session.remotePiName}`;
}

/**
 * Live peer addresses that belong to `address`. The broker appends `#N` when
 * two agents in the same directory ask for the same name, so an exact match is
 * not enough.
 */
export function livePeersFor(peers, address) {
  if (!address) return [];
  return peers.filter((peer) => peer === address || peer.startsWith(`${address}#`));
}

function attachLineReader(socket, onMessage) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a broken line must not kill the session
      }
      if (message && typeof message === "object") onMessage(message);
    }
  });
}

function connectSocket(sockPath, onError) {
  const socket = connect(sockPath);
  socket.once("error", (error) => {
    const code = error && typeof error === "object" ? error.code : undefined;
    onError(
      new MeshError(
        code === "ENOENT" || code === "ECONNREFUSED"
          ? `no mesh broker at ${sockPath} (start remote-pi inside a pi session, or run "/remote-pi")`
          : `cannot reach mesh broker at ${sockPath}: ${code ?? error.message}`,
        code === "ENOENT" || code === "ECONNREFUSED" ? "no_broker" : "socket",
      ),
    );
  });
  return socket;
}

/**
 * Read-only roster query. Registers nothing and broadcasts nothing, so it is
 * safe to call from any script at any time.
 */
export function probePeers({ sockPath = brokerSockPath(), timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new MeshError(`no reply from mesh broker at ${sockPath} within ${timeoutMs}ms`, "timeout")),
      timeoutMs,
    );
    const socket = connectSocket(sockPath, (error) => finish(error));
    attachLineReader(socket, (message) => {
      if (message.body && message.body.type === "list_peers_reply") {
        finish(null, Array.isArray(message.body.peers) ? message.body.peers.filter((p) => typeof p === "string") : []);
      }
    });
    socket.write(`${JSON.stringify({ type: "list_peers" })}\n`);
  });
}

/**
 * Join the mesh as an ephemeral peer. Resolves once the broker assigns an
 * address; the returned handle can send envelopes and wait for their ACK.
 */
export function connectPeer({ sockPath = brokerSockPath(), name = "pp-mesh", cwd = process.cwd(), timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const pendingAcks = new Map();
    const listeners = new Set();
    let address = null;
    let assignedName = null;
    let settled = false;

    const socket = connectSocket(sockPath, (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new MeshError(`mesh broker did not acknowledge the registration of "${name}" within ${timeoutMs}ms`, "timeout"));
    }, timeoutMs);

    attachLineReader(socket, (message) => {
      if (!settled) {
        if (message.type === "register_ack" && typeof message.address_assigned === "string") {
          settled = true;
          clearTimeout(timer);
          address = message.address_assigned;
          assignedName = typeof message.name_assigned === "string" ? message.name_assigned : address;
          resolve({
            socket,
            address,
            name: assignedName,
            onMessage(handler) {
              listeners.add(handler);
              return () => listeners.delete(handler);
            },
            send(to, body, re = null) {
              return sendRaw(socket, address, to, body, re);
            },
            waitAck(id, ms = DEFAULT_ACK_TIMEOUT_MS) {
              return new Promise((done) => {
                const ackTimer = setTimeout(() => {
                  pendingAcks.delete(id);
                  done({ status: "timeout", id });
                }, ms);
                pendingAcks.set(id, (result) => {
                  clearTimeout(ackTimer);
                  done(result);
                });
              });
            },
            async sendWithAck(to, body, ms = DEFAULT_ACK_TIMEOUT_MS, re = null) {
              const id = sendRaw(socket, address, to, body, re);
              const result = await this.waitAck(id, ms);
              return { ...result, id };
            },
            close() {
              try {
                socket.end();
              } catch {
                /* already gone */
              }
            },
          });
          return;
        }
        if (message.type !== "peer_joined" && message.type !== "peer_left") {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(new MeshError(`unexpected frame during registration: ${JSON.stringify(message).slice(0, 120)}`, "protocol"));
        }
        return;
      }
      if (message.body && message.body.type === "ack" && typeof message.re === "string") {
        const waiter = pendingAcks.get(message.re);
        if (waiter) {
          pendingAcks.delete(message.re);
          waiter({ status: message.body.status ?? "received", target: message.body.target, id: message.re });
        }
        return;
      }
      for (const listener of listeners) listener(message);
    });

    socket.write(`${JSON.stringify({ type: "register", name, cwd })}\n`);
  });
}

function sendRaw(socket, from, to, body, re = null) {
  const id = randomUUID();
  socket.write(`${JSON.stringify({ from, to, id, re, body })}\n`);
  return id;
}
