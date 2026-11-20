import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * File transformations (task 2.0): the `transformations` history (metadata of
 * every attempt, indexed by `user_id, created_at, id`) and the separate
 * `transformation_objects` table for `save=true` copies.
 */
export class CreateTransformations1799000000000 implements MigrationInterface {
  name = 'CreateTransformations1799000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."transformations_type_enum" AS ENUM('file', 'image')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transformations_status_enum" AS ENUM('success', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "transformations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "type" "public"."transformations_type_enum" NOT NULL, "source_format" character varying(32) NOT NULL, "target_format" character varying(32) NOT NULL, "status" "public"."transformations_status_enum" NOT NULL, "input_size" bigint NOT NULL, "output_size" bigint, "duration_ms" integer NOT NULL, "error_code" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "completed_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_transformations_outcome" CHECK (("status" = 'success' AND "output_size" IS NOT NULL AND "output_size" >= 0 AND "error_code" IS NULL) OR ("status" = 'error' AND "output_size" IS NULL AND "error_code" IS NOT NULL)), CONSTRAINT "CHK_transformations_sizes" CHECK ("input_size" >= 0 AND "duration_ms" >= 0), CONSTRAINT "PK_64d8104dbdd72b30b53702035dd" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_transformations_user_created_id" ON "transformations" ("user_id", "created_at", "id") `,
    );
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
      `ALTER TABLE "transformations" ADD CONSTRAINT "FK_dab82b284db8c0c691498dd0375" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformation_objects" ADD CONSTRAINT "FK_11b106eee79840236e18678f31e" FOREIGN KEY ("transformation_id") REFERENCES "transformations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transformation_objects" DROP CONSTRAINT "FK_11b106eee79840236e18678f31e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transformations" DROP CONSTRAINT "FK_dab82b284db8c0c691498dd0375"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_transformation_objects_key"`,
    );
    await queryRunner.query(`DROP TABLE "transformation_objects"`);
    await queryRunner.query(
      `DROP TYPE "public"."transformation_objects_storage_status_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_transformations_user_created_id"`,
    );
    await queryRunner.query(`DROP TABLE "transformations"`);
    await queryRunner.query(`DROP TYPE "public"."transformations_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."transformations_type_enum"`);
  }
}
