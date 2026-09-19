import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

describe('scaffold', () => {
  it('exposes a version string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
