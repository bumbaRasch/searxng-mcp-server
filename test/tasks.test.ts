import { describe, expect, it } from 'vitest';
import { declaresTasksCapability, TaskStore } from '../src/tasks.js';

describe('TaskStore', () => {
  it('creates a working task findable before any CreateTaskResult', () => {
    const store = new TaskStore();
    const record = store.create('started');
    expect(record.status).toBe('working');
    expect(record.ttlMs).toBeGreaterThan(0);
    expect(record.pollIntervalMs).toBeGreaterThan(0);
    const fetched = store.get(record.taskId);
    expect(fetched?.status).toBe('working');
    expect(fetched?.statusMessage).toBe('started');
  });

  it('mints unguessable unique ids', () => {
    const store = new TaskStore();
    const ids = new Set(Array.from({ length: 50 }, () => store.create('x').taskId));
    expect(ids.size).toBe(50);
  });

  it('records progress and finishes with an immutable terminal state', () => {
    const store = new TaskStore();
    const record = store.create('started');
    store.progress(record.taskId, 'iteration 1/2');
    expect(store.get(record.taskId)?.statusMessage).toBe('iteration 1/2');
    store.complete(record.taskId, { content: [] });
    expect(store.get(record.taskId)?.status).toBe('completed');
    expect(store.get(record.taskId)?.result).toEqual({ content: [] });
    // Terminal states are immutable: later progress/fail/cancel are no-ops.
    store.progress(record.taskId, 'late');
    store.fail(record.taskId, { code: -32603, message: 'late' });
    store.cancel(record.taskId);
    const terminal = store.get(record.taskId);
    expect(terminal?.status).toBe('completed');
    expect(terminal?.statusMessage).toBe('iteration 1/2');
    expect(terminal?.error).toBeUndefined();
  });

  it('cancels cooperatively and aborts the worker signal', () => {
    const store = new TaskStore();
    const record = store.create('started');
    const signal = store.signalFor(record.taskId);
    expect(signal?.aborted).toBe(false);
    expect(store.cancel(record.taskId)).toBe(true);
    expect(store.get(record.taskId)?.status).toBe('cancelled');
    expect(signal?.aborted).toBe(true);
    // A runner finishing after cancellation cannot resurrect the task.
    store.complete(record.taskId, { content: [] });
    expect(store.get(record.taskId)?.status).toBe('cancelled');
  });

  it('fails with the JSON-RPC error', () => {
    const store = new TaskStore();
    const record = store.create('started');
    store.fail(record.taskId, { code: -32603, message: 'boom' });
    expect(store.get(record.taskId)?.status).toBe('failed');
    expect(store.get(record.taskId)?.error).toEqual({ code: -32603, message: 'boom' });
  });

  it('expires non-terminal tasks after their TTL; terminal tasks survive', () => {
    let now = 1_000_000;
    const store = new TaskStore(600_000, 500, 64, () => now);
    const working = store.create('w');
    const done = store.create('d');
    store.complete(done.taskId, { content: [] });
    now += 600_001;
    expect(store.get(working.taskId)).toBeUndefined();
    expect(store.get(done.taskId)?.status).toBe('completed');
  });

  it('evicts the oldest task beyond the bound', () => {
    const store = new TaskStore(600_000, 500, 2);
    const first = store.create('1');
    store.create('2');
    store.create('3');
    expect(store.get(first.taskId)).toBeUndefined();
  });

  it('rejects unknown task ids on every operation', () => {
    const store = new TaskStore();
    expect(store.get('nope')).toBeUndefined();
    expect(store.cancel('nope')).toBe(false);
  });
});

describe('declaresTasksCapability', () => {
  const CAPS = {
    'io.modelcontextprotocol/clientCapabilities': {
      extensions: { 'io.modelcontextprotocol/tasks': {} },
    },
  };

  it('accepts the envelope shape carried by the request _meta', () => {
    expect(declaresTasksCapability(CAPS)).toBe(true);
    expect(declaresTasksCapability({ ...CAPS, extra: 1 })).toBe(true);
  });

  it('rejects absent, malformed or non-task extensions', () => {
    expect(declaresTasksCapability(undefined)).toBe(false);
    expect(declaresTasksCapability({})).toBe(false);
    expect(declaresTasksCapability({ 'io.modelcontextprotocol/clientCapabilities': {} })).toBe(
      false,
    );
    expect(
      declaresTasksCapability({
        'io.modelcontextprotocol/clientCapabilities': { extensions: { 'other/ext': {} } },
      }),
    ).toBe(false);
    expect(declaresTasksCapability('garbage')).toBe(false);
  });
});
