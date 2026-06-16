CREATE TABLE `app_installs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`deviceId` varchar(128) NOT NULL,
	`appVersion` varchar(32),
	`platform` varchar(16),
	`deviceModel` varchar(64),
	`country` varchar(8),
	`firstOpenAt` timestamp NOT NULL DEFAULT (now()),
	`lastOpenAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`openCount` int NOT NULL DEFAULT 1,
	CONSTRAINT `app_installs_id` PRIMARY KEY(`id`),
	CONSTRAINT `app_installs_deviceId_unique` UNIQUE(`deviceId`)
);
