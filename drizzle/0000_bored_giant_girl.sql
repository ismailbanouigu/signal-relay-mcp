CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` text NOT NULL,
	`round` integer NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'lobby' NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`max_rounds` integer DEFAULT 5 NOT NULL,
	`max_players` integer DEFAULT 4 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `moves` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` text NOT NULL,
	`round` integer NOT NULL,
	`player_id` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`rationale` text NOT NULL,
	`submitted_at` text NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `moves_one_per_round` ON `moves` (`match_id`,`round`,`player_id`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`name` text NOT NULL,
	`motto` text DEFAULT 'Signal first. Explain later.' NOT NULL,
	`color` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`joined_at` text NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_match_name` ON `players` (`match_id`,`name`);