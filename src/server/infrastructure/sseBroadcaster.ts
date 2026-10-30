import type { DomainEvent, Publisher } from '../domain/ports.ts';

/** In-process pub/sub that the HTTP layer bridges to Server-Sent Events. */
export class SseBroadcaster implements Publisher {
  private readonly listeners = new Set<(event: DomainEvent) => void>();

  publish(event: DomainEvent) {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: DomainEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}
