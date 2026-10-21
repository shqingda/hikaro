module.exports = ({ config }) => {
  const team = process.env.HIKARO_APPLE_TEAM_ID;
  if (team !== undefined && !/^[A-Z0-9]{10}$/.test(team))
    throw new Error(
      "HIKARO_APPLE_TEAM_ID must be a 10-character Apple team ID",
    );
  return team
    ? { ...config, ios: { ...config.ios, appleTeamId: team } }
    : config;
};
