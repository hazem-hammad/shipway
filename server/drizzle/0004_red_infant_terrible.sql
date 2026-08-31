CREATE TABLE `db_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`engine` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`admin_username` text NOT NULL,
	`admin_password_encrypted` blob NOT NULL,
	`tls` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `db_connections_name_unique` ON `db_connections` (`name`);--> statement-breakpoint
ALTER TABLE `databases` ADD `connection_id` integer REFERENCES db_connections(id);
