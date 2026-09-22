import { describe, expect, it } from 'vitest';
import { applyOverlay, type OverlayDocument } from '../../../src/openapi/overlay.js';

describe('applyOverlay', () => {
  it('deep-merges an update action onto the target', () => {
    const document: Record<string, unknown> = {
      components: { schemas: { Pet: { type: 'object' } } },
    };
    const overlay: OverlayDocument = {
      overlay: '1.0.0',
      info: { title: 'Test', version: '1.0.0' },
      actions: [
        {
          target: '$.components',
          update: { paginationSchemes: { offset: { type: 'pageNumber' } } },
        },
      ],
    };

    const result = applyOverlay(document, overlay);
    const components = result['components'] as Record<string, unknown>;

    expect(components['schemas']).toEqual({ Pet: { type: 'object' } });
    expect(components['paginationSchemes']).toEqual({
      offset: { type: 'pageNumber' },
    });
  });

  it('does not mutate the input document', () => {
    const document = { components: { schemas: {} } };
    applyOverlay(document, {
      overlay: '1.0.0',
      info: { title: 'Test', version: '1.0.0' },
      actions: [{ target: '$.components', update: { extra: true } }],
    });
    expect(document.components).toEqual({ schemas: {} });
  });

  it('creates missing intermediate objects along the target path', () => {
    const document = {};
    const result = applyOverlay(document, {
      overlay: '1.0.0',
      info: { title: 'Test', version: '1.0.0' },
      actions: [{ target: '$.components.schemas', update: { Pet: { type: 'object' } } }],
    });
    expect(result).toEqual({ components: { schemas: { Pet: { type: 'object' } } } });
  });

  it('removes a key at the target when the action has remove: true', () => {
    const document = { components: { schemas: { Pet: {} }, paginationSchemes: { offset: {} } } };
    const result = applyOverlay(document, {
      overlay: '1.0.0',
      info: { title: 'Test', version: '1.0.0' },
      actions: [{ target: '$.components.paginationSchemes', remove: true }],
    });
    expect(result.components).toEqual({ schemas: { Pet: {} } });
  });

  it('rejects unsupported JSONPath targets', () => {
    const overlay: OverlayDocument = {
      overlay: '1.0.0',
      info: { title: 'Test', version: '1.0.0' },
      actions: [{ target: '$.paths[*]', update: {} }],
    };
    expect(() => applyOverlay({}, overlay)).toThrow(/Unsupported overlay target/);
  });
});
