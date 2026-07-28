/**
 * In-process WebSocket fanout for the scheduler UI.
 */

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export type HubEvent =
  | { type: "snapshot"; workers: unknown[]; run?: unknown }
  | { type: "worker"; worker: unknown }
  | { type: "job"; job: unknown }
  | { type: "result"; runId: string; testId: string; status: string; durationMs: number; source?: string; titlePath?: string }
  | { type: "run"; run: { id: string; status: string } }
  /** Repo files changed — UI should reload `git diff HEAD` + plan. */
  | { type: "diff" };

type Client = {
  ws: WebSocket;
  runId?: string;
};

export type EventHub = {
  broadcast: (event: HubEvent) => void;
  /** Send to clients subscribed to runId (or all if event is global). */
  emit: (event: HubEvent) => void;
  close: () => void;
  clientCount: () => number;
};

export function attachHub(
  server: HttpServer,
  opts: {
    path?: string;
    getSnapshot: () => Promise<{ workers: unknown[]; run?: unknown }>;
  },
): EventHub {
  const path = opts.path ?? "/ws";
  const wss = new WebSocketServer({ server, path });
  const clients = new Set<Client>();

  const send = (client: Client, event: HubEvent) => {
    if (client.ws.readyState !== client.ws.OPEN) return;
    client.ws.send(JSON.stringify(event));
  };

  const emit = (event: HubEvent) => {
    for (const client of clients) {
      if (
        event.type === "result" ||
        event.type === "job" ||
        event.type === "run"
      ) {
        const runId =
          event.type === "run"
            ? event.run.id
            : event.type === "job"
              ? (event.job as { runId?: string }).runId
              : event.runId;
        if (client.runId && runId && client.runId !== runId) continue;
      }
      send(client, event);
    }
  };

  wss.on("connection", (ws) => {
    const client: Client = { ws };
    clients.add(client);
    void opts
      .getSnapshot()
      .then((snap) => {
        send(client, { type: "snapshot", workers: snap.workers, run: snap.run });
      })
      .catch((err) => {
        console.error("[hub] snapshot failed", err);
      });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          type?: string;
          runId?: string;
        };
        if (msg.type === "subscribe" && typeof msg.runId === "string") {
          client.runId = msg.runId;
        }
      } catch {
        // ignore malformed
      }
    });

    ws.on("close", () => {
      clients.delete(client);
    });
  });

  return {
    broadcast: emit,
    emit,
    close: () => {
      for (const c of clients) c.ws.close();
      wss.close();
    },
    clientCount: () => clients.size,
  };
}
