import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsersAndRegistrationAttempts1792757954507 implements MigrationInterface {
  name = 'CreateUsersAndRegistrationAttempts1792757954507';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."users_status_enum" AS ENUM('pending', 'active')`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying(320) NOT NULL, "password_hash" character varying(255) NOT NULL, "status" "public"."users_status_enum" NOT NULL DEFAULT 'pending', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."registration_attempts_method_enum" AS ENUM('otp', 'magic_link')`,
    );
    await queryRunner.query(
      `CREATE TABLE "registration_attempts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "method" "public"."registration_attempts_method_enum" NOT NULL, "secret_hash" character varying(64) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "failed_attempts" integer NOT NULL DEFAULT '0', "consumed_at" TIMESTAMP WITH TIME ZONE, "last_sent_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_372ce69c22c671fb4b1bf8f0759" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "registration_attempts" ADD CONSTRAINT "FK_9a26ac70f3e3e46d42d0fb46ef2" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "registration_attempts" DROP CONSTRAINT "FK_9a26ac70f3e3e46d42d0fb46ef2"`,
    );
    await queryRunner.query(`DROP TABLE "registration_attempts"`);
    await queryRunner.query(
      `DROP TYPE "public"."registration_attempts_method_enum"`,
    );
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."users_status_enum"`);
  }
}
