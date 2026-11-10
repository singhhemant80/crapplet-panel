CREATE TABLE "ClientContact" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL DEFAULT '',
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "companyName" TEXT,
  "emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClientContact_userId_idx" ON "ClientContact"("userId");

CREATE TABLE "ClientFile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "storedAs" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "mime" TEXT,
  "adminOnly" BOOLEAN NOT NULL DEFAULT true,
  "uploadedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientFile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClientFile_userId_idx" ON "ClientFile"("userId");

CREATE TABLE "PayMethod" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "gateway" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "brand" TEXT,
  "last4" TEXT,
  "expiry" TEXT,
  "tokenEnc" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "autopay" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "PayMethod_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PayMethod_userId_idx" ON "PayMethod"("userId");

ALTER TABLE "ClientContact" ADD CONSTRAINT "ClientContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientFile" ADD CONSTRAINT "ClientFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayMethod" ADD CONSTRAINT "PayMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
