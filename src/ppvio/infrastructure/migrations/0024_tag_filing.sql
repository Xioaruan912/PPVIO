-- No media/tag foreign keys: recovery must retain paths before the catalog returns.
CREATE TABLE player_tag_filing (
 media_id TEXT PRIMARY KEY,
 origin_path TEXT NOT NULL, origin_package_id TEXT NOT NULL, origin_relpath TEXT NOT NULL,
 current_path TEXT NOT NULL,
 current_package_id TEXT NOT NULL, current_relpath TEXT NOT NULL, library_root TEXT NOT NULL,
 source_endpoint TEXT NOT NULL,
 primary_tag_id INTEGER, desired_tag_id INTEGER, generation INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL CHECK(status IN ('pending','moving','retry','synced','unsupported','paused')),
 plan_source TEXT, plan_target TEXT, plan_tag_id INTEGER, plan_generation INTEGER,
 plan_package_id TEXT, plan_relpath TEXT, plan_size INTEGER, plan_etag TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 last_error TEXT, updated_at INTEGER NOT NULL,
 CHECK((plan_source IS NULL) = (plan_target IS NULL)),
 CHECK(plan_source IS NULL OR (plan_generation IS NOT NULL AND plan_size IS NOT NULL))
);
CREATE INDEX idx_player_tag_filing_due ON player_tag_filing(status,next_attempt_at);
CREATE UNIQUE INDEX idx_player_tag_filing_current ON player_tag_filing(current_path);
CREATE INDEX idx_player_tag_filing_origin ON player_tag_filing(origin_path);
CREATE UNIQUE INDEX idx_player_tag_filing_target ON player_tag_filing(plan_target) WHERE plan_target IS NOT NULL;
CREATE TRIGGER player_tag_filing_insert_dirty AFTER INSERT ON player_tag_filing BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_tag_filing_update_dirty AFTER UPDATE ON player_tag_filing BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_tag_filing_delete_dirty AFTER DELETE ON player_tag_filing BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
