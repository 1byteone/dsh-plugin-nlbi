-- dsh-plugin-nlbi public test fixture
-- MySQL 5.7+ / 8.0+
--
-- This fixture is deterministic and contains no production data or credentials.
-- Expected row counts after import:
--   users: 50, products: 60, orders: 150, order_items: 367

CREATE DATABASE IF NOT EXISTS `dsh_test`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE `dsh_test`;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS `order_items`;
DROP TABLE IF EXISTS `orders`;
DROP TABLE IF EXISTS `products`;
DROP TABLE IF EXISTS `users`;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(64) NOT NULL,
  `email` varchar(128) NOT NULL,
  `status` enum('active','inactive','banned') DEFAULT 'active',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_email` (`email`),
  KEY `idx_users_status` (`status`),
  KEY `idx_users_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `products` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(128) NOT NULL,
  `category` varchar(64) NOT NULL,
  `price` decimal(10,2) NOT NULL,
  `stock` int DEFAULT NULL,
  `status` enum('on','off') DEFAULT 'on',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_products_category` (`category`),
  KEY `idx_products_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `status` enum('pending','paid','shipped','completed','cancelled') DEFAULT NULL,
  `payment_method` varchar(32) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_orders_user_id` (`user_id`),
  KEY `idx_orders_status` (`status`),
  KEY `idx_orders_created_at` (`created_at`),
  CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `order_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `product_id` int NOT NULL,
  `quantity` int NOT NULL,
  `price` decimal(10,2) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order_items_order_id` (`order_id`),
  KEY `idx_order_items_product_id` (`product_id`),
  CONSTRAINT `fk_order_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`),
  CONSTRAINT `fk_order_items_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

DROP PROCEDURE IF EXISTS `seed_dsh_test`$$
CREATE PROCEDURE `seed_dsh_test`()
BEGIN
  DECLARE i INT DEFAULT 1;
  DECLARE v_status VARCHAR(16);
  DECLARE v_category VARCHAR(64);
  DECLARE v_order_status VARCHAR(16);
  DECLARE v_payment VARCHAR(32);

  WHILE i <= 50 DO
    SET v_status = CASE
      WHEN i % 13 = 0 THEN 'banned'
      WHEN i % 7 = 0 THEN 'inactive'
      ELSE 'active'
    END;
    INSERT INTO `users` (`id`, `name`, `email`, `status`, `created_at`, `updated_at`)
    VALUES (
      i,
      CONCAT('测试用户', i),
      CONCAT('test-user-', i, '@example.test'),
      v_status,
      DATE_ADD('2025-01-01 09:00:00', INTERVAL i * 7 DAY),
      '2026-01-01 09:00:00'
    );
    SET i = i + 1;
  END WHILE;

  SET i = 1;
  WHILE i <= 60 DO
    SET v_category = CASE (i % 6)
      WHEN 0 THEN '电子'
      WHEN 1 THEN '母婴'
      WHEN 2 THEN '食品'
      WHEN 3 THEN '图书'
      WHEN 4 THEN '运动户外'
      ELSE '服装'
    END;
    INSERT INTO `products` (`id`, `name`, `category`, `price`, `stock`, `status`, `created_at`)
    VALUES (
      i,
      CONCAT('测试商品', i),
      v_category,
      ROUND(39.99 + ((i * 137) % 3200) + (i % 100) / 100, 2),
      (i * 73) % 500,
      CASE WHEN i % 11 = 0 THEN 'off' ELSE 'on' END,
      '2026-01-01 08:00:00'
    );
    SET i = i + 1;
  END WHILE;

  SET i = 1;
  WHILE i <= 150 DO
    SET v_order_status = CASE (i % 5)
      WHEN 0 THEN 'cancelled'
      WHEN 1 THEN 'pending'
      WHEN 2 THEN 'paid'
      WHEN 3 THEN 'shipped'
      ELSE 'completed'
    END;
    SET v_payment = CASE (i % 3)
      WHEN 0 THEN 'wechat'
      WHEN 1 THEN 'alipay'
      ELSE 'card'
    END;
    INSERT INTO `orders` (`id`, `user_id`, `amount`, `status`, `payment_method`, `created_at`)
    VALUES (
      i,
      ((i * 17) % 50) + 1,
      ROUND(100.00 + ((i * 791) % 490000) / 100, 2),
      v_order_status,
      v_payment,
      DATE_ADD('2026-01-01 10:00:00', INTERVAL ((i * 3) % 90) DAY)
    );
    SET i = i + 1;
  END WHILE;

  SET i = 1;
  WHILE i <= 367 DO
    INSERT INTO `order_items` (`id`, `order_id`, `product_id`, `quantity`, `price`)
    SELECT
      i,
      ((i * 29) % 150) + 1,
      ((i * 11) % 60) + 1,
      (i % 4) + 1,
      p.`price`
    FROM `products` p
    WHERE p.`id` = ((i * 11) % 60) + 1;
    SET i = i + 1;
  END WHILE;
END$$

CALL `seed_dsh_test`()$$
DROP PROCEDURE `seed_dsh_test`$$

DELIMITER ;

ANALYZE TABLE `users`, `products`, `orders`, `order_items`;

-- Import verification. Each result must equal the expected count.
SELECT 'users' AS table_name, COUNT(*) AS row_count FROM `users`
UNION ALL SELECT 'products', COUNT(*) FROM `products`
UNION ALL SELECT 'orders', COUNT(*) FROM `orders`
UNION ALL SELECT 'order_items', COUNT(*) FROM `order_items`;
