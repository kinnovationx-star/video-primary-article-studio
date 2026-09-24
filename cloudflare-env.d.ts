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
    IMAGES: ImagesBinding;
    BROWSER: Fetcher;
    ASSETS: Fetcher;
    DATA_ENCRYPTION_KEY?: string;
    ANTHROPIC_API_KEY?: string;
    OPENAI_API_KEY?: string;
    WORDPRESS_URL?: string;
    WORDPRESS_USERNAME?: string;
    WORDPRESS_APPLICATION_PASSWORD?: string;
    UBERSUGGEST_ACCESS_TOKEN?: string;
    GOOGLE_OAUTH_CLIENT_ID?: string;
    GOOGLE_OAUTH_CLIENT_SECRET?: string;
    GOOGLE_OAUTH_REDIRECT_URI?: string;
    NOTION_API_KEY?: string;
    PAGESPEED_API_KEY?: string;
  }
}
