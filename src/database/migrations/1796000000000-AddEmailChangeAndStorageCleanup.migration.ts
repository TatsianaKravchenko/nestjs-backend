import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Profile update (task 1.5): email change challenges, storage cleanup jobs,
 * the display name and photo key constraints, and the `update_any` and
 * `delete_any` actions of the `users` permission.
 */
export class AddEmailChangeAndStorageCleanup1796000000000 implements MigrationInterface {
  name = 'AddEmailChangeAndStorageCleanup1796000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."storage_cleanup_jobs_reason_enum" AS ENUM('photo_replaced', 'photo_cleared')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."storage_cleanup_jobs_status_enum" AS ENUM('queued', 'succeeded', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "storage_cleanup_jobs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "object_key" character varying(512) NOT NULL, "reason" "public"."storage_cleanup_jobs_reason_enum" NOT NULL, "status" "public"."storage_cleanup_jobs_status_enum" NOT NULL DEFAULT 'queued', "attempts" integer NOT NULL DEFAULT '0', "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_error_code" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_storage_cleanup_jobs" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_storage_cleanup_jobs_due" ON "storage_cleanup_jobs" ("status", "next_attempt_at")`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."email_change_challenges_method_enum" AS ENUM('otp', 'magic_link')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."email_change_challenges_consumed_reason_enum" AS ENUM('confirmed', 'replaced', 'attempts_exhausted', 'user_inactive', 'admin_override', 'email_conflict')`,
    );
    await queryRunner.query(
      `CREATE TABLE "email_change_challenges" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "new_email" character varying(320) NOT NULL, "method" "public"."email_change_challenges_method_enum" NOT NULL, "secret_hash" character varying(64) NOT NULL, "attempts" integer NOT NULL DEFAULT '0', "last_sent_at" TIMESTAMP WITH TIME ZONE NOT NULL, "consumed_at" TIMESTAMP WITH TIME ZONE, "consumed_reason" "public"."email_change_challenges_consumed_reason_enum", "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_email_change_challenges" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_email_change_challenges_open_per_user" ON "email_change_challenges" ("user_id") WHERE "consumed_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_change_challenges" ADD CONSTRAINT "FK_2d50dc81fe2af1767b64cb4607d" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // Existing names are normalized in place (no column rewrite, no data loss)
    // so the new constraint and the shorter type can be applied.
    await queryRunner.query(
      `UPDATE "users"
          SET "display_name" = NULLIF(left(btrim(normalize("display_name", NFC)), 80), '')
        WHERE "display_name" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "display_name" TYPE character varying(80)`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_display_name" CHECK ("display_name" IS NULL OR ("display_name" IS NFC NORMALIZED AND char_length("display_name") BETWEEN 1 AND 80))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_photo_key" ON "users" ("photo_key")`,
    );

    // Add the new actions to an existing `users` permission and reload the policy.
    await queryRunner.query(
      `UPDATE "permissions"
          SET "actions" = "actions" || ARRAY(
                SELECT a FROM unnest(ARRAY['update', 'update_any', 'delete', 'delete_any', 'list']::varchar[]) a
                 WHERE NOT (a = ANY("actions"))),
              "updated_at" = now()
        WHERE "name" = 'users'`,
    );
    await queryRunner.query(
      `UPDATE "rbac_policy_state" SET "version" = "version" + 1, "updated_at" = now() WHERE "id" = 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "role_grants"
          SET "actions" = array_remove(array_remove("actions", 'update_any'), 'delete_any')
        WHERE "permission_id" IN (SELECT "id" FROM "permissions" WHERE "name" = 'users')`,
    );
    await queryRunner.query(
      `UPDATE "permissions"
          SET "actions" = array_remove(array_remove("actions", 'update_any'), 'delete_any')
        WHERE "name" = 'users'`,
    );
    await queryRunner.query(
      `UPDATE "rbac_policy_state" SET "version" = "version" + 1, "updated_at" = now() WHERE "id" = 1`,
    );

    await queryRunner.query(`DROP INDEX "public"."UQ_users_photo_key"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "CHK_users_display_name"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "display_name" TYPE character varying(320)`,
    );

    await queryRunner.query(
      `ALTER TABLE "email_change_challenges" DROP CONSTRAINT "FK_2d50dc81fe2af1767b64cb4607d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_email_change_challenges_open_per_user"`,
    );
    await queryRunner.query(`DROP TABLE "email_change_challenges"`);
    await queryRunner.query(
      `DROP TYPE "public"."email_change_challenges_consumed_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."email_change_challenges_method_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_storage_cleanup_jobs_due"`,
    );
    await queryRunner.query(`DROP TABLE "storage_cleanup_jobs"`);
    await queryRunner.query(
      `DROP TYPE "public"."storage_cleanup_jobs_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."storage_cleanup_jobs_reason_enum"`,
    );
  }
}
