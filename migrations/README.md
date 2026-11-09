# Auto-reply rules migration

Before deploying the rule-management endpoints or enabling the auto-reply rules runtime, apply the schema:

```powershell
npm run migrate:auto-reply-rules
```

The command uses the server's configured database connection and creates `auto_reply_rules` idempotently. Keep a database backup and run the migration once per environment before deploying application instances.

Run the rule validation and schedule tests with:

```powershell
npm test
```

## CRM tags and custom fields

Before deploying the project-scoped CRM tag and custom-field routes, apply:

```powershell
npm run migrate:crm-tags-custom-fields
```

The migration creates `crm_tags`, `contact_tag_mapping`, `crm_custom_fields`, and
`crm_custom_field_values`. Keep a database backup and run the migration once per
environment before deploying the application. Contact API responses expose
custom values by stable `field_key` in `custom_attributes` (and at the top level
for campaign merge variables); saved values and field definitions are always
queried with the authenticated project ID.

## Shared inbox productivity

Before deploying the project-scoped conversation labels, private notes, and
canned-reply endpoints, apply:

```powershell
npm run migrate:inbox-productivity
```

Conversation labels use the project's CRM tag catalog but are mapped separately
to each conversation. Internal notes are stored outside the messages/provider
pipeline and can only be read or created by active members of the conversation's
project. Run the server checks with `npm test`.

## Contact timeline

Before deploying the unified contact timeline, apply the tag-removal audit
columns used to record the actor and time for removed contact/conversation tags:

```powershell
npm run migrate:contact-timeline
```

The migration is safe to rerun. Existing soft-deleted tag assignments have no
recorded removal time, so their original assignment remains visible but no
historical removal event can be reconstructed. New tag removals are recorded.
The timeline endpoint only returns events for the authenticated project.

## Campaign retargeting and opt-out suppression

Before deploying report-derived campaign audiences, apply:

```powershell
npm run migrate:campaign-suppressions
```

The migration creates the project-scoped suppression ledger used for inbound
STOP/UNSUBSCRIBE requests and campaign send-time exclusion. Retargeting can use
delivery/read/failure statuses and interactive WhatsApp replies; ordinary URL
clicks are not tracked by the current campaign/reporting implementation.
