import { USER_DATA_STORES, type UserEraser } from './user-eraser';
import { UserEraserRegistry } from './user-eraser.registry';

const eraser = (store: string): UserEraser => ({
  store,
  erase: jest.fn().mockResolvedValue({ status: 'succeeded' }),
});

describe('UserEraserRegistry', () => {
  it('lists every data store as missing until an eraser is registered', () => {
    const registry = new UserEraserRegistry();
    expect(registry.missing()).toEqual([...USER_DATA_STORES]);
    expect(registry.all()).toEqual([]);
  });

  it('is complete once every store has an eraser; a store registers once', () => {
    const registry = new UserEraserRegistry();
    for (const store of USER_DATA_STORES) registry.register(eraser(store));
    registry.register(eraser(USER_DATA_STORES[0]));

    expect(registry.missing()).toEqual([]);
    expect(registry.all()).toHaveLength(USER_DATA_STORES.length);
  });

  it('accepts an eraser of a store that is not listed', () => {
    const registry = new UserEraserRegistry();
    registry.register(eraser('extra.store'));
    expect(registry.all().map((e) => e.store)).toEqual(['extra.store']);
  });
});
