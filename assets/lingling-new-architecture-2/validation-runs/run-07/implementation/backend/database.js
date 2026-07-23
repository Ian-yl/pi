import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HOME_MODULES, TEMPLATE_ITEMS } from "./static-data.js";

export function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatCreatedAt(iso) {
  return String(iso).replace("T", " ").slice(0, 16);
}

export function openDatabase(dbPath, seedMode = "real") {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  seedPlatformConfig(db, seedMode);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS modules (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      route TEXT NOT NULL,
      icon TEXT NOT NULL,
      keywords_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      route TEXT NOT NULL,
      keywords_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS ai_assists (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      field TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      response_text TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reference_models (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS generation_tasks (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      module TEXT NOT NULL,
      module_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      status TEXT NOT NULL,
      options_json TEXT NOT NULL,
      prompt_summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uploaded_assets (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      module TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES generation_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_results (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      module TEXT NOT NULL,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      kind TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES generation_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_generation_history
      ON generation_tasks(page_id, module, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_generation_results_task
      ON generation_results(task_id, position);
  `);
}

function seedPlatformConfig(db, seedMode) {
  if (seedMode !== "demo") return;

  const insertModule = db.prepare(`
    INSERT OR IGNORE INTO modules
      (id, page_id, title, description, route, icon, keywords_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of HOME_MODULES) {
    insertModule.run(
      item.id,
      item.pageId,
      item.title,
      item.desc,
      item.route,
      item.icon,
      JSON.stringify(item.keywords ?? []),
    );
  }

  const insertTemplate = db.prepare(`
    INSERT OR IGNORE INTO templates
      (id, title, category, route, keywords_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const item of TEMPLATE_ITEMS) {
    insertTemplate.run(
      item.id,
      item.title,
      item.category,
      item.route,
      JSON.stringify(item.keywords ?? []),
    );
  }
}

export function listModules(db) {
  const rows = db
    .prepare(
      "SELECT id, title, description, route, icon FROM modules ORDER BY rowid",
    )
    .all();
  if (rows.length === 0) return HOME_MODULES.map(toModuleResponse);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    desc: row.description,
    route: row.route,
    icon: row.icon,
  }));
}

export function searchTemplates(db, query) {
  const normalized = query.trim().toLowerCase();
  const dbRows = db
    .prepare(
      "SELECT id, title, category, route, keywords_json FROM templates ORDER BY rowid",
    )
    .all();
  const source = dbRows.length
    ? dbRows.map((row) => ({
        id: row.id,
        title: row.title,
        category: row.category,
        route: row.route,
        keywords: JSON.parse(row.keywords_json || "[]"),
      }))
    : TEMPLATE_ITEMS;

  return source
    .filter((item) => {
      const haystack = [
        item.title,
        item.category,
        ...(item.keywords ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalized);
    })
    .map(({ id, title, category, route }) => ({ id, title, category, route }));
}

export function saveAssist(db, input) {
  db.prepare(`
    INSERT INTO ai_assists
      (id, page_id, field, prompt, response_text, file_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    createId("assist"),
    input.pageId,
    input.field,
    input.prompt ?? "",
    input.responseText,
    input.fileCount ?? 0,
    nowIso(),
  );
}

export function saveReferenceModel(db, input) {
  const id = input.id ?? createId("model");
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO reference_models
      (id, page_id, label, url, file_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.pageId, input.label, input.url, input.fileCount ?? 0, createdAt);
  return { id, label: input.label, url: input.url };
}

export function getReferenceModel(db, { id, pageId }) {
  return db
    .prepare(
      "SELECT id, page_id AS pageId, label, url FROM reference_models WHERE id = ? AND page_id = ?",
    )
    .get(id, pageId);
}

export function insertCompletedGeneration(db, input) {
  return withImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO generation_tasks
        (id, page_id, module, module_id, endpoint_id, status, options_json, prompt_summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.taskId,
      input.pageId,
      input.module,
      input.moduleId,
      input.endpointId,
      "completed",
      JSON.stringify(input.options ?? {}),
      input.promptSummary ?? "",
      input.createdAt,
    );

    const insertAsset = db.prepare(`
      INSERT INTO uploaded_assets
        (id, task_id, page_id, module, original_name, mime_type, size_bytes, url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const asset of input.uploads ?? []) {
      insertAsset.run(
        asset.id,
        input.taskId,
        input.pageId,
        input.module,
        asset.originalName,
        asset.mimeType,
        asset.sizeBytes,
        asset.url,
        input.createdAt,
      );
    }

    const insertResult = db.prepare(`
      INSERT INTO generation_results
        (id, task_id, page_id, module, label, url, kind, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    input.gallery.forEach((item, index) => {
      insertResult.run(
        item.id,
        input.taskId,
        input.pageId,
        input.module,
        item.label,
        item.url,
        item.kind ?? (index === 0 ? "upload" : "generated"),
        index,
        input.createdAt,
      );
    });

    return {
      taskId: input.taskId,
      status: "completed",
      gallery: input.gallery.map(({ id, label, url }) => ({ id, label, url })),
    };
  });
}

export function getLatestPageGallery(db, pageId) {
  const task = db
    .prepare(
      "SELECT id FROM generation_tasks WHERE page_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(pageId);
  if (!task) return [];
  return getTaskGallery(db, task.id);
}

export function getTaskGallery(db, taskId) {
  return db
    .prepare(
      "SELECT id, label, url FROM generation_results WHERE task_id = ? ORDER BY position",
    )
    .all(taskId);
}

export function listHistory(db, { pageId, module }) {
  const tasks = db
    .prepare(
      "SELECT id, module, created_at FROM generation_tasks WHERE page_id = ? AND module = ? ORDER BY created_at DESC LIMIT 20",
    )
    .all(pageId, module);
  const previewStmt = db.prepare(`
    SELECT url, label FROM generation_results
    WHERE task_id = ?
    ORDER BY CASE WHEN position = 0 THEN 1 ELSE 0 END, position
    LIMIT 1
  `);
  const countStmt = db.prepare(
    "SELECT COUNT(*) AS total FROM generation_results WHERE task_id = ? AND position > 0",
  );
  return tasks.map((task) => {
    const preview = previewStmt.get(task.id);
    const count = countStmt.get(task.id)?.total ?? 0;
    return {
      id: task.id,
      title: `${task.module} · ${count || 1} 张`,
      createdAt: formatCreatedAt(task.created_at),
      preview: preview?.url ?? "",
    };
  });
}

function withImmediateTransaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function toModuleResponse(item) {
  return {
    id: item.id,
    title: item.title,
    desc: item.desc,
    route: item.route,
    icon: item.icon,
  };
}
