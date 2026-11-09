import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLoginAttempts1794205500711 implements MigrationInterface {
  name = 'CreateLoginAttempts1794205500711';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."login_attempts_method_enum" AS ENUM('otp', 'magic_link')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."login_attempts_consumed_reason_enum" AS ENUM('confirmed', 'replaced', 'attempts_exhausted', 'user_inactive')`,
    );
    await queryRunner.query(
      `CREATE TABLE "login_attempts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "method" "public"."login_attempts_method_enum" NOT NULL, "secret_hash" character varying(64) NOT NULL, "attempts" integer NOT NULL DEFAULT '0', "last_sent_at" TIMESTAMP WITH TIME ZONE NOT NULL, "consumed_at" TIMESTAMP WITH TIME ZONE, "consumed_reason" "public"."login_attempts_consumed_reason_enum", "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_070e613c8f768b1a70742705c5b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_login_attempts_open_per_user" ON "login_attempts" ("user_id") WHERE "consumed_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "login_attempts" ADD CONSTRAINT "FK_5f88175f39e2b2ebf9e2295a9fd" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "login_attempts" DROP CONSTRAINT "FK_5f88175f39e2b2ebf9e2295a9fd"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_login_attempts_open_per_user"`,
    );
    await queryRunner.query(`DROP TABLE "login_attempts"`);
    await queryRunner.query(
      `DROP TYPE "public"."login_attempts_consumed_reason_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."login_attempts_method_enum"`);
  }
}
