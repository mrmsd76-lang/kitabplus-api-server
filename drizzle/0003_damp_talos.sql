CREATE TABLE `payment_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`gateway` varchar(32) NOT NULL,
	`eventType` varchar(64) NOT NULL,
	`chargeId` varchar(128) NOT NULL,
	`orderId` varchar(128),
	`customerEmail` varchar(320),
	`amount` int,
	`currency` varchar(8),
	`plan` varchar(32),
	`userId` int,
	`status` varchar(32) NOT NULL,
	`errorMessage` text,
	`rawPayload` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payment_events_id` PRIMARY KEY(`id`)
);
