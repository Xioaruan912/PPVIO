CREATE TABLE player_history_settings (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch>=0)
);
INSERT INTO player_history_settings(singleton) VALUES(1);
CREATE TABLE player_view_history (
 media_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL CHECK(seen_at>=0), position_seconds REAL NOT NULL CHECK(position_seconds>=0)
);
CREATE INDEX idx_player_view_history_time ON player_view_history(seen_at DESC,media_id);
CREATE TABLE player_channels (
 channel_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, filters TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=0)
);
CREATE TABLE player_media_ratings (
 media_id TEXT PRIMARY KEY, premium INTEGER NOT NULL CHECK(premium IN (0,1)), updated_at INTEGER NOT NULL CHECK(updated_at>=0)
);
CREATE TABLE player_bookmark_tags (
 bookmark_id TEXT NOT NULL REFERENCES player_bookmarks(bookmark_id) ON DELETE CASCADE,
 tag_id INTEGER NOT NULL REFERENCES player_tags(tag_id) ON DELETE CASCADE, PRIMARY KEY(bookmark_id,tag_id)
);
CREATE TABLE player_tag_aliases (
 alias TEXT PRIMARY KEY COLLATE NOCASE, tag_id INTEGER NOT NULL REFERENCES player_tags(tag_id) ON DELETE CASCADE
);
CREATE TABLE player_tag_parents (
 tag_id INTEGER PRIMARY KEY REFERENCES player_tags(tag_id) ON DELETE CASCADE,
 parent_id INTEGER NOT NULL REFERENCES player_tags(tag_id) ON DELETE CASCADE, CHECK(tag_id<>parent_id)
);
CREATE TABLE player_manual_covers (
 media_id TEXT PRIMARY KEY, jpeg BLOB NOT NULL CHECK(length(jpeg) BETWEEN 4 AND 65536),
 at_seconds REAL NOT NULL CHECK(at_seconds>=0), version TEXT NOT NULL CHECK(length(version)=64),
 updated_at INTEGER NOT NULL CHECK(updated_at>=0)
);
CREATE TRIGGER player_channels_insert_dirty AFTER INSERT ON player_channels BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_channels_update_dirty AFTER UPDATE ON player_channels BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_channels_delete_dirty AFTER DELETE ON player_channels BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_media_ratings_insert_dirty AFTER INSERT ON player_media_ratings BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_media_ratings_update_dirty AFTER UPDATE ON player_media_ratings BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_media_ratings_delete_dirty AFTER DELETE ON player_media_ratings BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_bookmark_tags_insert_dirty AFTER INSERT ON player_bookmark_tags BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_bookmark_tags_update_dirty AFTER UPDATE ON player_bookmark_tags BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_bookmark_tags_delete_dirty AFTER DELETE ON player_bookmark_tags BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_tag_aliases_insert_dirty AFTER INSERT ON player_tag_aliases BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_tag_aliases_update_dirty AFTER UPDATE ON player_tag_aliases BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_tag_aliases_delete_dirty AFTER DELETE ON player_tag_aliases BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_tag_parents_insert_dirty AFTER INSERT ON player_tag_parents BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_tag_parents_update_dirty AFTER UPDATE ON player_tag_parents BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_tag_parents_delete_dirty AFTER DELETE ON player_tag_parents BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_manual_covers_insert_dirty AFTER INSERT ON player_manual_covers BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_manual_covers_update_dirty AFTER UPDATE ON player_manual_covers BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_manual_covers_delete_dirty AFTER DELETE ON player_manual_covers BEGIN
 UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
