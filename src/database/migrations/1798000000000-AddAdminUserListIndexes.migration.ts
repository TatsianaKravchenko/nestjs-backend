import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin user list (task 3.1.7): keyset sort indexes, the status-filtered ones,
 * and the prefix-search indexes for email and for the NFC-normalized, lowercased
 * display name (the same expression the query uses).
 */
export class AddAdminUserListIndexes1798000000000 implements MigrationInterface {
  name = 'AddAdminUserListIndexes1798000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_users_created_at_id" ON "users" ("created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_status_created_at_id" ON "users" ("status", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_status_id_created_at" ON "users" ("status", "id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_email_prefix" ON "users" ("email" text_pattern_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_display_name_prefix" ON "users" ((lower(normalize("display_name", NFC))) text_pattern_ops) WHERE "display_name" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_users_display_name_prefix"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_users_email_prefix"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_users_status_id_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_users_status_created_at_id"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_users_created_at_id"`);
  }
}
