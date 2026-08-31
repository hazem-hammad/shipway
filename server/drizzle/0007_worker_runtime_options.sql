ALTER TABLE `workers` ADD `auto_start` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `workers` ADD `restart_policy` text DEFAULT 'always' NOT NULL;--> statement-breakpoint
ALTER TABLE `workers` ADD `restart_sec` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `workers` ADD `stop_timeout_sec` integer DEFAULT 90 NOT NULL;