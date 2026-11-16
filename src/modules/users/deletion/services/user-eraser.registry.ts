import { Injectable } from '@nestjs/common';

import { USER_DATA_STORES, type UserEraser } from './user-eraser';

/** Erasers register themselves on module init; the worker runs them all. */
@Injectable()
export class UserEraserRegistry {
  private readonly erasers = new Map<string, UserEraser>();

  register(eraser: UserEraser): void {
    this.erasers.set(eraser.store, eraser);
  }

  all(): UserEraser[] {
    return [...this.erasers.values()];
  }

  /** Data stores that have no eraser; empty when the registry is complete. */
  missing(): string[] {
    return USER_DATA_STORES.filter((store) => !this.erasers.has(store));
  }
}
