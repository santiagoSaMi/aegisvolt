import type { Clock } from '../../application/index.ts';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
