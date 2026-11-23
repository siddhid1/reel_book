import { getDb } from "./client.js";
import { loadConfig } from "../config/settings.js";

const config = loadConfig();
getDb(config.databasePath);
console.log(`Database ready at ${config.databasePath}`);
