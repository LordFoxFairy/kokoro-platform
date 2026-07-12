-- Pure additive: bind a magic-link to the requesting device via an optional nonce
-- hash. NULL keeps existing links (and any nonce-less callers) working unchanged.
-- Hand-written (no `migrate dev` on the shared DB); applied with `migrate deploy`.
ALTER TABLE `magic_links` ADD COLUMN `nonceHash` VARCHAR(191) NULL;
