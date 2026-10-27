-- A website login kept only for the run that asked for it.
CREATE TABLE "run_logins" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filledAt" TIMESTAMP(3),
    "filledComputerId" TEXT,
    "endedAt" TIMESTAMP(3),
    CONSTRAINT "run_logins_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "run_logins_botId_endedAt_idx" ON "run_logins"("botId", "endedAt");
CREATE INDEX "run_logins_spaceId_idx" ON "run_logins"("spaceId");
CREATE INDEX "run_logins_runId_name_idx" ON "run_logins"("runId", "name");

ALTER TABLE "run_logins" ADD CONSTRAINT "run_logins_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_logins" ADD CONSTRAINT "run_logins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_logins" ADD CONSTRAINT "run_logins_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_logins" ADD CONSTRAINT "run_logins_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Space-owned, like bot_secrets: the app's Space, or the explicit system bypass.
ALTER TABLE "run_logins" ENABLE ROW LEVEL SECURITY;
CREATE POLICY run_logins_tenant ON "run_logins"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY run_logins_system ON "run_logins"
  USING (current_setting('app.rls_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "run_logins" TO rakazo_app;

-- Counts the run logins typed on a computer, for checks that read it outside the run.
ALTER TABLE "computers" ADD COLUMN "runLoginsTyped" INTEGER NOT NULL DEFAULT 0;
