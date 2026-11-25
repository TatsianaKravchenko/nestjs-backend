import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Saving transformation results (task 2.4): the storage state moves into the
 * `transformations` row (`storage_status`, `stored_file_key`,
 * `stored_file_until`, `storage_error_code`) and the separate
 * `transformation_objects` table of task 2.0 goes away. Existing objects are
 * carried over: `pending` stays pending (the worker uploads the staged copy),
 * `stored` is `available` for the default 90 days, `failed` is an error.
 */
export class AddTransformationStorage1801000000000 implements MigrationInterface {
  name = 'AddTransformationStorage1801000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."transformations_storage_status_enum" AS ENUM('not_requested', 'pending', 'available', 'error')`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD "storage_status" "public"."transformations_storage_status_enum" NOT NULL DEFAULT 'not_requested'`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD "stored_file_key" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD "stored_file_until" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD "storage_error_code" character varying(64)`,
    );

    await queryRunner.query(`
      UPDATE "transformations" t SET
        "storage_status" = CASE o."storage_status"
          WHEN 'pending' THEN 'pending'
          WHEN 'stored' THEN 'available'
          ELSE 'error' END::"public"."transformations_storage_status_enum",
        "stored_file_key" = o."storage_key",
        "stored_file_until" = CASE WHEN o."storage_status" = 'stored'
          THEN o."updated_at" + interval '90 days' END,
        "storage_error_code" = CASE WHEN o."storage_status" = 'failed'
          THEN 'staging_failed' END
      FROM "transformation_objects" o
      WHERE o."transformation_id" = t."id"`);

    await queryRunner.query(`DROP TABLE "transformation_objects"`);
    await queryRunner.query(
      `DROP TYPE "public"."transformation_objects_storage_status_enum"`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_transformations_stored_file_until" ON "transformations" ("stored_file_until") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_transformations_storage_status" ON "transformations" ("storage_status") `,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" ADD CONSTRAINT "CHK_transformations_storage" CHECK (("storage_status" = 'not_requested' AND "stored_file_key" IS NULL AND "stored_file_until" IS NULL AND "storage_error_code" IS NULL) OR ("storage_status" = 'pending' AND "stored_file_key" IS NOT NULL AND "stored_file_until" IS NULL AND "storage_error_code" IS NULL) OR ("storage_status" = 'available' AND "stored_file_key" IS NOT NULL AND "stored_file_until" IS NOT NULL AND "storage_error_code" IS NULL) OR ("storage_status" = 'error' AND "stored_file_until" IS NULL AND "storage_error_code" IS NOT NULL))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."transformation_objects_storage_status_enum" AS ENUM('pending', 'stored', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "transformation_objects" ("transformation_id" uuid NOT NULL, "storage_key" character varying(64) NOT NULL, "storage_status" "public"."transformation_objects_storage_status_enum" NOT NULL DEFAULT 'pending', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_11b106eee79840236e18678f31e" PRIMARY KEY ("transformation_id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_transformation_objects_key" ON "transformation_objects" ("storage_key") `,
    );
    await queryRunner.query(
      `ALTER TABLE "transformation_objects" ADD CONSTRAINT "FK_11b106eee79840236e18678f31e" FOREIGN KEY ("transformation_id") REFERENCES "transformations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`
      INSERT INTO "transformation_objects" ("transformation_id", "storage_key", "storage_status")
      SELECT "id", "stored_file_key",
        CASE "storage_status" WHEN 'pending' THEN 'pending' WHEN 'available' THEN 'stored' ELSE 'failed' END::"public"."transformation_objects_storage_status_enum"
      FROM "transformations" WHERE "stored_file_key" IS NOT NULL`);

    await queryRunner.query(
      `ALTER TABLE "transformations" DROP CONSTRAINT "CHK_transformations_storage"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_transformations_storage_status"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_transformations_stored_file_until"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP COLUMN "storage_error_code"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP COLUMN "stored_file_until"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP COLUMN "stored_file_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP COLUMN "storage_status"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."transformations_storage_status_enum"`,
    );
  }
}
