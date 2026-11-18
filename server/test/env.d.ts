declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ADMIN_KEY: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
}
