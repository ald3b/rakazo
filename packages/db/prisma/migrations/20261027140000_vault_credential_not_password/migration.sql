-- A login whose second value the person marked as not a password; mirrors its encrypted value.
ALTER TABLE "vault_credentials" ADD COLUMN "notPassword" BOOLEAN NOT NULL DEFAULT false;
