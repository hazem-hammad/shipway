PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`type` text DEFAULT 'webhook' NOT NULL,
	`target` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_notification_channels`("id", "name", "url", "created_at") SELECT "id", "name", "url", "created_at" FROM `notification_channels`;--> statement-breakpoint
DROP TABLE `notification_channels`;--> statement-breakpoint
ALTER TABLE `__new_notification_channels` RENAME TO `notification_channels`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_channels_name_unique` ON `notification_channels` (`name`);