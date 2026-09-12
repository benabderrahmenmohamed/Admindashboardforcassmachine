import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceId, forgetDeviceId } from './deviceId';

const KEY = 'pos.deviceId';

/** The node environment has no localStorage, so the test brings one and takes it away again. */
class FakeStorage {
  private readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error('QuotaExceededError');
    }
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  forgetDeviceId();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('deviceId', () => {
  it('makes one id and keeps it', () => {
    const first = deviceId();

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(deviceId()).toBe(first);
    expect(storage.getItem(KEY)).toBe(first);
  });

  it('keeps the id a reload finds in storage', () => {
    storage.setItem(KEY, '11111111-1111-4111-8111-111111111111');

    expect(deviceId()).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('replaces something in storage that is not an id', () => {
    storage.setItem(KEY, 'not-a-uuid');

    const id = deviceId();

    expect(id).not.toBe('not-a-uuid');
    expect(storage.getItem(KEY)).toBe(id);
  });

  it('still identifies the device for this tab when storage refuses to keep anything', () => {
    storage.failWrites = true;

    const first = deviceId();

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(deviceId()).toBe(first);
  });

  it('gives a browser with no storage at all an id of its own', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');

    expect(deviceId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
