# RPC boundary helpers

`workload-auth.ts` is the single temporary compatibility boundary for Admin Web workload metadata and rotating static secrets. RPC handlers consume the typed `WorkloadContext`; they must not read credential headers.

`errors.ts` maps owner failures to canonical Connect codes without exposing raw causes. Providers inject their generated error-detail descriptor through `createDetails`, keeping generated service contracts in the owning module.

The contract package name carries the major version. Do not add a custom contract-version header.
