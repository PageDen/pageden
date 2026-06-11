-- CreateTable
CREATE TABLE "DeviceAuthRequest" (
    "id" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "userId" TEXT,
    "tokenId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,

    CONSTRAINT "DeviceAuthRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceAuthRequest_userCode_key" ON "DeviceAuthRequest"("userCode");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceAuthRequest_deviceCodeHash_key" ON "DeviceAuthRequest"("deviceCodeHash");

-- CreateIndex
CREATE INDEX "DeviceAuthRequest_expiresAt_idx" ON "DeviceAuthRequest"("expiresAt");
