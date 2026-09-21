/**
 * Bindings available to the independent video article Worker.
 *
 * Wrangler generates an equivalent declaration at deploy time. Keeping this
 * small source declaration tracked makes `tsc --noEmit` deterministic in
 * GitHub Actions as well.
 */
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FILES: R2Bucket;
    ASSETS: Fetcher;
  }
}
