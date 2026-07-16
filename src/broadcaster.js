/**
 * WebSocket broadcaster — manages connected clients and broadcasts messages.
 * @module broadcaster
 */

export class Broadcaster {
  constructor() {
    /** @type {Set<import('ws').WebSocket>} */
    this.clients = new Set();
  }

  /**
   * Add a WebSocket client.
   * @param {import('ws').WebSocket} ws
   */
  add(ws) {
    this.clients.add(ws);
  }

  /**
   * Remove a WebSocket client.
   * @param {import('ws').WebSocket} ws
   */
  remove(ws) {
    this.clients.delete(ws);
  }

  /**
   * Broadcast a typed message to all connected clients.
   * @param {string} type - Message type identifier
   * @param {*} data - Message payload
   */
  broadcast(type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }

  /**
   * Number of currently connected clients.
   * @returns {number}
   */
  get count() {
    return this.clients.size;
  }
}
