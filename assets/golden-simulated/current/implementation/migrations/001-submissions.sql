CREATE TABLE submissions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE submission_events (id TEXT PRIMARY KEY, submissionId TEXT NOT NULL, FOREIGN KEY (submissionId) REFERENCES submissions(id) ON DELETE CASCADE);
CREATE INDEX idx_submission_events_submission ON submission_events(submissionId);
