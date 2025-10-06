CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"message" text NOT NULL,
	"scheduled_for" timestamp NOT NULL,
	"timezone" text DEFAULT 'America/Santiago' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"recurrence" jsonb DEFAULT '{"type":"none"}'::jsonb,
	"last_sent" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;