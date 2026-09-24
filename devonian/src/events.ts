/**
 * A dependency-free, synchronous event emitter with the `node:events`
 * `EventEmitter` methods Devonian and its subclasses use, so the package
 * root loads in browsers, workers and service workers without a
 * `node:events` polyfill.
 *
 * Semantics follow Node's: listeners run synchronously in registration order,
 * `emit` returns whether any listener ran, and emitting `'error'` with no
 * listener throws the error (or wraps a non-Error value). Not implemented:
 * the `'newListener'`/`'removeListener'` meta-events, captureRejections, and
 * max-listener leak warnings (`setMaxListeners` only stores the value).
 *
 * Listener state is kept in a module-private WeakMap rather than declared
 * instance fields, so the class stays structurally compatible with
 * `node:events` `EventEmitter`: an existing client that extends Node's
 * emitter is still assignable where a `DevonianClient` is expected. What
 * does change from 0.6.x: `DevonianClient` and `DevonianTable` instances are
 * no longer `instanceof` Node's `EventEmitter`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;
type EventName = string | symbol;

interface Registered {
  listener: Listener;
  /** The wrapper registered by `once`, so `off(original)` can find it. */
  wrapper?: Listener;
}

interface State {
  events: Map<EventName, Registered[]>;
  maxListeners: number;
}

const states = new WeakMap<object, State>();

function state(emitter: object): State {
  let s = states.get(emitter);
  if (!s) {
    s = { events: new Map(), maxListeners: 10 };
    states.set(emitter, s);
  }
  return s;
}

function register(
  emitter: object,
  eventName: EventName,
  entry: Registered,
  prepend: boolean,
): void {
  const events = state(emitter).events;
  const list = events.get(eventName) ?? [];
  if (prepend) {
    list.unshift(entry);
  } else {
    list.push(entry);
  }
  events.set(eventName, list);
}

function onceEntry(
  emitter: DevonianEventEmitter,
  eventName: EventName,
  listener: Listener,
): Registered {
  const entry: Registered = { listener };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entry.wrapper = (...args: any[]): void => {
    emitter.removeListener(eventName, listener);
    listener.apply(emitter, args);
  };
  return entry;
}

/**
 * Drop-in replacement for `node:events` `EventEmitter` in Devonian's own
 * classes. Has no declared instance fields or private members, only methods.
 */
export class DevonianEventEmitter {
  static defaultMaxListeners = 10;

  on(eventName: EventName, listener: Listener): this {
    return this.addListener(eventName, listener);
  }

  addListener(eventName: EventName, listener: Listener): this {
    register(this, eventName, { listener }, false);
    return this;
  }

  prependListener(eventName: EventName, listener: Listener): this {
    register(this, eventName, { listener }, true);
    return this;
  }

  once(eventName: EventName, listener: Listener): this {
    register(this, eventName, onceEntry(this, eventName, listener), false);
    return this;
  }

  prependOnceListener(eventName: EventName, listener: Listener): this {
    register(this, eventName, onceEntry(this, eventName, listener), true);
    return this;
  }

  off(eventName: EventName, listener: Listener): this {
    return this.removeListener(eventName, listener);
  }

  removeListener(eventName: EventName, listener: Listener): this {
    const events = state(this).events;
    const list = events.get(eventName);
    if (!list) {
      return this;
    }
    // Like Node: remove the most recently added matching registration.
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]!;
      if (entry.listener === listener || entry.wrapper === listener) {
        list.splice(i, 1);
        break;
      }
    }
    if (list.length === 0) {
      events.delete(eventName);
    }
    return this;
  }

  removeAllListeners(eventName?: EventName): this {
    const events = state(this).events;
    if (eventName === undefined) {
      events.clear();
    } else {
      events.delete(eventName);
    }
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(eventName: EventName, ...args: any[]): boolean {
    const list = state(this).events.get(eventName);
    if (!list || list.length === 0) {
      if (eventName === 'error') {
        const err = args[0];
        if (err instanceof Error) {
          throw err;
        }
        throw new Error(`Unhandled error. (${String(err)})`);
      }
      return false;
    }
    // Snapshot, so listeners added or removed during emit do not affect it.
    for (const entry of [...list]) {
      (entry.wrapper ?? entry.listener).apply(this, args);
    }
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  listenerCount(eventName: EventName, listener?: Function): number {
    const list = state(this).events.get(eventName) ?? [];
    if (listener === undefined) {
      return list.length;
    }
    return list.filter((e) => e.listener === listener || e.wrapper === listener)
      .length;
  }

  // `Function[]`, not `Listener[]`, to match `node:events`' declared return
  // type, so a Node `EventEmitter` subclass stays assignable to this class.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  listeners(eventName: EventName): Function[] {
    return (state(this).events.get(eventName) ?? []).map((e) => e.listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  rawListeners(eventName: EventName): Function[] {
    return (state(this).events.get(eventName) ?? []).map(
      (e) => e.wrapper ?? e.listener,
    );
  }

  eventNames(): EventName[] {
    return [...state(this).events.keys()];
  }

  setMaxListeners(n: number): this {
    state(this).maxListeners = n;
    return this;
  }

  getMaxListeners(): number {
    return state(this).maxListeners;
  }
}
