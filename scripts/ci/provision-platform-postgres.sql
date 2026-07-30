CREATE ROLE platform_migrator
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-migrator-ci';
CREATE ROLE platform_api
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-api-ci';
CREATE ROLE platform_admission
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-admission-ci';
CREATE ROLE platform_authorization
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-authorization-ci';
CREATE ROLE platform_asset_data_plane
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-asset-data-plane-ci';
CREATE ROLE platform_commerce_worker
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-commerce-worker-ci';
CREATE ROLE platform_site_worker
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-site-worker-ci';
CREATE ROLE platform_asset_worker
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-asset-worker-ci';
CREATE ROLE platform_admin_worker
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-admin-worker-ci';
CREATE ROLE platform_identity_worker
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-identity-worker-ci';
CREATE ROLE platform_authorization_maintenance
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-authorization-maintenance-ci';
CREATE ROLE platform_admin
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-admin-ci';
CREATE ROLE platform_model_gateway
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD 'platform-model-gateway-ci';

CREATE DATABASE kokoro_test_platform OWNER platform_migrator;
REVOKE ALL ON DATABASE kokoro_test_platform FROM PUBLIC;
GRANT CONNECT ON DATABASE kokoro_test_platform TO
  platform_migrator,
  platform_api,
  platform_admission,
  platform_authorization,
  platform_asset_data_plane,
  platform_commerce_worker,
  platform_site_worker,
  platform_asset_worker,
  platform_admin_worker,
  platform_identity_worker,
  platform_authorization_maintenance,
  platform_admin,
  platform_model_gateway;
