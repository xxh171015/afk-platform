-- After the inserting transaction commits, LISTEN connections are told the new event's id (ADR 0009).
CREATE OR REPLACE FUNCTION afk_events_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('afk_events', NEW.id::text);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "events_notify" AFTER INSERT ON "events"
  FOR EACH ROW EXECUTE FUNCTION afk_events_notify();
