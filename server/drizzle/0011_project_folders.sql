CREATE TABLE `folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folders_slug_unique` ON `folders` (`slug`);--> statement-breakpoint
-- `ON DELETE SET NULL` hand-added: drizzle-kit emits a bare `REFERENCES folders(id)` for an added
-- column, dropping the action the schema declares. With `foreign_keys=ON` (db/index.ts restores it
-- after migrating) the default NO ACTION would make deleting a non-empty folder fail outright,
-- which is exactly the behaviour `set null` exists to avoid: filing is not deleting.
ALTER TABLE `projects` ADD `folder_id` integer REFERENCES folders(id) ON DELETE SET NULL;