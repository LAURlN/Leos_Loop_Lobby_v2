/**
 * In-memory relay for tests (and handy for experiments): behaves like the
 * Cloudflare relay, but delivers asynchronously inside one JS process.
 */
import type { PeerInfo } from '@lll/shared';
import type { Transport, TransportFactory, TransportHandlers } from './transport';

export class MemoryHub {
  private members = new Map<string, { info: PeerInfo; handlers: TransportHandlers }>();
  /** Messages delivered so far (for assertions). */
  delivered = 0;

  connect(info: PeerInfo): TransportFactory {
    return (handlers) => {
      const hub = this;
      const others = [...this.members.values()].map((m) => m.info);
      this.members.set(info.id, { info, handlers });
      queueMicrotask(() => {
        handlers.status({ state: 'connected' });
        handlers.peersReset(others);
        for (const [id, m] of hub.members) if (id !== info.id) m.handlers.peerJoined(info);
      });
      const transport: Transport = {
        selfId: info.id,
        send(payload, to) {
          const copy = payload.slice();
          queueMicrotask(() => {
            for (const [id, m] of hub.members) {
              if (id === info.id || (to && id !== to)) continue;
              hub.delivered++;
              m.handlers.message(info.id, copy);
            }
          });
        },
        close() {
          hub.members.delete(info.id);
          for (const m of hub.members.values()) m.handlers.peerLeft(info.id);
          handlers.status({ state: 'closed' });
        },
      };
      return transport;
    };
  }
}
