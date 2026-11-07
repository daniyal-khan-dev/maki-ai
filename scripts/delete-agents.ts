// Removes Maki's agents (decision maker + teachers) from the Mistral account.
// They are created again automatically the next time the server starts.
// Run: npm run agents:delete
import "dotenv/config";
import { existsSync, unlinkSync } from "fs";
import { deleteAgents } from "../lib/agents";

const removed = await deleteAgents();
const cache = new URL("../.agents.json", import.meta.url);
if (existsSync(cache)) unlinkSync(cache);
console.log(removed ? `Removed ${removed} agents from the Mistral account.` : "No agents to remove.");
