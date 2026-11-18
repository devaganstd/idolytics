interface Env {
  DB: D1Database;
  ADMIN_KEY: string;
  /** Events accepted per project per UTC day; 20000 when unset. */
  DAILY_EVENT_CAP?: string;
}
