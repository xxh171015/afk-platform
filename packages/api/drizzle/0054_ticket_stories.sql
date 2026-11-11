-- Tickets can name the User Story numbers in the spec they are responsible for (T-44).
ALTER TABLE "tickets" ADD COLUMN "stories" integer[] DEFAULT '{}' NOT NULL;
