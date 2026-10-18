import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { registerSkills, SKILL_ENTRIES } from '../src/skills.js';

interface CapturedHandler {
  params: z.ZodTypeAny;
  run: (params: unknown) => unknown;
}

function fakeServer(): {
  server: McpServer;
  resources: Map<string, { read: (uri: { href: string }) => { contents: { text: string }[] } }>;
  handlers: Map<string, CapturedHandler>;
} {
  const resources = new Map();
  const handlers = new Map<string, CapturedHandler>();
  const server = {
    registerResource: (
      _name: string,
      uri: string,
      _metadata: unknown,
      read: (uri: { href: string }) => { contents: { text: string }[] },
    ) => {
      resources.set(uri, { read });
    },
    server: {
      setRequestHandler: (
        method: string,
        schemas: { params: z.ZodTypeAny; result: z.ZodTypeAny },
        run: (params: unknown) => unknown,
      ) => {
        handlers.set(method, { params: schemas.params, run });
      },
    },
  } as unknown as McpServer;
  return { server, resources, handlers };
}

describe('SKILL_ENTRIES', () => {
  it('ships the three built-in skills with valid Agent Skills frontmatter', () => {
    expect(
      SKILL_ENTRIES.map((entry) => entry.frontmatter.name).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['fact-check', 'literature-review', 'news-monitoring']);
    for (const entry of SKILL_ENTRIES) {
      // The URI's final path segment MUST equal frontmatter.name (spec).
      expect(entry.uri).toBe(`skill://${entry.frontmatter.name}/SKILL.md`);
      expect(entry.frontmatter.description).toMatch(/\w/);
      expect(entry.resources).toHaveLength(1);
      expect(entry.resources[0]?.uri).toBe(entry.uri);
    }
  });

  it('digests and sizes cover the exact bytes resources/read serves', () => {
    const { server, resources } = fakeServer();
    registerSkills(server);
    for (const entry of SKILL_ENTRIES) {
      const resource = entry.resources[0];
      expect(resource?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const read = resources.get(entry.uri);
      expect(read).toBeDefined();
      const content = read?.read({ href: entry.uri }).contents[0]?.text ?? '';
      const digest = `sha256:${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`;
      expect(resource?.digest).toBe(digest);
      expect(resource?.size).toBe(Buffer.byteLength(content, 'utf8'));
    }
  });

  it('frontmatter parses verbatim out of the served body', () => {
    const { server, resources } = fakeServer();
    registerSkills(server);
    const entry = SKILL_ENTRIES.find((candidate) => candidate.frontmatter.name === 'fact-check');
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('missing fact-check entry');
    const body = resources.get(entry.uri)?.read({ href: entry.uri }).contents[0]?.text ?? '';
    expect(body).toContain(`name: ${entry.frontmatter.name}`);
    expect(body).toContain(`description: ${entry.frontmatter.description}`);
    expect(body.startsWith('---\n')).toBe(true);
    // Spec: the entry's frontmatter MUST be identical in content to the
    // SKILL.md's — exact equality, license included.
    expect(entry.frontmatter).toEqual({
      name: 'fact-check',
      description:
        'Verify a factual claim against multiple independent web sources using the SearXNG tools, ending in a verdict with citations.',
      license: 'MIT',
    });
  });
});

describe('skills/list and skills/get', () => {
  it('lists complete entries with the cacheable-result envelope', () => {
    const { server, handlers } = fakeServer();
    registerSkills(server);
    const list = handlers.get('skills/list');
    expect(list).toBeDefined();
    const result = list?.run({}) as {
      resultType: string;
      skills: { uri: string }[];
      ttlMs: number;
      cacheScope: string;
    };
    expect(result.resultType).toBe('complete');
    expect(result.skills).toHaveLength(SKILL_ENTRIES.length);
    expect(result.ttlMs).toBeGreaterThan(0);
    expect(result.cacheScope).toBe('public');
  });

  it('gets one skill by URI and errors on unknown URIs', () => {
    const { server, handlers } = fakeServer();
    registerSkills(server);
    const get = handlers.get('skills/get');
    const entry = SKILL_ENTRIES.find(
      (candidate) => candidate.frontmatter.name === 'literature-review',
    );
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('missing literature-review entry');
    const result = get?.run({ uri: entry.uri }) as {
      resultType: string;
      skill: { uri: string };
    };
    expect(result.resultType).toBe('complete');
    expect(result.skill.uri).toBe(entry.uri);
    expect(() => get?.run({ uri: 'skill://nope/SKILL.md' })).toThrow(/Unknown skill/);
    // Spec: an unknown uri is -32602 (Invalid params), not an internal error.
    try {
      get?.run({ uri: 'skill://nope/SKILL.md' });
      throw new Error('skills/get must throw for an unknown uri');
    } catch (error) {
      expect((error as { code?: number }).code).toBe(-32602);
    }
    expect(get?.params.safeParse({ uri: 'x' }).success).toBe(true);
    expect(get?.params.safeParse({}).success).toBe(false);
  });

  it('rejects any client cursor with -32602; the catalog is one complete page', () => {
    const { server, handlers } = fakeServer();
    registerSkills(server);
    const list = handlers.get('skills/list');
    expect(list).toBeDefined();
    // The params schema stays permissive; the cursor check lives in the handler.
    expect(list?.params.safeParse({ cursor: 'x' }).success).toBe(true);
    try {
      list?.run({ cursor: 'x' });
      throw new Error('skills/list must throw for a cursor');
    } catch (error) {
      expect((error as { code?: number }).code).toBe(-32602);
    }
    expect(list?.run({})).toBeDefined();
  });
});
