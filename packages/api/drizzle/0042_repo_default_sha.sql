-- The default branch head last seen by host-sync (docs/specs/m3-platform.md「多需求并行」).
-- Null until the first look; a later different SHA is main having moved.
ALTER TABLE "repos" ADD COLUMN "default_sha" text;
