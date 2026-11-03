-- No media foreign key: recovery may precede catalog discovery. Only a completed
-- permanent deletion removes bookmarks; a temporarily missing source keeps them.
CREATE TABLE player_bookmarks (
    bookmark_id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    position_ticks INTEGER NOT NULL CHECK(position_ticks >= 0),
    name TEXT CHECK(name IS NULL OR length(name) <= 40),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    UNIQUE(media_id, position_ticks)
);

CREATE INDEX idx_player_bookmarks_recent ON player_bookmarks(created_at DESC, bookmark_id);

-- A failed remote snapshot stays dirty across restarts. Triggers also cover the
-- final deletion transaction owned by the catalog repository.
CREATE TABLE player_bookmark_snapshot (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    saved_revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO player_bookmark_snapshot(singleton) VALUES(1);

CREATE TRIGGER player_bookmarks_inserted AFTER INSERT ON player_bookmarks BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_bookmarks_deleted AFTER DELETE ON player_bookmarks BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
