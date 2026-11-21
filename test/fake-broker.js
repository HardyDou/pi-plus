#!/usr/bin/env node
// Minimal stand-in for remote-pi's broker, used by test/e2e.sh and manual
// probing so the mesh code can be exercised without starting pi.
//
//   node test/fake-broker.js /tmp/fake-home/.pi/remote/sessions/local/broker.sock
//
// Speaks just enough of the protocol: list_peers, register (with peer_joined
// fan-out) and message delivery with an immediate `received` ACK. Bodies are
// delivered verbatim, except for one convention the tests use: a body starting
// with `?reply ` makes the broker answer *as the target* (`re` = your message
// id), which is how `pp mesh send --reply` is covered without a second agent.
import { createServer } from "node:net";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const sockPath = process.argv[2];
if (!sockPath) {
  console.error("usage: fake-broker.js <socket-path>");
  process.exit(2);
}
mkdirSync(dirname(sockPath), { recursive: true });
// a socket file left behind by the previous run makes bind() fail with
// EADDRINUSE, and then every check silently talks to nothing
try {
  unlinkSync(sockPath);
} catch {
  // nothing to remove
}

const peers = new Map(); // address -> socket

const server = createServer((socket) => {
  let buffer = "";
  let address = null;
  socket.setEncoding("utf8");
  const write = (frame) => socket.write(`${JSON.stringify(frame)}\n`);

  socket.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame.type === "list_peers") {
        write({ body: { type: "list_peers_reply", peers: [...peers.keys()] } });
        continue;
      }
      if (frame.type === "register") {
        address = `${frame.cwd}@${frame.name}`;
        let n = 2;
        while (peers.has(address)) address = `${frame.cwd}@${frame.name}#${n++}`;
        peers.set(address, socket);
        write({ type: "register_ack", address_assigned: address, name_assigned: frame.name });
        for (const other of peers.keys()) {
          if (other === address) continue;
          peers.get(other).write(
            `${JSON.stringify({ from: "broker", body: { type: "peer_joined", address } })}\n`,
          );
        }
        continue;
      }
      if (frame.to === undefined || frame.id === undefined) continue;
      write({ body: { type: "ack", status: "received", target: frame.to }, re: frame.id });
      const targets = frame.to === "broadcast" ? [...peers.keys()] : [].concat(frame.to);
      for (const target of targets) {
        const targetSocket = peers.get(target);
        if (!targetSocket) continue;
        targetSocket.write(
          `${JSON.stringify({
            from: frame.from,
            to: target,
            id: randomUUID(),
            re: frame.re ?? null,
            body: frame.body,
          })}\n`,
        );
      }
      if (typeof frame.body === "string" && frame.body.startsWith("?reply ") && targets.length === 1) {
        write({
          from: targets[0],
          to: frame.from,
          id: randomUUID(),
          re: frame.id,
          body: frame.body.slice("?reply ".length),
        });
      }
    }
  });

  socket.on("close", () => {
    if (address) peers.delete(address);
  });
  socket.on("error", () => {});
});

server.listen(sockPath);
