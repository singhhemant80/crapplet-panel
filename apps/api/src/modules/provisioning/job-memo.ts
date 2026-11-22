/**
 * A provisioning job's memory: values saved on the queued job itself, so a run that a worker restart
 * interrupted (and the queue picks up again) carries on — e.g. keeps the password of the reinstall
 * already sent to Virtualizor — instead of repeating a destructive step.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface JobMemo {
  values: Record<string, unknown>;
  save: (values: Record<string, unknown>) => Promise<unknown>;
  /** this run re-picks a run that was interrupted part-way */
  resumed: boolean;
}
const store = new AsyncLocalStorage<JobMemo>();

export const withJobMemo = <T>(memo: JobMemo, fn: () => Promise<T>) => store.run(memo, fn);

/** Save a value on the running job before a step that must not be repeated (no-op outside a job). */
export async function remember(key: string, value: unknown) {
  const m = store.getStore();
  if (!m) return;
  m.values = { ...m.values, [key]: value };
  await m.save(m.values);
}
export const recall = <T = unknown>(key: string): T | undefined => store.getStore()?.values[key] as T | undefined;
/** True when this run re-picks a job that was interrupted (worker restart / crash) part-way. */
export const isResumedRun = () => !!store.getStore()?.resumed;
