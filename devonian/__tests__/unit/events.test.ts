import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DevonianEventEmitter } from '../../src/events.js';
import { DevonianClient } from '../../src/DevonianClient.js';

type Emitter = EventEmitter | DevonianEventEmitter;

/** Runs the same script against Node's emitter and ours; returns the log. */
function script(emitter: Emitter): unknown[] {
  const log: unknown[] = [];
  const a = (v: unknown): number => log.push(`a:${v}`);
  const b = (v: unknown): number => log.push(`b:${v}`);
  const c = (v: unknown): number => log.push(`c:${v}`);
  emitter.on('x', a);
  emitter.once('x', b);
  emitter.prependListener('x', c);
  log.push(emitter.listenerCount('x'), emitter.listenerCount('x', b));
  log.push(emitter.emit('x', 1), emitter.emit('x', 2), emitter.emit('y'));
  emitter.off('x', c);
  emitter.prependOnceListener('x', b);
  emitter.once('x', a);
  emitter.removeListener('x', a); // removes the most recent registration of a
  log.push(emitter.emit('x', 3));
  log.push(emitter.eventNames(), emitter.listeners('x').length);
  // Removing during emit does not affect the current emit.
  const self = (): void => {
    emitter.off('z', self);
    log.push('self');
  };
  emitter.on('z', self);
  emitter.on('z', () => log.push('after'));
  emitter.emit('z');
  emitter.emit('z');
  emitter.removeAllListeners('x');
  log.push(emitter.eventNames());
  emitter.removeAllListeners();
  log.push(emitter.eventNames());
  log.push(emitter.setMaxListeners(3) === emitter, emitter.getMaxListeners());
  return log;
}

describe('DevonianEventEmitter', () => {
  it('behaves like node:events for the methods it implements', () => {
    expect(script(new DevonianEventEmitter())).toEqual(
      script(new EventEmitter()),
    );
  });

  it('throws on an unhandled error event, like node:events', () => {
    const emitter = new DevonianEventEmitter();
    const boom = new Error('boom');
    expect(() => emitter.emit('error', boom)).toThrow(boom);
    expect(() => emitter.emit('error', 'text')).toThrow('Unhandled error');
    emitter.on('error', () => undefined);
    expect(emitter.emit('error', boom)).toBe(true);
  });

  it('calls listeners with the emitter as this', () => {
    const emitter = new DevonianEventEmitter();
    const seen: unknown[] = [];
    emitter.on('x', function (this: unknown) {
      seen.push(this);
    });
    emitter.emit('x');
    expect(seen[0]).toBe(emitter);
  });

  it('keeps separate listener state per instance', () => {
    const a = new DevonianEventEmitter();
    const b = new DevonianEventEmitter();
    a.on('x', () => undefined);
    expect(b.listenerCount('x')).toBe(0);
  });

  it('accepts a Node EventEmitter subclass where a DevonianClient is expected', () => {
    class NodeClient extends EventEmitter {
      async add(obj: object): Promise<object> {
        return obj;
      }
    }
    // Type-level check: compiles only while DevonianClient stays structurally
    // compatible with node:events.
    const client: DevonianClient<object, object> = new NodeClient();
    expect(client).toBeInstanceOf(EventEmitter);
  });
});
