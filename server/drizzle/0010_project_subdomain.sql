ALTER TABLE `projects` ADD `subdomain` text;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_subdomain_unique` ON `projects` (`subdomain`);