# Project Guidelines

## Architecture & Tech Stack

- Framework: NestJS (TypeScript).
- Feature Modules: Place all new business modules inside `src/modules/<module-name>/`.
- Core Infrastructure: Core configurations, shared services, and global modules live in `src/core/`.

## Database & Migrations

- ORM: TypeORM with PostgreSQL.
- Database Changes: Whenever you modify or create entities (`*.entity.ts`), you MUST generate and apply a TypeORM migration using:
  - Generate: `npm run migration:generate -- src/database/migrations/<MigrationName>`
  - Run: `npm run migration:run`

## Code Style & Standards

- Formatting & Linting: Adhere strictly to ESLint and Prettier rules defined in the repository.
- Validation: All DTOs must use class-validator and class-transformer decorators for request validation.
- Type Safety: Maintain strict TypeScript typing. Avoid using `any`.

## Workflow & Task Management

- Source of Truth: Refer to `task.md` for project requirements and tasks.
- Progress Tracking: Upon completing any task or subtask, update `task.md` by marking the corresponding item as completed (`[x]`).

## Testing

- Unit & Integration Tests: Always write unit tests (\*.spec.ts) and e2e tests for newly implemented services, endpoints, and modules.
