ALTER TABLE `payment_history` MODIFY COLUMN `userId` int;--> statement-breakpoint
ALTER TABLE `payment_history` ADD `customerEmail` varchar(255);