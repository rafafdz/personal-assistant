ALTER TABLE "reminders" ALTER COLUMN "scheduled_for" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "last_sent" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "updated_at" SET DEFAULT now();