# Project Guidelines

## Architecture & Tech Stack

- Framework: NestJS (TypeScript).
- Feature Modules: Place all new business modules inside `src/modules/<module-name>/`.
- Core Infrastructure: Core configurations, shared services, and global modules live in `src/core/`.
- Module Layout: Any new NestJS module or major feature must organize its files into role-based subdirectories (`controllers/`, `services/`, `guards/`, `pipes/`, `dto/`, `entities/`, `health/`, `utils/`), creating only the ones it needs. Co-locate each `.spec.ts` next to the file it tests, and keep only the `.module.ts` file at the module root.

## Database & Migrations

- ORM: TypeORM with PostgreSQL.
- Database Changes: Whenever you modify or create entities (`*.entity.ts`), you MUST generate and apply a TypeORM migration using:
  - Generate: `npm run typeorm -- migration:generate src/database/migrations/<MigrationName> -d src/database/data-source.ts` (the `migration:generate` npm script already hardcodes a path, so passing another path to it fails with "Unknown argument")
  - Run: `npm run migration:run`
- Manually maintained indexes: `IDX_users_email_prefix` (`email text_pattern_ops`) and `IDX_users_display_name_prefix` (partial functional index on `lower(normalize(display_name, NFC))`), created in `1798000000000-AddAdminUserListIndexes`, cannot be expressed in the TypeORM entity. `migration:generate` will propose dropping them: remove those `DROP INDEX` statements from any generated migration and never drop them unless the admin user list search (`GET /admin/users`) is changed.

## Code Style & Standards

- Formatting & Linting: Adhere strictly to ESLint and Prettier rules defined in the repository.
- Validation: All DTOs must use class-validator and class-transformer decorators for request validation.
- Type Safety: Maintain strict TypeScript typing. Avoid using `any`.

## Workflow & Task Management

- Source of Truth: Refer to `task.md` for project requirements and tasks.
- Progress Tracking: Upon completing any task or subtask, update `task.md` by marking the corresponding item as completed (`[x]`).

## Testing

- Unit & Integration Tests: Always write unit tests (\*.spec.ts) and e2e tests for newly implemented services, endpoints, and modules.
