ALTER TABLE `projects` ADD `auth_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `auth_user` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `auth_hash` text;
