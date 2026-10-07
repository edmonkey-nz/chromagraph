import type { LogEntry, LogLevel } from '../shared/protocol.ts';

const RING_SIZE = 200;

type Listener = (entry: LogEntry) => void;

/** Console logger that also keeps a ring buffer for control windows that join late. */
export class Log {
  private ring: LogEntry[] = [];
  private listeners = new Set<Listener>();

  write(level: LogLevel, source: string, message: string): void {
    const entry: LogEntry = { time: Date.now(), level, source, message };
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    const line = `${new Date(entry.time).toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch {
        // a broken listener must never stop logging
      }
    }
  }

  info(message: string, source = 'server'): void {
    this.write('info', source, message);
  }
  warn(message: string, source = 'server'): void {
    this.write('warn', source, message);
  }
  error(message: string, source = 'server'): void {
    this.write('error', source, message);
  }

  recent(): LogEntry[] {
    return this.ring.slice();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
