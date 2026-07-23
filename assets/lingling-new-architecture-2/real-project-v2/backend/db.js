import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function openDb(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS generation_tasks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, page_id TEXT NOT NULL, capability_id TEXT NOT NULL,
      module_id TEXT NOT NULL, module_name TEXT NOT NULL, status TEXT NOT NULL,
      options_json TEXT NOT NULL, provider_request_sha256 TEXT NOT NULL,
      provider_response_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS generation_results (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES generation_tasks(id), label TEXT NOT NULL,
      url TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_assists (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, page_id TEXT NOT NULL, field TEXT NOT NULL,
      prompt TEXT NOT NULL, response_text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reference_models (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, page_id TEXT NOT NULL, label TEXT NOT NULL,
      url TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  return db;
}

export function saveGeneration(db, record) {
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO generation_tasks VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`).run(
      record.id, record.userId, record.pageId, record.capabilityId, record.moduleId, record.moduleName,
      JSON.stringify(record.options), record.requestSha, record.responseSha, record.createdAt,
    );
    const insert = db.prepare(`INSERT INTO generation_results VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const result of record.results) insert.run(result.id, record.id, result.label, result.url, result.kind, result.sha256, record.createdAt);
  });
  tx();
}
export function history(db, { userId, pageId, capabilityId }) {
  return db.prepare(`SELECT t.id, t.module_name AS title, t.status, t.options_json AS optionsJson, t.created_at AS createdAt,
    (SELECT url FROM generation_results r WHERE r.task_id=t.id AND r.kind='generated' ORDER BY rowid LIMIT 1) AS preview
    FROM generation_tasks t WHERE user_id=? AND page_id=? AND capability_id=? ORDER BY created_at DESC`).all(userId, pageId, capabilityId)
    .map((item) => ({ ...item, options: JSON.parse(item.optionsJson), optionsJson: undefined }));
}
export function latestGallery(db, userId, pageId) {
  const task = db.prepare(`SELECT id FROM generation_tasks WHERE user_id=? AND page_id=? ORDER BY created_at DESC LIMIT 1`).get(userId, pageId);
  if (!task) return [];
  return db.prepare(`SELECT id,label,url,kind FROM generation_results WHERE task_id=? ORDER BY rowid`).all(task.id);
}
export function id(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
