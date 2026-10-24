module.exports = ({ config }) => {
  const team = process.env.HIKARO_APPLE_TEAM_ID;
  const projectId = process.env.HIKARO_EXPO_PROJECT_ID;
  if (
    projectId &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      projectId,
    )
  )
    throw new Error("HIKARO_EXPO_PROJECT_ID must be an Expo project UUID");
  if (projectId)
    config = {
      ...config,
      extra: { ...config.extra, eas: { ...config.extra?.eas, projectId } },
    };
  if (team !== undefined && !/^[A-Z0-9]{10}$/.test(team))
    throw new Error(
      "HIKARO_APPLE_TEAM_ID must be a 10-character Apple team ID",
    );
  return team
    ? { ...config, ios: { ...config.ios, appleTeamId: team } }
    : config;
};
