import { backoffDelay } from '../../shared/backoff.ts';
import {
  HEARTBEAT_TIMEOUT_MS,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/protocol.ts';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface SocketHandlers {
  /** Called on every (re)connect; return the hello message to introduce this client. */
  hello(): ClientMessage;
  message(msg: ServerMessage): void;
  state?(state: ConnectionState): void;
}

/**
 * WebSocket that never gives up: reconnects with jittered backoff, and treats a silent
 * server (no ping within the timeout) as dropped. Handler exceptions are contained so a
 * bad message can never kill the connection loop.
 */
export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private lastHeard = 0;
  private retryTimer: number | null = null;
  private watchdog: number;
  private _state: ConnectionState = 'closed';

  constructor(
    private url: string,
    private handlers: SocketHandlers,
  ) {
    this.watchdog = window.setInterval(() => this.checkAlive(), 2_500);
    this.connect();
  }

  get state(): ConnectionState {
    return this._state;
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private setState(s: ConnectionState): void {
    if (s === this._state) return;
    this._state = s;
    try {
      this.handlers.state?.(s);
    } catch (err) {
      console.error('socket state handler failed', err);
    }
  }

  private connect(): void {
    this.retryTimer = null;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastHeard = performance.now();
      // Hello must be the first message: the server ignores anything before it.
      try {
        this.send(this.handlers.hello());
      } catch (err) {
        console.error('hello failed', err);
      }
      this.setState('open');
    };
    ws.onmessage = (ev) => {
      this.lastHeard = performance.now();
      const msg = parseServerMessage(String(ev.data));
      if (!msg) return;
      if (msg.t === 'ping') {
        this.send({ t: 'pong' });
        return;
      }
      try {
        this.handlers.message(msg);
      } catch (err) {
        console.error('message handler failed', err);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setState('closed');
      this.scheduleRetry();
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    const delay = backoffDelay(this.attempt++);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private checkAlive(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && performance.now() - this.lastHeard > HEARTBEAT_TIMEOUT_MS) {
      const dead = this.ws;
      this.ws = null;
      try {
        dead.close();
      } catch {
        // already closing
      }
      this.setState('closed');
      this.scheduleRetry();
    }
  }

  dispose(): void {
    clearInterval(this.watchdog);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export function makeClientId(prefix: string): string {
  const key = `data-wrangler:${prefix}-id`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
