/**
 * @fileoverview This file handles easy one liners to send logs to the server for debugging purposes.
 * @module serverSenders
 * @requires react
 * @requires bridgething-client
 * 
 */

import { BridgethingClient } from '@bridgething/client'



export function sendServerLog(client: BridgethingClient, message: string) {
  const send = (message: object) =>
    client.forward.json(message).catch(() => undefined);
  send({ type: 'app:log', message });
}