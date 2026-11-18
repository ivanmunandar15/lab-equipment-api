-- AlterTable
ALTER TABLE "equipment" ALTER COLUMN "equipment_type" DROP NOT NULL;

-- CreateTable
CREATE TABLE "equipment_responsibility" (
    "responsibility_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_prefix" VARCHAR(50),
    "room_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equipment_responsibility_pkey" PRIMARY KEY ("responsibility_id")
);

-- CreateIndex
CREATE INDEX "equipment_responsibility_user_id_idx" ON "equipment_responsibility"("user_id");

-- CreateIndex
CREATE INDEX "equipment_responsibility_room_id_idx" ON "equipment_responsibility"("room_id");

-- AddForeignKey
ALTER TABLE "equipment_responsibility" ADD CONSTRAINT "equipment_responsibility_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_responsibility" ADD CONSTRAINT "equipment_responsibility_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("room_id") ON DELETE CASCADE ON UPDATE CASCADE;
