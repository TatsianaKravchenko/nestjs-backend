import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Transformation history (task 2.3): the retention cleanup selects rows by
 * `created_at` alone (all users), which `IDX_transformations_user_created_id`
 * cannot serve because `user_id` leads it.
 */
export class AddTransformationsCreatedAtIndex1800000000000 implements MigrationInterface {
  name = 'AddTransformationsCreatedAtIndex1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_transformations_created_at" ON "transformations" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_transformations_created_at"`,
    );
  }
}
