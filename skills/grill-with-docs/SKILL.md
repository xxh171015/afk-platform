---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

Call the Skill tool twice, for "grilling" and "domain-modeling".

When domain-modeling changes `GLOSSARY.md` or `docs/adr/`, leave those edits **uncommitted and unpushed** in this checkout. Do not `git commit` them: `plat spec confirm` on the next spec sends them onto the integration branch. The next step after grill is **to-spec**, not a planning commit (unless the person explicitly asks for one).

Grilling's platform-behaviour rule applies in this repo: recommendations about AFK stage order or finalization must follow files named in `AGENTS.md`, not search snippets alone.
