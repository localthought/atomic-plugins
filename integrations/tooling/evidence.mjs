import { rank } from './manifest-http.mjs';

/**
 * The `--plugin-routes` level a report item's derived `requires` asks for,
 * or undefined for an ungated plugin.
 */
export const neededLevel = item =>
  (Array.isArray(item?.requires) ? item.requires : [])
    .map(r => /^plugin-routes:(read-only|read-write)$/.exec(r)?.[1])
    .find(Boolean);

/**
 * Whether a gated item's evidence was recorded against a server built with
 * the `plugin-routes` feature and running at (at least) the level its
 * manifest needs. certify.mjs records the feature for its sandbox layer but
 * never a level, because cargo tests are not a running server; so until a
 * live runner records one, a gated plugin's capabilities stay "declared".
 */
export function gatedEvidenceRecorded(item) {
  const needed = neededLevel(item);
  if (needed === undefined) return true;
  const host = item.hostFeatures;

  return (
    Array.isArray(host?.features) &&
    host.features.includes('plugin-routes') &&
    typeof host.pluginRoutes === 'string' &&
    rank(host.pluginRoutes) >= rank(needed)
  );
}

/** Repository-generated evidence for bundled providers, never publisher assertions. */
export function assessEvidence(report, id, bundleSha256, now = Date.now()) {
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.layer !== 'all' ||
    report.status !== 'passed'
  )
    return null;
  const timestamp = Date.parse(report.generatedAt);
  if (!Number.isFinite(timestamp) || timestamp > now + 300000) return null;
  if (!Array.isArray(report.integrations)) return null;
  const item = report.integrations.find(i => i?.id === id);
  if (
    !item ||
    typeof item.owner !== 'string' ||
    typeof item.version !== 'string' ||
    item.status !== 'passed' ||
    item.bundleSha256 !== bundleSha256 ||
    !Array.isArray(item.checks) ||
    !item.checks.length ||
    item.checks.some(
      c => !c || typeof c.name !== 'string' || c.status !== 'passed',
    )
  )
    return null;
  if (!gatedEvidenceRecorded(item)) return null;
  for (const check of ['reproducible-bundle', 'typecheck', 'fixtures'])
    if (!item.checks.some(c => c.name === check)) return null;
  if (
    !item.checks.some(
      c => typeof c.name === 'string' && c.name.startsWith('plugins::'),
    )
  )
    return null;

  return {
    owner: item.owner,
    version: item.version,
    testedAt: report.generatedAt,
    stale: now - timestamp > 30 * 86400000,
    checks: item.checks.length,
    live: 'not-run',
  };
}
