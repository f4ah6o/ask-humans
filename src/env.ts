export interface Env {
  DB?: D1Database;
  PUBLIC_BASE_URL?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  RATE_LIMIT_SALT?: string;
}
