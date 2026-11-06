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
