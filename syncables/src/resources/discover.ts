export interface ResourceRoute {
  collectionPath: string;
  itemPath: string;
  itemParam: string;
  /**
   * HTTP method a background `update` sends. Derived from the item path's
   * declared operations: `PUT` when the item path has a `put` operation
   * (a full replace), otherwise `PATCH` when it only offers a partial
   * update. Some APIs (e.g. GitHub) expose no `PUT` and require `PATCH`.
   */
  updateMethod: 'PUT' | 'PATCH';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Chooses the update method for an item path from the operations it
 * declares: prefer `PUT` (replace) when present, fall back to `PATCH`
 * when the path only offers a partial update, and default to `PUT` when
 * neither is declared (preserving prior behaviour).
 */
function updateMethodFor(
  paths: Record<string, unknown>,
  itemPath: string,
): 'PUT' | 'PATCH' {
  const item = paths[itemPath];
  if (isRecord(item) && !('put' in item) && 'patch' in item) {
    return 'PATCH';
  }
  return 'PUT';
}

/**
 * Pairs each collection path (e.g. `/pets`) with its item path
 * (e.g. `/pets/{petId}`) so mock-server and client can apply CRUD
 * semantics. Paths without such a pairing (health checks, actions, etc.)
 * aren't resources and are omitted.
 */
export function discoverResources(
  paths: Record<string, unknown>,
): ResourceRoute[] {
  const allPaths = Object.keys(paths);
  const collectionPaths = allPaths.filter((path) => !isItemPath(path));

  const resources: ResourceRoute[] = [];
  for (const collectionPath of collectionPaths) {
    const itemPath = allPaths.find(
      (path) => isItemPath(path) && isDirectChild(collectionPath, path),
    );
    if (itemPath) {
      resources.push({
        collectionPath,
        itemPath,
        itemParam: extractParamName(itemPath),
        updateMethod: updateMethodFor(paths, itemPath),
      });
    }
  }
  return resources;
}

function isItemPath(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last !== undefined && last.startsWith('{') && last.endsWith('}');
}

function extractParamName(itemPath: string): string {
  const segments = itemPath.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  return last.slice(1, -1);
}

function isDirectChild(collectionPath: string, candidate: string): boolean {
  const collectionSegments = collectionPath.split('/').filter(Boolean);
  const candidateSegments = candidate.split('/').filter(Boolean);
  return (
    candidateSegments.length === collectionSegments.length + 1 &&
    collectionSegments.every(
      (segment, index) => segment === candidateSegments[index],
    )
  );
}
