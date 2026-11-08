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
