-- Every ticket body (and every kept version of it) becomes to-tickets' issue template: Parent, What to build (the old
-- body as it was) and Acceptance criteria (the old criteria as `- [ ]` lines). The criteria are parsed back out of
-- the new body with the rules of the ticket file parser, and must equal the old ones; one that does not stops the
-- whole migration, naming the ticket. Versions and spec bodies do not change.
DO $$
DECLARE
  r record;
  new_body text;
  lines text[];
  parsed text[];
  in_section boolean;
  seen boolean;
  line text;
  shown text;
  fence_lines int;
BEGIN
  FOR r IN
    SELECT 'tickets' AS tbl, t.id AS row_id, t.id AS ticket_id, t.spec_id, t.body, t.acceptance_criteria,
           t.content_version AS version
      FROM tickets t
    UNION ALL
    SELECT 'ticket_versions', v.id, v.ticket_id, t.spec_id, v.body, v.acceptance_criteria, v.version
      FROM ticket_versions v JOIN tickets t ON t.id = v.ticket_id
    ORDER BY 1, 3, 2
  LOOP
    shown := 'T-' || r.ticket_id || ' (version ' || r.version || ')';
    new_body := '## Parent' || E'\n\n' || 'S-' || r.spec_id || E'\n\n'
      || '## What to build' || E'\n\n' || rtrim(r.body, E'\n') || E'\n\n'
      || '## Acceptance criteria' || E'\n\n'
      || array_to_string(ARRAY(SELECT '- [ ] ' || c FROM unnest(r.acceptance_criteria) AS c), E'\n') || E'\n';

    -- an unclosed code fence in the old body would swallow the sections after it
    SELECT count(*) INTO fence_lines FROM regexp_split_to_table(r.body, E'\n') AS l WHERE l ~ '^\s*(```+|~~~+)';
    IF fence_lines % 2 = 1 THEN
      RAISE EXCEPTION '% cannot be migrated: its body has an unclosed code fence', shown;
    END IF;
    IF r.body ~ '(^|\n)## (Parent|Blocked by)[ \t]*(\r?\n|$)' THEN
      RAISE EXCEPTION '% cannot be migrated: its body has a "## Parent" or "## Blocked by" section of its own', shown;
    END IF;

    -- read the criteria back the way the parser does
    lines := regexp_split_to_array(new_body, E'\n');
    parsed := ARRAY[]::text[];
    in_section := false;
    seen := false;
    FOREACH line IN ARRAY lines LOOP
      IF line ~ '^## ' THEN
        IF in_section THEN EXIT; END IF;
        IF NOT seen AND line ~ '^## Acceptance criteria[ \t]*$' THEN
          in_section := true;
          seen := true;
        END IF;
      ELSIF in_section AND btrim(line) <> '' THEN
        IF line ~ '^- \[ \] \S' AND line !~ E'\r' THEN
          parsed := parsed || substring(line FROM 7);
        ELSE
          RAISE EXCEPTION '% cannot be migrated: the acceptance criterion % is not a single-line "- [ ] text"', shown, quote_literal(line);
        END IF;
      END IF;
    END LOOP;
    IF parsed IS DISTINCT FROM r.acceptance_criteria THEN
      RAISE EXCEPTION '% cannot be migrated: its acceptance criteria read back from the new body as % instead of %', shown, parsed, r.acceptance_criteria;
    END IF;

    IF r.tbl = 'tickets' THEN
      UPDATE tickets SET body = new_body WHERE id = r.row_id;
    ELSE
      UPDATE ticket_versions SET body = new_body WHERE id = r.row_id;
    END IF;
  END LOOP;
END
$$;
