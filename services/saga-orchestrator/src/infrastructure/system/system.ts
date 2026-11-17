import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { Clock, IdGenerator, Sleep } from '../../application/index.ts';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class RandomUuidGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }
}

export const sleep: Sleep = async (ms) => {
  await delay(ms);
};
