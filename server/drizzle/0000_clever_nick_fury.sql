CREATE TABLE `cron_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`schedule` text NOT NULL,
	`command` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `databases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`engine` text NOT NULL,
	`name` text NOT NULL,
	`username` text NOT NULL,
	`password_encrypted` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`commit_sha` text,
	`commit_message` text,
	`release_path` text,
	`log_path` text,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`repo` text NOT NULL,
	`branch` text NOT NULL,
	`type` text NOT NULL,
	`php_version` text,
	`node_version` text,
	`public_dir` text,
	`port` integer,
	`install_cmd` text,
	`build_cmd` text,
	`start_cmd` text,
	`pre_deploy_script` text,
	`post_deploy_script` text,
	`shared_paths` text DEFAULT '[]' NOT NULL,
	`health_check_path` text,
	`auto_deploy` integer DEFAULT false NOT NULL,
	`env_encrypted` blob,
	`smtp_mode` text DEFAULT 'mailpit' NOT NULL,
	`smtp_config_encrypted` blob,
	`notify_webhook_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`command` text NOT NULL,
	`processes` integer DEFAULT 1 NOT NULL,
	`status_cached` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
