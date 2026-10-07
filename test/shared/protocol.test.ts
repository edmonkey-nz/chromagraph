import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/shared/protocol.ts';

describe('parseClientMessage', () => {
  it('accepts valid messages', () => {
    expect(parseClientMessage('{"t":"hello","role":"output","clientId":"o1","rev":4,"projectName":"demo"}')).toEqual({
      t: 'hello',
      role: 'output',
      clientId: 'o1',
      rev: 4,
      projectName: 'demo',
    });
    expect(parseClientMessage('{"t":"patch","ops":[{"op":"set","path":["project","name"],"value":"x"}]}')?.t).toBe('patch');
  });

  it('rejects malformed input without throwing', () => {
    for (const raw of ['', 'not json', 'null', '[]', '{"t":"nope"}', '{"t":"hello","role":"admin","clientId":"x"}', '{"t":"patch","ops":[{"op":"set"}]}', '{"t":"status","status":{"fps":"fast"}}']) {
      expect(parseClientMessage(raw)).toBeNull();
    }
  });

  it('truncates very long log messages', () => {
    const m = parseClientMessage(JSON.stringify({ t: 'log', level: 'info', message: 'x'.repeat(5000) }));
    expect(m?.t === 'log' && m.message.length).toBe(2000);
  });
});
