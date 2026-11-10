<!-- tracker-doc template for mattpocock/skills@59db609eb1e18aaf59b63284d0e52255aff0c63c -->
# Issue tracker: the afk-platform and {{HOST_NAME}}

This repo's specs and tickets live in the **afk-platform**; everything else stays on **{{HOST_NAME}}**. Pick the side
by what the skill is working on:

| A skill says …                                        | Goes to       | Use            |
| ----------------------------------------------------- | ------------- | -------------- |
| to-spec: publish the spec                             | the platform  | `plat`         |
| to-tickets: publish tickets                           | the platform  | `plat`         |
| implement: fetch the ticket                           | the platform  | `plat`         |
| code-review: find the spec                            | the platform  | `plat`         |
| wayfinder: the map and its tickets                    | {{HOST_NAME}} | `{{HOST_CLI}}` |
| triage: labels, needs-info, ready-for-agent on issues | {{HOST_NAME}} | `{{HOST_CLI}}` |
| {{HOST_PRS}} treated as requests                      | {{HOST_NAME}} | `{{HOST_CLI}}` |

The platform has no labels and no comments, which is why triage and wayfinder stay on {{HOST_NAME}}. Each part
below is complete for its side; do not look for either one elsewhere.
