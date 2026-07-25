CREATE TABLE resources (id TEXT PRIMARY KEY, checksum TEXT NOT NULL);
CREATE TABLE submissions (id TEXT PRIMARY KEY, resource_ids TEXT NOT NULL, status TEXT NOT NULL);
