CREATE TABLE `author_photos` (
	`id` int AUTO_INCREMENT NOT NULL,
	`authorKey` varchar(100) NOT NULL,
	`photoUrl` text NOT NULL,
	`uploadedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `author_photos_id` PRIMARY KEY(`id`),
	CONSTRAINT `author_photos_authorKey_unique` UNIQUE(`authorKey`)
);
