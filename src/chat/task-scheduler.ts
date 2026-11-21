/** Optional scheduling seam for detached chat work and its timers.
 * Implementations must run work exactly once and preserve its result/rejection,
 * including draining admitted work while the owner cancels or disposes.
 * Omitting it keeps the original immediate invocation and native timers.
 */
export interface ChatTaskScheduler {
  now?(): number;
  run<T>(name: string, work: () => T | Promise<T>): Promise<T>;
  setTimeout(name: string, work: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout> | null | undefined): void;
}

export function chatNow(scheduler: ChatTaskScheduler | undefined): number {
  return scheduler?.now ? scheduler.now() : Date.now();
}

export function chatTimeout(scheduler: ChatTaskScheduler | undefined, name: string, work: () => void, delay: number): ReturnType<typeof setTimeout> {
  return scheduler ? scheduler.setTimeout(name, work, delay) : setTimeout(work, delay);
}

export function clearChatTimeout(scheduler: ChatTaskScheduler | undefined, timer: ReturnType<typeof setTimeout> | null | undefined): void {
  if (scheduler) scheduler.clearTimeout(timer);
  else if (timer != null) clearTimeout(timer);
}
