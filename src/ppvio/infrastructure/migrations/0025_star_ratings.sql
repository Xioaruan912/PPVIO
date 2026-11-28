-- Persistent 1-5 star user ratings feeding taste-based recommendations.
-- No media foreign key so backup/recovery can retain ratings independently.
CREATE TABLE player_star_ratings (
    media_id TEXT PRIMARY KEY,
    stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
);
CREATE INDEX idx_player_star_ratings_stars
    ON player_star_ratings(stars DESC, updated_at DESC, media_id);
CREATE TRIGGER player_star_ratings_insert_dirty AFTER INSERT ON player_star_ratings BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_star_ratings_update_dirty AFTER UPDATE ON player_star_ratings BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER player_star_ratings_delete_dirty AFTER DELETE ON player_star_ratings BEGIN
    UPDATE player_bookmark_snapshot SET revision=revision+1 WHERE singleton=1;
END;
