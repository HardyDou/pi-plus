import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brokerSockPath,
  connectPeer,
  livePeersFor,
  MeshError,
  peerPc,
  probePeers,
  sessionMeshAddress,
} from "../src/mesh.js";

process.env.REMOTE_PI_HOME = "/tmp/remote-pi-home-test";

test("brokerSockPath honours REMOTE_PI_HOME", () => {
  assert.equal(brokerSockPath(), "/tmp/remote-pi-home-test/.pi/remote/sessions/local/broker.sock");
  assert.equal(brokerSockPath({ REMOTE_PI_HOME: "/x" }), "/x/.pi/remote/sessions/local/broker.sock");
  assert.match(brokerSockPath({}), /\.pi\/remote\/sessions\/local\/broker\.sock$/);
});

test("peerPc separates local and cross-PC addresses", () => {
  assert.equal(peerPc("/data/work@work"), null);
  assert.equal(peerPc("macbook:/Users/hardy/code@api"), "macbook");
  assert.equal(peerPc("pc-2:/srv/x@y#3"), "pc-2");
});

test("sessionMeshAddress mirrors what remote-pi registers", () => {
  assert.equal(
    sessionMeshAddress({ cwd: "/data/work", remotePiName: "work", remotePiMode: "config" }),
    "/data/work@work",
  );
  assert.equal(sessionMeshAddress({ cwd: "/x", remotePiName: "y", remotePiMode: "env" }), "/x@y");
  assert.equal(sessionMeshAddress({ cwd: "/x", remotePiName: "y", remotePiMode: "off" }), null);
  assert.equal(sessionMeshAddress({ cwd: "/x", remotePiName: null }), null);
});

test("livePeersFor accepts broker #N collision suffixes", () => {
  const peers = ["/a@x", "/a@x#2", "/a@x2", "macbook:/a@x"];
  assert.deepEqual(livePeersFor(peers, "/a@x"), ["/a@x", "/a@x#2"]);
  assert.deepEqual(livePeersFor(peers, "/a@nope"), []);
  assert.deepEqual(livePeersFor(peers, null), []);
});

test("probePeers reports no_broker when the socket is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-mesh-miss-"));
  try {
    await assert.rejects(probePeers({ sockPath: join(dir, "nope.sock"), timeoutMs: 500 }), (err) => {
      assert.ok(err instanceof MeshError);
      assert.equal(err.code, "no_broker");
      assert.match(err.message, /no mesh broker at/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Minimal stand-in for remote-pi's broker: probe + register + ack. */
function fakeBroker(sockPath, { ackStatus = "received", peers = ["/a@x", "macbook:/b@y"] } = {}) {
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const frame = JSON.parse(line);
        if (frame.type === "list_peers") {
          socket.write(`${JSON.stringify({ body: { type: "list_peers_reply", peers } })}\n`);
        } else if (frame.type === "register") {
          socket.write(
            `${JSON.stringify({ type: "register_ack", address_assigned: `/work@${frame.name}`, name_assigned: frame.name })}\n`,
          );
        } else {
          socket.write(
            `${JSON.stringify({ body: { type: "ack", status: ackStatus, target: frame.to }, re: frame.id })}\n`,
          );
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(sockPath, () => resolve(server)));
}

test("probePeers reads the roster without registering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-mesh-probe-"));
  const sockPath = join(dir, "broker.sock");
  const server = await fakeBroker(sockPath);
  try {
    const peers = await probePeers({ sockPath, timeoutMs: 2000 });
    assert.deepEqual(peers, ["/a@x", "macbook:/b@y"]);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connectPeer registers, sends and surfaces the ACK", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-mesh-send-"));
  const sockPath = join(dir, "broker.sock");
  const server = await fakeBroker(sockPath);
  const peer = await connectPeer({ sockPath, name: "pp-mesh", cwd: "/work", timeoutMs: 2000 });
  try {
    assert.equal(peer.address, "/work@pp-mesh");
    assert.equal(peer.name, "pp-mesh");
    const ack = await peer.sendWithAck("/a@x", "hello", 2000);
    assert.equal(ack.status, "received");
    assert.equal(ack.target, "/a@x");
    assert.match(ack.id, /^[0-9a-f-]{36}$/);
  } finally {
    peer.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("busy peers are reported, not silently dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-mesh-busy-"));
  const sockPath = join(dir, "broker.sock");
  const server = await fakeBroker(sockPath, { ackStatus: "busy" });
  const peer = await connectPeer({ sockPath, name: "pp-mesh", timeoutMs: 2000 });
  try {
    const ack = await peer.sendWithAck("/a@x", "hello", 2000);
    assert.equal(ack.status, "busy");
  } finally {
    peer.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
