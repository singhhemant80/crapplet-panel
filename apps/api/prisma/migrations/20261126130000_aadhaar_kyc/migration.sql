ALTER TABLE "ClientProfile" ADD COLUMN IF NOT EXISTS "kycStatus" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "ClientProfile" ADD COLUMN IF NOT EXISTS "kycVerifiedAt" TIMESTAMP(3);
ALTER TABLE "ClientProfile" ADD COLUMN IF NOT EXISTS "kycExempt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ClientProfile" ADD COLUMN IF NOT EXISTS "kycRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "KycVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "referenceId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'cashfree_digilocker',
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "nameOnAadhaar" TEXT,
    "dob" TEXT,
    "gender" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "aadhaarLast4" TEXT,
    "nameScore" INTEGER,
    "message" TEXT,
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "KycVerification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "KycVerification_verificationId_key" ON "KycVerification"("verificationId");
CREATE INDEX IF NOT EXISTS "KycVerification_userId_createdAt_idx" ON "KycVerification"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "KycVerification_status_idx" ON "KycVerification"("status");
DO $$ BEGIN
  ALTER TABLE "KycVerification" ADD CONSTRAINT "KycVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
