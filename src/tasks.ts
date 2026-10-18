/**
 * io.modelcontextprotocol/tasks (Stage 4): a process-scope task store backing
 * task-augmented `tools/call`. Per the ext-tasks spec: CreateTaskResult is
 * only sent after the task is findable here; ids are unguessable (UUIDv4);
 * there is no tasks/list; cancellation is cooperative; terminal states are
 * immutable; tasks expire after their TTL.
 */

import { randomUUID } from 'node:crypto';
import { isRecord, sanitizeMeta } from './categories/shared.js';

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'cancelled' | 'failed';

export interface TaskRecord {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  /** Present when completed: the CallToolResult-shaped final result. */
  result?: Record<string, unknown>;
  /** Present when failed: the JSON-RPC error object. */
  error?: Record<string, unknown>;
}

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
/** Store bound: beyond it, finished tasks are evicted oldest-first; working
 * tasks are only evicted when the store would otherwise refuse creation. */
const MAX_TASKS = 64;

const TERMINAL: readonly TaskStatus[] = ['completed', 'cancelled', 'failed'];

export class TaskStore {
  private readonly entries = new Map<string, TaskRecord>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly defaultTtlMs: number = DEFAULT_TTL_MS,
    private readonly defaultPollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
    private readonly maxTasks: number = MAX_TASKS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Drops a task from both maps — every removal path must go through this,
   * or the AbortController leaks. */
  private drop(taskId: string): void {
    this.entries.delete(taskId);
    this.controllers.delete(taskId);
  }

  /** Creates a working task; the record is findable before CreateTaskResult
   * is sent (spec: no speculative polling). Returns the seeded Task shape. */
  create(statusMessage: string): TaskRecord {
    this.prune();
    const nowIso = new Date(this.now()).toISOString();
    const record: TaskRecord = {
      taskId: randomUUID(),
      status: 'working',
      statusMessage,
      createdAt: nowIso,
      lastUpdatedAt: nowIso,
      ttlMs: this.defaultTtlMs,
      pollIntervalMs: this.defaultPollIntervalMs,
    };
    if (this.entries.size >= this.maxTasks) {
      // Prefer evicting a finished task; a full store of working tasks is
      // pathological, and there the bound wins over the in-flight task.
      const finished = [...this.entries].find(([, value]) => TERMINAL.includes(value.status));
      const victim = finished !== undefined ? finished[0] : this.entries.keys().next().value;
      if (victim !== undefined) this.drop(victim);
    }
    this.entries.set(record.taskId, record);
    this.controllers.set(record.taskId, new AbortController());
    return { ...record };
  }

  /** The worker's cancellation signal for a task. */
  signalFor(taskId: string): AbortSignal | undefined {
    return this.controllers.get(taskId)?.signal;
  }

  /** The detailed task view; expired tasks read as unknown. */
  get(taskId: string): TaskRecord | undefined {
    const record = this.entries.get(taskId);
    if (record === undefined) return undefined;
    if (
      record.ttlMs !== null &&
      this.now() >= Date.parse(record.createdAt) + record.ttlMs &&
      !TERMINAL.includes(record.status)
    ) {
      this.drop(taskId);
      return undefined;
    }
    return { ...record };
  }

  /** Progress update; terminal states are immutable. */
  progress(taskId: string, statusMessage: string): void {
    const record = this.entries.get(taskId);
    if (record === undefined || TERMINAL.includes(record.status)) return;
    record.statusMessage = sanitizeMeta(statusMessage).slice(0, 300);
    record.lastUpdatedAt = new Date(this.now()).toISOString();
  }

  /** Terminal: the CallToolResult-shaped final result. */
  complete(taskId: string, result: Record<string, unknown>): void {
    this.finish(taskId, 'completed', { result });
  }

  /** Terminal: a JSON-RPC error occurred. */
  fail(taskId: string, error: Record<string, unknown>): void {
    this.finish(taskId, 'failed', { error });
  }

  /** Cooperative cancellation: marks the task cancelled and aborts the
   * worker's signal so the next checkpoint observes it. */
  cancel(taskId: string): boolean {
    const record = this.entries.get(taskId);
    if (record === undefined) return false;
    if (!TERMINAL.includes(record.status)) {
      record.status = 'cancelled';
      record.statusMessage = 'Cancellation requested.';
      record.lastUpdatedAt = new Date(this.now()).toISOString();
    }
    this.controllers.get(taskId)?.abort();
    this.controllers.delete(taskId);
    return true;
  }

  private finish(
    taskId: string,
    status: TaskStatus,
    extra: { result?: Record<string, unknown>; error?: Record<string, unknown> },
  ): void {
    const record = this.entries.get(taskId);
    if (record === undefined || TERMINAL.includes(record.status)) return;
    record.status = status;
    if (extra.result !== undefined) record.result = extra.result;
    if (extra.error !== undefined) record.error = extra.error;
    record.lastUpdatedAt = new Date(this.now()).toISOString();
    this.controllers.delete(taskId);
  }

  /** Drops TTL-expired non-terminal tasks so the store cannot leak. */
  private prune(): void {
    const now = this.now();
    for (const [taskId, record] of this.entries) {
      if (
        !TERMINAL.includes(record.status) &&
        record.ttlMs !== null &&
        now >= Date.parse(record.createdAt) + record.ttlMs
      ) {
        this.drop(taskId);
      }
    }
  }
}

/** Production task store; tests inject their own via ToolDeps.tasks. */
export const sharedTaskStore = new TaskStore();

/** True when the request declared the io.modelcontextprotocol/tasks client
 * capability (read from the per-request `_meta` envelope, both eras). */
export function declaresTasksCapability(envelope: unknown): boolean {
  if (!isRecord(envelope)) return false;
  const capabilities = envelope['io.modelcontextprotocol/clientCapabilities'];
  if (!isRecord(capabilities)) return false;
  const extensions = capabilities.extensions;
  if (!isRecord(extensions)) return false;
  return isRecord(extensions['io.modelcontextprotocol/tasks']);
}
