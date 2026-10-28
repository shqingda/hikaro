const { withAndroidManifest } = require("expo/config-plugins");
// The app restricts ws:// to private LAN IPv4 addresses and authenticates/encrypts
// traffic with SecureChannel. Internet relay connections continue to require wss://.
module.exports = (config) =>
  withAndroidManifest(config, (config) => {
    config.modResults.manifest.application[0].$[
      "android:usesCleartextTraffic"
    ] = "true";
    return config;
  });
