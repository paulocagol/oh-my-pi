<system-reminder>
Auto-learn skill curator ran at session start.
{{#if archivedCount}}
Archived (no recorded use in {{archiveAfterDays}}d; moved to `managed-skills/.archive/`, no longer loaded): {{join archived ", "}}
{{/if}}
{{#if markedStale}}
Marked stale (no recorded use in {{staleAfterDays}}d; still loaded): {{pluralize markedStale "skill" "skills"}}
{{/if}}
No action needed. Restoring an archived skill is a move back out of `.archive/`.
</system-reminder>
