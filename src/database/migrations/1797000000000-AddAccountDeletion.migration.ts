import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Account deletion (task 1.6): deletion jobs and challenges, a nullable
 * password hash and the CHECKs that keep a deleted user free of personal data.
 */
export class AddAccountDeletion1797000000000 implements MigrationInterface {
  name = 'AddAccountDeletion1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."deletion_jobs_status_enum" AS ENUM('queued', 'running', 'succeeded', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "deletion_jobs" ("id" character varying(32) NOT NULL, "user_id" uuid NOT NULL, "status" "public"."deletion_jobs_status_enum" NOT NULL DEFAULT 'queued', "tombstone_email" character varying(320) NOT NULL, "attempts" integer NOT NULL DEFAULT '0', "lease_until" TIMESTAMP WITH TIME ZONE, "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_error_code" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_f926812e1b8204ecec294277aa4" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_deletion_jobs_user" ON "deletion_jobs" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_deletion_jobs_tombstone" ON "deletion_jobs" ("tombstone_email") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_deletion_jobs_due" ON "deletion_jobs" ("status", "next_attempt_at") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."deletion_challenges_method_enum" AS ENUM('otp', 'magic_link')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."deletion_challenges_consumed_reason_enum" AS ENUM('confirmed', 'replaced', 'attempts_exhausted', 'user_inactive', 'job_exists')`,
    );
    await queryRunner.query(
      `CREATE TABLE "deletion_challenges" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "method" "public"."deletion_challenges_method_enum" NOT NULL, "secret_hash" character varying(64) NOT NULL, "attempts" integer NOT NULL DEFAULT '0', "last_sent_at" TIMESTAMP WITH TIME ZONE NOT NULL, "consumed_at" TIMESTAMP WITH TIME ZONE, "consumed_reason" "public"."deletion_challenges_consumed_reason_enum", "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0a283a3b94965201c503bd36cf1" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_deletion_challenges_open_per_user" ON "deletion_challenges" ("user_id") WHERE "consumed_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_deleted_erased" CHECK ("status" <> 'deleted' OR ("display_name" IS NULL AND "photo_key" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_password_hash_required" CHECK ("password_hash" IS NOT NULL OR "status" = 'deleted')`,
    );
    await queryRunner.query(
      `ALTER TABLE "deletion_jobs" ADD CONSTRAINT "FK_ae04ae0cb86c9ee323a1cddb433" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "deletion_challenges" ADD CONSTRAINT "FK_404d73f92fca802aa9fa7759ca0" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "deletion_challenges" DROP CONSTRAINT "FK_404d73f92fca802aa9fa7759ca0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "deletion_jobs" DROP CONSTRAINT "FK_ae04ae0cb86c9ee323a1cddb433"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "CHK_users_password_hash_required"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "CHK_users_deleted_erased"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_deletion_challenges_open_per_user"`,
    );
    await queryRunner.query(`DROP TABLE "deletion_challenges"`);
    await queryRunner.query(
      `DROP TYPE "public"."deletion_challenges_consumed_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."deletion_challenges_method_enum"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_deletion_jobs_due"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_deletion_jobs_tombstone"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_deletion_jobs_user"`);
    await queryRunner.query(`DROP TABLE "deletion_jobs"`);
    await queryRunner.query(`DROP TYPE "public"."deletion_jobs_status_enum"`);
  }
}
