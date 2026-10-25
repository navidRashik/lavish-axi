import { Socket } from "node:net";

// Node's bundled fetch (undici) calls socket.setTypeOfService() right before it writes each
// HTTP/1.1 request. On macOS that setsockopt fails with EINVAL once the peer has reset the
// connection - a Lavish server whose listener is closing is enough - and the throw escapes
// undici's connect handler as an uncaught exception that no try/catch around fetch() can reach.
// Type of service is a best-effort QoS hint: a failure to apply it leaves the socket as it is, and
// the request then fails, if it must, as an ordinary rejected fetch.
const setTypeOfService = Socket.prototype.setTypeOfService;
if (typeof setTypeOfService === "function") {
  Socket.prototype.setTypeOfService = function (tos) {
    try {
      return setTypeOfService.call(this, tos);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.syscall !== "setTypeOfService") throw error;
      return this;
    }
  };
}
