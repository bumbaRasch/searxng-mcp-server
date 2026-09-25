import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import {
  buildCategoryEnvelope,
  categoryEnvelopeSchema,
  categoryInputSchema,
  categoryDefinitions,
  defineCategory,
  type CategoryDefinition,
} from '../src/categories/index.js';

const resultSchema = z.object({ title: z.string(), url: z.string() });
type TestResult = z.infer<typeof resultSchema>;

function project(raw: unknown): TestResult | undefined {
  const parsed = resultSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

describe('defineCategory', () => {
  it('returns the definition as-is with R inferred from the schemas', () => {
    const definition: CategoryDefinition<TestResult> = defineCategory({
      tool: { name: 'test_search', title: 'Test search', description: 'Test category.' },
      upstream: { categories: ['general'], supportsTimeRange: true },
      heading: 'Test',
      resultSchema,
      projectResult: project,
      renderResultLines: (result) => [result.title, result.url],
    });
    expect(definition.tool.name).toBe('test_search');
    expect(definition.upstream).toEqual({ categories: ['general'], supportsTimeRange: true });
    expect(definition.projectResult({ title: 't', url: 'u' })).toEqual({ title: 't', url: 'u' });
    expect(definition.projectResult('garbage')).toBeUndefined();
    expect(definition.renderResultLines({ title: 't', url: 'u' })).toEqual(['t', 'u']);
  });

  it('derives the envelope schema from the result schema', () => {
    const definition = defineCategory({
      tool: { name: 'test_search', title: 'Test search', description: 'Test category.' },
      upstream: { categories: ['general'], supportsTimeRange: false },
      heading: 'Test',
      resultSchema,
      projectResult: project,
      renderResultLines: (result) => [result.title, result.url],
    });
    const envelope = {
      query: 'q',
      results: [{ title: 't', url: 'u' }],
      suggestions: [],
      unresponsiveEngines: [],
    };
    expect(definition.envelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      definition.envelopeSchema.safeParse({ ...envelope, results: [{ title: 't' }] }).success,
    ).toBe(false);
    expect(z.toJSONSchema(definition.envelopeSchema)).toEqual(
      z.toJSONSchema(categoryEnvelopeSchema(resultSchema)),
    );
  });
});

describe('categoryDefinitions registry', () => {
  it('equips every registered category with its own envelope schema', () => {
    expect(categoryDefinitions.length).toBeGreaterThanOrEqual(6);
    const emptyEnvelope = { query: 'q', results: [], suggestions: [], unresponsiveEngines: [] };
    const schemas = new Set(categoryDefinitions.map((entry) => entry.envelopeSchema));
    expect(schemas.size).toBe(categoryDefinitions.length);
    for (const entry of categoryDefinitions) {
      expect(entry.envelopeSchema.safeParse(emptyEnvelope).success).toBe(true);
    }
  });
});

describe('categoryInputSchema', () => {
  it('composes the shared atoms without time_range when unsupported', () => {
    const schema = categoryInputSchema({ supportsTimeRange: false });
    expect('time_range' in schema.shape).toBe(false);
    expect(schema.safeParse({ query: '' }).success).toBe(false);
    // Unknown keys are stripped, and the max_results default applies.
    expect(schema.parse({ query: 'q', time_range: 'day' })).toEqual({
      query: 'q',
      max_results: 10,
    });
  });

  it('composes time_range when supported and validates its values', () => {
    const schema = categoryInputSchema({ supportsTimeRange: true });
    expect('time_range' in schema.shape).toBe(true);
    expect(schema.safeParse({ query: 'q', time_range: 'week' }).success).toBe(true);
    expect(schema.safeParse({ query: 'q', time_range: 'fortnight' }).success).toBe(false);
  });
});

describe('categoryEnvelopeSchema', () => {
  const schema = categoryEnvelopeSchema(resultSchema);
  const envelope = {
    query: 'q',
    results: [{ title: 't', url: 'u' }],
    suggestions: ['s'],
    unresponsiveEngines: [['a', 'b']],
  };

  it('validates a well-formed envelope and rejects bad results', () => {
    expect(schema.safeParse(envelope).success).toBe(true);
    expect(schema.safeParse({ ...envelope, results: [{ title: 't' }] }).success).toBe(false);
    expect(schema.safeParse({ ...envelope, query: 5 }).success).toBe(false);
  });

  it('models unresponsiveEngines as a plain fixed-length string array, not a tuple', () => {
    // z.tuple -> items:false, which draft-07-only clients reject.
    const json = z.toJSONSchema(schema) as JsonSchemaNode;
    const pair = json.properties?.unresponsiveEngines?.items;
    expect(pair).not.toBe(false);
    expect(pair).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 2,
    });
  });
});

interface JsonSchemaNode {
  type?: string;
  items?: JsonSchemaNode | boolean;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchemaNode>;
}

describe('buildCategoryEnvelope', () => {
  const good = { title: 't', url: 'https://r.test/x' };
  const dirty = {
    query: 'q',
    results: [null, 'junk', 42, { title: 'no url' }, good, good, good],
    suggestions: ['s1', 5, null, 's2'],
    unresponsive_engines: [['kagi', 'timeout'], ['brave'], 'google', 7, [], [42, 'x'], ['ddg', 42]],
  };

  it('drops invalid items, then applies the max_results slice', () => {
    expect(buildCategoryEnvelope(dirty, 2, project).results).toEqual([good, good]);
    expect(buildCategoryEnvelope(dirty, 10, project).results).toHaveLength(3);
  });

  it('keeps only string suggestions and [string, string] engine pairs', () => {
    const envelope = buildCategoryEnvelope(dirty, 10, project);
    expect(envelope.suggestions).toEqual(['s1', 's2']);
    expect(envelope.unresponsiveEngines).toEqual([
      ['kagi', 'timeout'],
      ['brave', ''],
      ['ddg', '42'],
    ]);
    expect(
      envelope.unresponsiveEngines.every(
        ([engine, message]) => typeof engine === 'string' && typeof message === 'string',
      ),
    ).toBe(true);
  });

  it('caps suggestions and unresponsive engines at 20 entries', () => {
    const noisy = {
      ...dirty,
      suggestions: Array.from({ length: 30 }, (_, i) => `s${i}`),
      unresponsive_engines: Array.from({ length: 25 }, (_, i) => [`e${i}`, 'timeout']),
    };
    const envelope = buildCategoryEnvelope(noisy, 10, project);
    expect(envelope.suggestions).toHaveLength(20);
    expect(envelope.unresponsiveEngines).toHaveLength(20);
  });

  it('tolerates garbage payloads and clamps a negative limit', () => {
    const empty = { query: '', results: [], suggestions: [], unresponsiveEngines: [] };
    expect(buildCategoryEnvelope(null, 5, project)).toEqual(empty);
    expect(buildCategoryEnvelope('nope', 5, project)).toEqual(empty);
    expect(buildCategoryEnvelope(dirty, -3, project).results).toEqual([]);
  });

  it('applies the keep filter after projection but before the slice', () => {
    const raw = {
      results: [
        { title: 'a', url: 'https://a.test' },
        { title: 'b', url: 'https://b.test' },
        { title: 'c', url: 'https://c.test' },
      ],
    };
    const envelope = buildCategoryEnvelope(
      raw,
      2,
      project,
      (item) => item.url !== 'https://b.test',
    );
    expect(envelope.results.map((item) => item.title)).toEqual(['a', 'c']);
  });
});
