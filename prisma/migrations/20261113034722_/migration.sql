-- CreateEnum
CREATE TYPE "Role" AS ENUM ('QA', 'admin', 'technician', 'SPV');

-- CreateEnum
CREATE TYPE "EquipmentStatus" AS ENUM ('available', 'borrowed', 'damaged', 'maintenance', 'calibration');

-- CreateEnum
CREATE TYPE "ItemCondition" AS ENUM ('good', 'minor_damage', 'major_damage');

-- CreateEnum
CREATE TYPE "SupportingStatus" AS ENUM ('available', 'borrowed', 'damaged');

-- CreateEnum
CREATE TYPE "BorrowingStatus" AS ENUM ('borrowed', 'returned');

-- CreateEnum
CREATE TYPE "CalibrationResult" AS ENUM ('passed', 'failed');

-- CreateEnum
CREATE TYPE "MaintenanceType" AS ENUM ('routine', 'repair');

-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "SensorType" AS ENUM ('temperature', 'humidity');

-- CreateEnum
CREATE TYPE "SensorStatus" AS ENUM ('active', 'inactive', 'damaged');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('manual', 'certificate', 'procedure', 'photo', 'other');

-- CreateEnum
CREATE TYPE "EmailReminderType" AS ENUM ('calibration_30d', 'calibration_7d', 'calibration_1d', 'calibration_overdue', 'borrowing_overdue', 'digest');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('queued', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('borrowing', 'calibration', 'maintenance', 'monitoring', 'system');

-- CreateTable
CREATE TABLE "users" (
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "email_notifications" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "room_id" UUID NOT NULL,
    "room_code" TEXT NOT NULL,
    "room_name" TEXT NOT NULL,
    "equipment_capacity" INTEGER NOT NULL DEFAULT 0,
    "person_in_charge" UUID,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("room_id")
);

-- CreateTable
CREATE TABLE "equipment" (
    "equipment_id" UUID NOT NULL,
    "inventory_code" TEXT NOT NULL,
    "qr_token" TEXT NOT NULL,
    "equipment_name" TEXT NOT NULL,
    "equipment_type" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "room_id" UUID NOT NULL,
    "status" "EquipmentStatus" NOT NULL DEFAULT 'available',
    "condition" "ItemCondition" DEFAULT 'good',
    "purchase_date" DATE,
    "purchase_price" DECIMAL(15,2),
    "useful_life_years" INTEGER,
    "specifications" TEXT,
    "next_calibration_date" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_pkey" PRIMARY KEY ("equipment_id")
);

-- CreateTable
CREATE TABLE "supporting_equipment" (
    "supporting_equipment_id" UUID NOT NULL,
    "item_code" TEXT NOT NULL,
    "qr_token" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "item_type" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "total_quantity" INTEGER NOT NULL DEFAULT 0,
    "available_quantity" INTEGER NOT NULL DEFAULT 0,
    "condition" "ItemCondition" NOT NULL DEFAULT 'good',
    "status" "SupportingStatus" NOT NULL DEFAULT 'available',
    "description" TEXT,
    "specifications" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supporting_equipment_pkey" PRIMARY KEY ("supporting_equipment_id")
);

-- CreateTable
CREATE TABLE "borrowings" (
    "borrowing_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "borrowing_time" TIMESTAMP(3) NOT NULL,
    "expected_return_time" TIMESTAMP(3) NOT NULL,
    "actual_return_time" TIMESTAMP(3),
    "purpose" TEXT NOT NULL,
    "usage_location" TEXT,
    "borrowing_status" "BorrowingStatus" NOT NULL DEFAULT 'borrowed',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "borrowings_pkey" PRIMARY KEY ("borrowing_id")
);

-- CreateTable
CREATE TABLE "borrowing_details" (
    "detail_id" UUID NOT NULL,
    "borrowing_id" UUID NOT NULL,
    "equipment_id" UUID NOT NULL,
    "initial_condition" TEXT,
    "final_condition" TEXT,
    "has_damage" BOOLEAN NOT NULL DEFAULT false,
    "damage_notes" TEXT,

    CONSTRAINT "borrowing_details_pkey" PRIMARY KEY ("detail_id")
);

-- CreateTable
CREATE TABLE "supporting_borrowing_details" (
    "supporting_detail_id" UUID NOT NULL,
    "borrowing_id" UUID NOT NULL,
    "supporting_equipment_id" UUID NOT NULL,
    "quantity_borrowed" INTEGER NOT NULL,
    "quantity_returned" INTEGER NOT NULL DEFAULT 0,
    "initial_condition" TEXT,
    "final_condition" TEXT,
    "has_damage" BOOLEAN NOT NULL DEFAULT false,
    "damage_notes" TEXT,

    CONSTRAINT "supporting_borrowing_details_pkey" PRIMARY KEY ("supporting_detail_id")
);

-- CreateTable
CREATE TABLE "calibrations" (
    "calibration_id" UUID NOT NULL,
    "equipment_id" UUID NOT NULL,
    "technician_id" UUID NOT NULL,
    "calibration_date" DATE NOT NULL,
    "next_calibration_date" DATE NOT NULL,
    "calibration_provider" TEXT,
    "certificate_number" TEXT,
    "certificate_file_url" TEXT,
    "calibration_result" "CalibrationResult" NOT NULL,
    "cost" DECIMAL(15,2),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calibrations_pkey" PRIMARY KEY ("calibration_id")
);

-- CreateTable
CREATE TABLE "maintenances" (
    "maintenance_id" UUID NOT NULL,
    "equipment_id" UUID NOT NULL,
    "technician_id" UUID NOT NULL,
    "maintenance_type" "MaintenanceType" NOT NULL,
    "maintenance_date" TIMESTAMP(3) NOT NULL,
    "completion_date" TIMESTAMP(3),
    "description" TEXT,
    "cost" DECIMAL(15,2),
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'scheduled',
    "replaced_spare_parts" TEXT,
    "notes" TEXT,
    "prev_equipment_status" "EquipmentStatus",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenances_pkey" PRIMARY KEY ("maintenance_id")
);

-- CreateTable
CREATE TABLE "sensors" (
    "sensor_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "sensor_code" TEXT NOT NULL,
    "sensor_type" "SensorType" NOT NULL,
    "unit" TEXT NOT NULL,
    "sensor_location" TEXT,
    "sensor_status" "SensorStatus" NOT NULL DEFAULT 'active',
    "min_threshold" DECIMAL(8,2) NOT NULL,
    "max_threshold" DECIMAL(8,2) NOT NULL,
    "api_key_hash" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sensors_pkey" PRIMARY KEY ("sensor_id")
);

-- CreateTable
CREATE TABLE "room_monitoring" (
    "monitoring_id" UUID NOT NULL,
    "sensor_id" UUID NOT NULL,
    "value" DECIMAL(8,2) NOT NULL,
    "measurement_time" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_monitoring_pkey" PRIMARY KEY ("monitoring_id")
);

-- CreateTable
CREATE TABLE "documents" (
    "document_id" UUID NOT NULL,
    "equipment_id" UUID NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "document_type" "DocumentType" NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_type" TEXT,
    "file_size" BIGINT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "notification_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "borrowing_id" UUID,
    "calibration_id" UUID,
    "maintenance_id" UUID,
    "notification_type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),
    "dedupe_key" TEXT,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("notification_id")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "email_log_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "equipment_id" UUID,
    "parent_id" UUID,
    "reminder_type" "EmailReminderType" NOT NULL,
    "next_calibration_date" DATE,
    "recipient_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "provider_message_id" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("email_log_id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "log_id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "old_data" JSONB,
    "new_data" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "token_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by" UUID,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("token_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_room_code_key" ON "rooms"("room_code");

-- CreateIndex
CREATE INDEX "rooms_person_in_charge_idx" ON "rooms"("person_in_charge");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_inventory_code_key" ON "equipment"("inventory_code");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_qr_token_key" ON "equipment"("qr_token");

-- CreateIndex
CREATE INDEX "equipment_status_idx" ON "equipment"("status");

-- CreateIndex
CREATE INDEX "equipment_room_id_idx" ON "equipment"("room_id");

-- CreateIndex
CREATE INDEX "equipment_next_calibration_date_idx" ON "equipment"("next_calibration_date");

-- CreateIndex
CREATE UNIQUE INDEX "supporting_equipment_item_code_key" ON "supporting_equipment"("item_code");

-- CreateIndex
CREATE UNIQUE INDEX "supporting_equipment_qr_token_key" ON "supporting_equipment"("qr_token");

-- CreateIndex
CREATE INDEX "supporting_equipment_status_idx" ON "supporting_equipment"("status");

-- CreateIndex
CREATE INDEX "borrowings_borrowing_status_idx" ON "borrowings"("borrowing_status");

-- CreateIndex
CREATE INDEX "borrowings_expected_return_time_idx" ON "borrowings"("expected_return_time");

-- CreateIndex
CREATE INDEX "borrowings_user_id_idx" ON "borrowings"("user_id");

-- CreateIndex
CREATE INDEX "borrowing_details_equipment_id_idx" ON "borrowing_details"("equipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "borrowing_details_borrowing_id_equipment_id_key" ON "borrowing_details"("borrowing_id", "equipment_id");

-- CreateIndex
CREATE INDEX "supporting_borrowing_details_supporting_equipment_id_idx" ON "supporting_borrowing_details"("supporting_equipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "supporting_borrowing_details_borrowing_id_supporting_equipm_key" ON "supporting_borrowing_details"("borrowing_id", "supporting_equipment_id");

-- CreateIndex
CREATE INDEX "calibrations_equipment_id_calibration_date_idx" ON "calibrations"("equipment_id", "calibration_date");

-- CreateIndex
CREATE INDEX "calibrations_technician_id_idx" ON "calibrations"("technician_id");

-- CreateIndex
CREATE INDEX "maintenances_equipment_id_idx" ON "maintenances"("equipment_id");

-- CreateIndex
CREATE INDEX "maintenances_technician_id_idx" ON "maintenances"("technician_id");

-- CreateIndex
CREATE INDEX "maintenances_status_idx" ON "maintenances"("status");

-- CreateIndex
CREATE INDEX "maintenances_maintenance_date_idx" ON "maintenances"("maintenance_date");

-- CreateIndex
CREATE UNIQUE INDEX "sensors_sensor_code_key" ON "sensors"("sensor_code");

-- CreateIndex
CREATE INDEX "sensors_room_id_idx" ON "sensors"("room_id");

-- CreateIndex
CREATE INDEX "room_monitoring_sensor_id_measurement_time_idx" ON "room_monitoring"("sensor_id", "measurement_time");

-- CreateIndex
CREATE INDEX "documents_equipment_id_idx" ON "documents"("equipment_id");

-- CreateIndex
CREATE INDEX "documents_uploaded_by_idx" ON "documents"("uploaded_by");

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_idx" ON "notifications"("user_id", "is_read");

-- CreateIndex
CREATE INDEX "notifications_dedupe_key_idx" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "email_logs_status_idx" ON "email_logs"("status");

-- CreateIndex
CREATE INDEX "email_logs_parent_id_idx" ON "email_logs"("parent_id");

-- CreateIndex
CREATE INDEX "email_logs_user_id_created_at_idx" ON "email_logs"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_logs_user_id_equipment_id_reminder_type_next_calibrat_key" ON "email_logs"("user_id", "equipment_id", "reminder_type", "next_calibration_date");

-- CreateIndex
CREATE INDEX "activity_logs_entity_type_entity_id_idx" ON "activity_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "activity_logs_user_id_idx" ON "activity_logs"("user_id");

-- CreateIndex
CREATE INDEX "activity_logs_action_idx" ON "activity_logs"("action");

-- CreateIndex
CREATE INDEX "activity_logs_created_at_idx" ON "activity_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_person_in_charge_fkey" FOREIGN KEY ("person_in_charge") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("room_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrowings" ADD CONSTRAINT "borrowings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrowing_details" ADD CONSTRAINT "borrowing_details_borrowing_id_fkey" FOREIGN KEY ("borrowing_id") REFERENCES "borrowings"("borrowing_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrowing_details" ADD CONSTRAINT "borrowing_details_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("equipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supporting_borrowing_details" ADD CONSTRAINT "supporting_borrowing_details_borrowing_id_fkey" FOREIGN KEY ("borrowing_id") REFERENCES "borrowings"("borrowing_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supporting_borrowing_details" ADD CONSTRAINT "supporting_borrowing_details_supporting_equipment_id_fkey" FOREIGN KEY ("supporting_equipment_id") REFERENCES "supporting_equipment"("supporting_equipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibrations" ADD CONSTRAINT "calibrations_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("equipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibrations" ADD CONSTRAINT "calibrations_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("equipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("room_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_monitoring" ADD CONSTRAINT "room_monitoring_sensor_id_fkey" FOREIGN KEY ("sensor_id") REFERENCES "sensors"("sensor_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("equipment_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_borrowing_id_fkey" FOREIGN KEY ("borrowing_id") REFERENCES "borrowings"("borrowing_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_calibration_id_fkey" FOREIGN KEY ("calibration_id") REFERENCES "calibrations"("calibration_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_maintenance_id_fkey" FOREIGN KEY ("maintenance_id") REFERENCES "maintenances"("maintenance_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("equipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "email_logs"("email_log_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
