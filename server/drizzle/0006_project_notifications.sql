CREATE TABLE `project_notification_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`event` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_notification_events_project_event_unique` ON `project_notification_events` (`project_id`,`event`);--> statement-breakpoint
CREATE TABLE `project_notification_recipients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_notification_recipients_project_email_unique` ON `project_notification_recipients` (`project_id`,`email`);--> statement-breakpoint
-- Backfill: give every project that already exists the same default event set a newly created one
-- gets (see DEFAULT_SUBSCRIBED_EVENTS in services/notifybus.ts) -- everything except a successful
-- deploy. Without this, upgrading leaves existing projects with every box unchecked, so an admin who
-- adds recipients and saves would still receive nothing. No recipients are backfilled, so this on
-- its own sends no mail.
INSERT INTO `project_notification_events` (`project_id`, `event`)
SELECT `projects`.`id`, `defaults`.`event`
FROM `projects`
CROSS JOIN (SELECT 'deploy_failed' AS `event` UNION ALL SELECT 'deploy_canceled' UNION ALL SELECT 'deploy_rolled_back') AS `defaults`;