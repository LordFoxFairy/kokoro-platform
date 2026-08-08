import { runSitePublicationAuthorityBootstrap, sitePublicationAuthorityBootstrapPath } from
  "../../src/process/site-publication-authority-bootstrap.js";

const count = await runSitePublicationAuthorityBootstrap(
  sitePublicationAuthorityBootstrapPath(process.argv.slice(2)),
);
console.info(`Bootstrapped and sealed ${count} Site publication authority records.`);
