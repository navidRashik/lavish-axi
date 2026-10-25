import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, Socket } from "node:net";
import test from "node:test";

import "../src/socket-tos-guard.js";

// The OS refusing IP_TOS (macOS on a socket whose peer already reset it) is forced through the
// handle, so the case is the same on every platform.
test(
  "a socket option the OS refuses leaves the socket usable instead of throwing out of fetch's connect handler",
  { skip: typeof Socket.prototype.setTypeOfService !== "function" && "this Node has no setTypeOfService" },
  async () => {
    const server = createServer((peer) => peer.end());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    const socket = new Socket();
    try {
      socket.connect(port, "127.0.0.1");
      await once(socket, "connect");
      /** @type {any} */ (socket)._handle.setTypeOfService = () => -22;
      assert.equal(socket.setTypeOfService(8), socket);
      assert.throws(() => socket.setTypeOfService(300), { code: "ERR_OUT_OF_RANGE" });
    } finally {
      socket.destroy();
      server.close();
    }
  },
);
