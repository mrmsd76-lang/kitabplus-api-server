CREATE TABLE `referrals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`referrerId` int NOT NULL,
	`referredUserId` int,
	`referralCode` varchar(16) NOT NULL,
	`referredEmail` varchar(320),
	`status` enum('pending','registered','subscribed','rewarded') NOT NULL DEFAULT 'pending',
	`discountApplied` int NOT NULL DEFAULT 0,
	`rewardDays` int NOT NULL DEFAULT 0,
	`rewardAppliedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `referrals_id` PRIMARY KEY(`id`),
	CONSTRAINT `referrals_referralCode_unique` UNIQUE(`referralCode`)
);
