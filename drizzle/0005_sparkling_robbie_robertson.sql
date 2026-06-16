CREATE TABLE `payment_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`gateway` varchar(32) NOT NULL,
	`chargeId` varchar(128),
	`amount` int NOT NULL,
	`currency` varchar(8) NOT NULL DEFAULT 'SAR',
	`plan` varchar(32),
	`status` enum('success','failed','pending','refunded') NOT NULL,
	`cardLast4` varchar(4),
	`cardBrand` varchar(16),
	`referenceId` varchar(128),
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payment_history_id` PRIMARY KEY(`id`)
);
