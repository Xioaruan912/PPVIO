ALTER TABLE player_bookmarks ADD COLUMN end_ticks INTEGER
    CHECK(end_ticks IS NULL OR end_ticks > position_ticks);

-- No media foreign keys: encrypted state can arrive before catalog discovery.
CREATE TABLE player_media_curation (
    media_id TEXT PRIMARY KEY,
    organized INTEGER NOT NULL CHECK(organized IN (0,1)),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
);
CREATE TABLE player_feed_preferences (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    preferred_tags TEXT NOT NULL DEFAULT '[]',
    excluded_tags TEXT NOT NULL DEFAULT '[]',
    mode TEXT NOT NULL DEFAULT 'mixed' CHECK(mode IN ('mixed','only'))
);
INSERT INTO player_feed_preferences(singleton) VALUES(1);
CREATE TABLE player_pending_media_tags (
    media_id TEXT NOT NULL,
    tag_id INTEGER NOT NULL REFERENCES player_tags(tag_id) ON DELETE CASCADE,
    tagged_at INTEGER NOT NULL CHECK(tagged_at >= 0),
    PRIMARY KEY(media_id, tag_id)
);

-- Reuse the persistent revision and exporter introduced for bookmarks.
CREATE TRIGGER player_bookmarks_updated AFTER UPDATE ON player_bookmarks
WHEN OLD.position_ticks IS NOT NEW.position_ticks OR OLD.end_ticks IS NOT NEW.end_ticks
    OR OLD.name IS NOT NEW.name OR OLD.media_id IS NOT NEW.media_id
    OR OLD.created_at IS NOT NEW.created_at BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_tags_inserted AFTER INSERT ON player_tags BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_tags_updated AFTER UPDATE ON player_tags BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_tags_deleted AFTER DELETE ON player_tags BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
    DELETE FROM feed_session_items WHERE consumed_at IS NULL;
END;
CREATE TRIGGER player_media_tags_inserted AFTER INSERT ON player_media_tags BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
    DELETE FROM feed_session_items WHERE consumed_at IS NULL;
END;
CREATE TRIGGER player_media_tags_updated AFTER UPDATE ON player_media_tags BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
    DELETE FROM feed_session_items WHERE consumed_at IS NULL;
END;
CREATE TRIGGER player_media_tags_deleted AFTER DELETE ON player_media_tags BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
    DELETE FROM feed_session_items WHERE consumed_at IS NULL;
END;
CREATE TRIGGER player_pending_media_tags_inserted AFTER INSERT ON player_pending_media_tags BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
    DELETE FROM feed_session_items WHERE consumed_at IS NULL;
END;
CREATE TRIGGER player_pending_media_tags_updated AFTER UPDATE ON player_pending_media_tags BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
    DELETE FROM feed_session_items WHERE consumed_at IS NULL;
END;
CREATE TRIGGER player_pending_media_tags_deleted AFTER DELETE ON player_pending_media_tags BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
    DELETE FROM feed_session_items WHERE consumed_at IS NULL;
END;
CREATE TRIGGER player_media_curation_inserted AFTER INSERT ON player_media_curation BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_media_curation_updated AFTER UPDATE ON player_media_curation BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_media_curation_deleted AFTER DELETE ON player_media_curation BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_feed_preferences_updated AFTER UPDATE ON player_feed_preferences
WHEN OLD.preferred_tags IS NOT NEW.preferred_tags OR OLD.excluded_tags IS NOT NEW.excluded_tags
    OR OLD.mode IS NOT NEW.mode BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
    DELETE FROM feed_session_items WHERE consumed_at IS NULL;
END;
