/**
 * Resolves local `#/...` JSON pointer `$ref`s in-place, replacing each
 * `{ $ref }` node with the object it points to. Reused (non-cyclic)
 * targets are resolved once and cached so diamond references share a
 * result; a target still being resolved when it's referenced again is a
 * genuine cycle, so that occurrence is left unresolved to avoid recursing
 * forever. Non-local refs (external files, URLs) are left unresolved too,
 * since there's nothing in `document` to resolve them against — real-world
 * documents sometimes use these in vendor extensions unrelated to the
 * schemas this library cares about.
 */
export function resolveRefs<T>(document: T): T {
  const root = document as unknown;
  const resolving = new Set<object>();
  const resolved = new Map<object, unknown>();

  function resolvePointer(ref: string): unknown {
    const segments = ref
      .replace(/^#\//, '')
      .split('/')
      .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

    let node: unknown = root;
    for (const segment of segments) {
      node = (node as Record<string, unknown>)[segment];
    }
    return node;
  }

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(walk);
    }

    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      const ref = obj['$ref'];

      if (typeof ref === 'string') {
        if (!ref.startsWith('#/')) {
          return obj;
        }
        const target = resolvePointer(ref);
        if (!target || typeof target !== 'object') {
          return target;
        }
        if (resolved.has(target)) {
          return resolved.get(target);
        }
        if (resolving.has(target)) {
          return target;
        }
        resolving.add(target);
        const result = walk(target);
        resolving.delete(target);
        resolved.set(target, result);
        return result;
      }

      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = walk(value);
      }
      return result;
    }

    return node;
  }

  return walk(root) as T;
}
