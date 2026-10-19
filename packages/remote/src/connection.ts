import {
  ClientConnection,
  type ConnectionOptions,
} from "../../client-core/src/connection.ts";
import {
  RemoteClient,
  type Pairing,
  type RemoteClientOptions,
} from "./client.ts";

/** No Node imports. Native apps supply secure randomness, clock and WebSocket. */
export function remoteConnection(
  pairing: Pairing,
  options: ConnectionOptions,
  socketOptions?: RemoteClientOptions,
) {
  const transport = new RemoteClient(pairing, socketOptions);
  const client = new ClientConnection(pairing.deviceId, transport, options);
  const unsubscribe = transport.subscribe((frame) => {
    if (frame.type !== "connection") return;
    if (frame.status === "connected")
      void client.connected().catch(() => {
        /* The controller records and fences handshake failures. */
      });
    else client.disconnected();
  });
  return {
    client,
    connect: () => transport.connect(),
    close: () => {
      unsubscribe();
      client.close();
      transport.close();
    },
  };
}
