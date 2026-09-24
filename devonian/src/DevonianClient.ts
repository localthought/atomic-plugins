import { DevonianEventEmitter } from './events.js';

export abstract class DevonianClient<
  ModelWithoutId,
  Model,
> extends DevonianEventEmitter {
  abstract add(obj: ModelWithoutId): Promise<Model>;
}
