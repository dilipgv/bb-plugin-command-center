/**
 * Chief's tables, carried over verbatim from the standalone chief-nav plugin
 * so a fresh install builds the identical schema. These are APPENDED to the
 * command center's migration list, never reordered.
 */
export const CHIEF_MIGRATIONS: string[] = [
    // Migration 0 held a per-project Chief table. Chief is now a global
    // singleton, so the table stays (append-only rule) but is drained below.
    `CREATE TABLE IF NOT EXISTS chiefs (
       project_id TEXT PRIMARY KEY,
       thread_id TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS architects (
       thread_id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       chief_thread_id TEXT,
       task_key TEXT,
       title TEXT NOT NULL,
       mission TEXT,
       created_at INTEGER NOT NULL,
       retired INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE INDEX IF NOT EXISTS architects_project ON architects (project_id, created_at DESC)`,
    // One global Chief; the row is pinned to id 1.
    `CREATE TABLE IF NOT EXISTS chief (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       thread_id TEXT NOT NULL,
       project_id TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS project_chiefs (
       project_id TEXT PRIMARY KEY,
       thread_id TEXT NOT NULL,
       charter TEXT,
       created_at INTEGER NOT NULL,
       retired INTEGER NOT NULL DEFAULT 0
     )`,
    // Task architects now hang off a project chief, not off Chief itself.
    `ALTER TABLE architects ADD COLUMN parent_thread_id TEXT`,
    `UPDATE architects SET parent_thread_id = chief_thread_id WHERE parent_thread_id IS NULL`,
    `DELETE FROM chiefs`,
];
