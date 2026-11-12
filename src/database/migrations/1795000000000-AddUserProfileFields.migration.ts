import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Profile read (task 1.4): the three remaining user statuses, the display name
 * and photo key columns, and the `users@read_any` action.
 */
export class AddUserProfileFields1795000000000 implements MigrationInterface {
  name = 'AddUserProfileFields1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."users_status_enum" ADD VALUE IF NOT EXISTS 'blocked'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."users_status_enum" ADD VALUE IF NOT EXISTS 'deleting'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."users_status_enum" ADD VALUE IF NOT EXISTS 'deleted'`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "display_name" character varying(320)`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "photo_key" character varying(512)`,
    );

    // Add `read_any` to an existing `users` permission and make the policy reload.
    await queryRunner.query(
      `UPDATE "permissions"
          SET "actions" = array_append("actions", 'read_any'), "updated_at" = now()
        WHERE "name" = 'users' AND NOT ('read_any' = ANY("actions"))`,
    );
    await queryRunner.query(
      `UPDATE "rbac_policy_state" SET "version" = "version" + 1, "updated_at" = now() WHERE "id" = 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "role_grants"
          SET "actions" = array_remove("actions", 'read_any')
        WHERE "permission_id" IN (SELECT "id" FROM "permissions" WHERE "name" = 'users')`,
    );
    await queryRunner.query(
      `UPDATE "permissions"
          SET "actions" = array_remove("actions", 'read_any')
        WHERE "name" = 'users'`,
    );
    await queryRunner.query(
      `UPDATE "rbac_policy_state" SET "version" = "version" + 1, "updated_at" = now() WHERE "id" = 1`,
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "photo_key"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "display_name"`);
    // Postgres cannot drop enum values; rows must not use them before revert.
    await queryRunner.query(
      `ALTER TYPE "public"."users_status_enum" RENAME TO "users_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_status_enum" AS ENUM('pending', 'active')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" TYPE "public"."users_status_enum" USING "status"::"text"::"public"."users_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    );
    await queryRunner.query(`DROP TYPE "public"."users_status_enum_old"`);
  }
}
