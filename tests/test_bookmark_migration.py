from __future__ import annotations

from contextlib import closing
from pathlib import Path
import shutil
import sqlite3
from tempfile import TemporaryDirectory
import unittest

from ppvio.infrastructure.migration import run_migrations


MIGRATIONS = Path(__file__).parents[1] / "src/ppvio/infrastructure/migrations"


class BookmarkMigrationTests(unittest.TestCase):
    def test_backup_api_copy_preserves_existing_schema_and_rows_when_bookmarks_are_added(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            old_migrations = root / "old-migrations"
            old_migrations.mkdir()
            for migration in MIGRATIONS.glob("*.sql"):
                if int(migration.name.split("_", 1)[0]) <= 20:
                    shutil.copyfile(migration, old_migrations / migration.name)
            with closing(sqlite3.connect(root / "source.sqlite3")) as source:
                source.row_factory = sqlite3.Row
                run_migrations(source, old_migrations)
                source.execute("INSERT INTO media(media_id,kind,size_bytes) VALUES(?,?,?)",
                               ("a" * 64, "video", 321))
                source.execute("INSERT INTO player_long_video_progress VALUES(?,?,?)", ("a" * 64, 12.5, 1))
                source.commit()
                tables = [row[0] for row in source.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('player_schema_migrations','sqlite_sequence')")]
                before = {table: [tuple(row) for row in source.execute(f'SELECT * FROM "{table}"')] for table in tables}
                with closing(sqlite3.connect(root / "rehearsal.sqlite3")) as copied:
                    copied.row_factory = sqlite3.Row
                    source.backup(copied)
                    run_migrations(copied, MIGRATIONS)
                    for table, rows in before.items():
                        self.assertEqual([tuple(row) for row in copied.execute(f'SELECT * FROM "{table}"')], rows, table)
                    copied.execute("INSERT INTO player_bookmarks(bookmark_id,media_id,position_ticks,name,created_at) VALUES(?,?,?,?,?)",
                                   ("b" * 32, "f" * 64, 123, "offline scene", 1))
                    copied.commit()
                    self.assertEqual(copied.execute("SELECT revision,saved_revision FROM player_bookmark_snapshot").fetchone()[:], (1, 0))
                    copied.execute("DELETE FROM player_bookmarks")
                    self.assertEqual(copied.execute("SELECT revision FROM player_bookmark_snapshot").fetchone()[0], 2)
                    self.assertEqual(copied.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                    settled = copied.total_changes
                    run_migrations(copied, MIGRATIONS)
                    self.assertEqual(copied.total_changes, settled)
                self.assertIsNone(source.execute("SELECT 1 FROM sqlite_master WHERE name='player_bookmarks'").fetchone())
                self.assertEqual(source.execute("SELECT COUNT(*) FROM media").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
