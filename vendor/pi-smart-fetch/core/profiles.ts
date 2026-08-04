/**
 * Kept as a compatibility export for callers of the upstream package.  The
 * vendored transport is Node's standard http/https client and has no browser
 * fingerprint profiles to discover.
 */
export function getLatestChromeProfile(
  _listProfiles: () => string[] = () => [],
): string {
  return "node";
}
